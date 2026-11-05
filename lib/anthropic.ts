import Anthropic from "@anthropic-ai/sdk";
import { priceOf } from "./models";
import type { ToolActivity } from "./types";

const WEB_SEARCH_USD = 0.01; // per search

export function estimateCost(model: string, usage: Anthropic.Usage | undefined): number {
  if (!usage) return 0;
  const p = priceOf(model);
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (input * p.input + usage.output_tokens * p.output) / 1e6 + searches * WEB_SEARCH_USD;
}

/** Total input tokens, including cached ones. */
export const inputTokens = (u: Anthropic.Usage) =>
  u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/**
 * The dynamic-filtering web search tool is available on Opus and Sonnet; other models get
 * the basic version.
 */
export function webSearchTool(model: string, maxUses: number, allowedDomains?: string[]) {
  const domains = allowedDomains?.length ? { allowed_domains: allowedDomains } : {};
  if (/opus|sonnet/.test(model)) return { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: maxUses, ...domains };
  return { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: maxUses, ...domains };
}

/** Tools for the main chat model: web search, web fetch and code execution, all run by Anthropic. */
export function mainTools(model: string) {
  const dynamic = /opus|sonnet/.test(model);
  return [
    webSearchTool(model, 8),
    dynamic
      ? { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 8 }
      : { type: "web_fetch_20250910" as const, name: "web_fetch" as const, max_uses: 8 },
    { type: "code_execution_20260120" as const, name: "code_execution" as const },
  ];
}

/** One line describing a server tool call, from its streamed JSON input. */
export function describeToolCall(name: string, json: string, at: number): ToolActivity {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(json || "{}");
  } catch {
    // Partial or invalid input: fall back to the tool name.
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "web_search") return { kind: "search", label: str(input.query) || "web search", at };
  if (name === "web_fetch") return { kind: "fetch", label: str(input.url) || "web page", at };
  const code = str(input.command) || str(input.code) || str(input.path) || name;
  return { kind: "code", label: code.split("\n")[0].slice(0, 120), at };
}
