import Anthropic from "@anthropic-ai/sdk";

/**
 * Build a client from the key the browser sent. The key is used for this request only,
 * never stored or logged. Falls back to the server's ANTHROPIC_API_KEY for local dev.
 */
export function clientFromRequest(req: Request): Anthropic {
  const key = req.headers.get("x-anthropic-key")?.trim() || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new MissingKeyError();
  return new Anthropic({ apiKey: key, maxRetries: 3 });
}

export class MissingKeyError extends Error {
  constructor() {
    super("No Anthropic API key. Add one in Settings.");
  }
}

// USD per million tokens. Estimates for display only: check current pricing before relying on them.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const WEB_SEARCH_USD = 0.01; // per search

export function estimateCost(model: string, usage: Anthropic.Usage | undefined): number {
  if (!usage) return 0;
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
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
export function webSearchTool(model: string, maxUses: number) {
  if (/opus|sonnet/.test(model)) return { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: maxUses };
  return { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: maxUses };
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again shortly.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "network"}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
