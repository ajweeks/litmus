// Claude via the Anthropic SDK: the main chat stream. (The fact-checker calls Claude directly
// in lib/factcheck.ts, where it uses a tool for the verdict.)

import Anthropic from "@anthropic-ai/sdk";
import { describeToolCall, estimateCost, inputTokens, mainTools } from "../anthropic";
import type { ToolActivity } from "../types";
import type { ReplyArgs, ReplyResult, Usage } from "./types";
import { addUsage, NO_USAGE } from "./types";

export const anthropicUsage = (model: string, u: Anthropic.Messages.Usage | Anthropic.Beta.BetaUsage): Usage => ({
  inputTokens: inputTokens(u as Anthropic.Usage),
  outputTokens: u.output_tokens,
  searches: u.server_tool_use?.web_search_requests ?? 0,
  costUsd: estimateCost(model, u as Anthropic.Usage),
});

export async function streamAnthropicReply(client: Anthropic, a: Omit<ReplyArgs, "key">): Promise<ReplyResult> {
  let messages: Anthropic.Beta.BetaMessageParam[] = a.history;
  let container: string | undefined;
  let usage = NO_USAGE;
  let thinkingLength = 0;
  let wroteText = false;
  const activity: ToolActivity[] = [];

  // Server tools run on Anthropic's side; a long tool turn can pause, so resume it a few times.
  for (let round = 0; round < 6; round++) {
    const reply = client.beta.messages.stream({
      model: a.model,
      max_tokens: 64000,
      // Summarised reasoning, shown collapsed above the answer (the default omits it).
      thinking: { type: "adaptive", display: "summarized" },
      system: a.system,
      messages,
      ...(a.tools ? { tools: mainTools(a.model), ...(container ? { container } : {}) } : {}),
      ...(a.model === "claude-haiku-5-5"
        ? {}
        : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    // Tool calls stream their input as JSON fragments; collect them per content block.
    const calls = new Map<number, { id: string; name: string; json: string; streamed?: boolean }>();
    const byToolUseId = new Map<string, ToolActivity>();
    for await (const event of reply) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use") {
          // The input usually streams as JSON deltas, but can arrive whole on the start block.
          const input = block.input as Record<string, unknown> | undefined;
          const json = input && Object.keys(input).length ? JSON.stringify(input) : "";
          calls.set(event.index, { id: block.id, name: block.name, json });
        } else if (block.type === "web_fetch_tool_result") {
          // The result names the page actually read, which fills in a fetch whose input we didn't see.
          const item = byToolUseId.get(block.tool_use_id);
          const url = (block.content as { url?: string }).url;
          if (item && url) {
            item.label = url;
            a.onActivity(activity);
          }
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          const item = byToolUseId.get(block.tool_use_id);
          if (item) {
            item.results = block.content.map((r) => ({ title: r.title, url: r.url })).slice(0, 8);
            a.onActivity(activity);
          }
        }
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        const call = calls.get(event.index);
        if (call) {
          // Deltas replace a start-block input rather than appending to it.
          call.json = (call.streamed ? call.json : "") + event.delta.partial_json;
          call.streamed = true;
        }
      } else if (event.type === "content_block_stop" && calls.has(event.index)) {
        const call = calls.get(event.index)!;
        const item = describeToolCall(call.name, call.json, thinkingLength);
        activity.push(item);
        byToolUseId.set(call.id, item);
        a.onActivity(activity);
      } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta" && event.delta.thinking) {
        thinkingLength += event.delta.thinking.length;
        a.onThinking(event.delta.thinking);
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        wroteText ||= !!event.delta.text;
        a.onText(event.delta.text);
      }
    }
    const final = await reply.finalMessage();
    usage = addUsage(usage, anthropicUsage(a.model, final.usage));
    a.onUsage?.(usage);
    if (final.stop_reason === "refusal") return { usage, refused: !wroteText };
    if (final.stop_reason !== "pause_turn") break;
    container = final.container?.id ?? container;
    messages = [...messages, { role: "assistant", content: final.content as Anthropic.Beta.BetaContentBlockParam[] }];
  }
  return { usage, refused: false };
}
