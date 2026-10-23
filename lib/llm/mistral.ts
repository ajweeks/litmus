// Mistral (plain fetch). Web search and code only exist in the Conversations API, so replies and
// research go through it; structured completions use chat completions with a JSON schema.

import { priceOf } from "../models";
import { ensureOk, readSse } from "../sse";
import type { ToolActivity } from "../types";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Usage } from "./types";

const API = "https://api.mistral.ai/v1";
// Mistral prices tool calls separately but doesn't publish the web search rate; this is an estimate.
const SEARCH_USD = 0.01;
/** Models that accept reasoning_effort (Large 3 doesn't reason). */
const REASONS = (model: string) => !/^mistral-large-2512/.test(model);

type ContentChunk =
  | string
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: { type: string; text?: string }[] }
  | { type: "tool_reference"; title?: string; url?: string | null; description?: string | null };

interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  connectors?: Record<string, number>;
}

function toUsage(model: string, u: MistralUsage | undefined): Usage {
  const p = priceOf(model);
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  const searches = (u?.connectors?.web_search ?? 0) + (u?.connectors?.web_search_premium ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    searches,
    costUsd: (input * p.input + output * p.output) / 1e6 + searches * SEARCH_USD,
  };
}

const post = (key: string, path: string, body: object) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => ensureOk(res, "Mistral"));

/** Content arrives as a plain string, one chunk, or a list of chunks. */
const chunksOf = (c: ContentChunk | ContentChunk[] | null | undefined): ContentChunk[] =>
  c == null ? [] : Array.isArray(c) ? c : [c];

function describeCall(name: string, args: string, at: number): ToolActivity {
  let input: { query?: string; code?: string } = {};
  try {
    input = JSON.parse(args || "{}");
  } catch {
    // Arguments may still be streaming.
  }
  if (name.startsWith("web_search")) return { kind: "search", label: input.query ?? "web search", results: [], at };
  return { kind: "code", label: (input.code ?? name).split("\n")[0].slice(0, 120), at };
}

export async function streamMistralReply(a: ReplyArgs): Promise<ReplyResult> {
  const res = await post(a.key, "/conversations", {
    model: a.model,
    instructions: a.system,
    inputs: a.history.map((t) => ({ role: t.role, content: t.content })),
    tools: a.tools ? [{ type: "web_search" }, { type: "code_interpreter" }] : [],
    completion_args: REASONS(a.model) ? { reasoning_effort: "high" } : {},
    stream: true,
    store: false,
  });

  const activity: ToolActivity[] = [];
  const byCall = new Map<string, ToolActivity>();
  let thinkingLength = 0;
  let usage: Usage = toUsage(a.model, undefined);

  type Event = {
    type: string;
    id?: string;
    name?: string;
    arguments?: string;
    content?: ContentChunk | ContentChunk[];
    usage?: MistralUsage;
    message?: string;
  };
  for await (const e of readSse<Event>(res)) {
    if (e.type === "tool.execution.started" || e.type === "tool.execution.delta") {
      const line = describeCall(e.name ?? "", e.arguments ?? "", thinkingLength);
      const known = e.id ? byCall.get(e.id) : undefined;
      if (known) Object.assign(known, { label: line.label });
      else {
        activity.push(line);
        if (e.id) byCall.set(e.id, line);
      }
      a.onActivity(activity);
    } else if (e.type === "message.output.delta") {
      for (const c of chunksOf(e.content)) {
        if (typeof c === "string") a.onText(c);
        else if (c.type === "text") a.onText(c.text);
        else if (c.type === "thinking") {
          const t = (c.thinking ?? []).map((x) => x.text ?? "").join("");
          thinkingLength += t.length;
          if (t) a.onThinking(t);
        } else if (c.type === "tool_reference" && c.url) {
          // Sources the answer draws on; attach them to the latest search.
          const search = [...activity].reverse().find((x) => x.kind === "search");
          if (search && !search.results?.some((r) => r.url === c.url)) {
            search.results = [...(search.results ?? []), { title: c.title ?? "", url: c.url }].slice(0, 8);
            a.onActivity(activity);
          }
        }
      }
    } else if (e.type === "conversation.response.done") {
      usage = toUsage(a.model, e.usage);
    } else if (e.type === "conversation.response.error") {
      throw new Error(`Mistral: ${e.message ?? "the response failed"}`);
    }
  }
  a.onUsage?.(usage);
  return { usage, refused: false };
}

export async function completeMistral(a: CompleteArgs): Promise<CompleteResult> {
  const res = await post(a.key, "/chat/completions", {
    model: a.model,
    max_tokens: a.maxTokens,
    messages: [
      { role: "system", content: a.system },
      { role: "user", content: a.user },
    ],
    ...(a.schema
      ? { response_format: { type: "json_schema", json_schema: { name: a.schema.name, schema: a.schema.schema, strict: true } } }
      : {}),
  });
  const body = (await res.json()) as {
    choices?: { message?: { content?: ContentChunk | ContentChunk[] } }[];
    usage?: MistralUsage;
  };
  const text = chunksOf(body.choices?.[0]?.message?.content)
    .map((c) => (typeof c === "string" ? c : c.type === "text" ? c.text : ""))
    .join("");
  return { text, usage: toUsage(a.model, body.usage), refused: false };
}

export async function researchMistral(a: ResearchArgs): Promise<ResearchResult> {
  const res = await post(a.key, "/conversations", {
    model: a.model,
    instructions: a.system,
    inputs: a.user,
    tools: [{ type: "web_search" }],
    completion_args: REASONS(a.model) ? { reasoning_effort: "low" } : {},
    store: false,
  });
  const body = (await res.json()) as {
    outputs?: { type: string; content?: ContentChunk | ContentChunk[] }[];
    usage?: MistralUsage;
  };
  const retrievedUrls = new Set<string>();
  const citedText = new Map<string, string[]>();
  let text = "";
  for (const o of body.outputs ?? []) {
    if (o.type !== "message.output") continue;
    for (const c of chunksOf(o.content)) {
      if (typeof c === "string") text += c;
      else if (c.type === "text") text += c.text;
      else if (c.type === "tool_reference" && c.url) {
        retrievedUrls.add(c.url);
        if (c.description) citedText.set(c.url, [c.description]);
      }
    }
  }
  return { text, retrievedUrls, citedText, usage: toUsage(a.model, body.usage) };
}
