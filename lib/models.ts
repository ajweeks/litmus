// The models offered in Settings: which provider serves each, what it can be used for, and list
// prices for the usage estimates. Shared by the browser and the server.

import type { Provider } from "./providers";

export interface ModelInfo {
  id: string;
  provider: Provider;
  /** Offered as the chat model. */
  main: boolean;
  /** Offered as the fact-check model (needs web search). */
  checker: boolean;
  /** USD per million tokens. Estimates for display only: check current pricing before relying on them. */
  price: { input: number; output: number; cachedInput?: number };
}

const m = (
  id: string,
  provider: Provider,
  use: "main" | "checker" | "both",
  input: number,
  output: number,
  cachedInput?: number,
): ModelInfo => ({ id, provider, main: use !== "checker", checker: use !== "main", price: { input, output, cachedInput } });

// Prices as of October 2026.
export const MODELS: ModelInfo[] = [
  m("claude-opus-5-5", "anthropic", "main", 4, 20),
  m("claude-sonnet-5-5", "anthropic", "both", 2, 10),
  m("claude-haiku-5-5", "anthropic", "both", 0.1, 0.5),
  m("gpt-6-astra", "openai", "main", 10, 50, 1),
  m("gpt-6.1-sol", "openai", "both", 2, 10, 0.1),
  m("gpt-6-luna", "openai", "both", 0.1, 0.5, 0.01),
  // Introductory Argon pricing until 30 Nov 2026 (then $4 / $20).
  m("gemini-4-argon", "google", "main", 2, 10),
  m("gemini-3.8-flash", "google", "both", 0.75, 3.75),
  m("gemini-3.5-flash-lite", "google", "both", 0.3, 2.5),
  m("grok-4.7", "xai", "both", 2, 6, 0.5),
  m("grok-4.3", "xai", "both", 1.25, 2.5, 0.2),
  m("mistral-medium-3-5", "mistral", "both", 1.5, 7.5),
  m("mistral-large-2512", "mistral", "main", 0.5, 1.5),
  m("mistral-small-2603", "mistral", "both", 0.15, 0.6),
  // DeepSeek charges half outside peak hours; these are the peak prices.
  m("deepseek-v4-pro", "deepseek", "both", 1.32, 3.96, 0.044),
  m("deepseek-flash", "deepseek", "both", 0.3, 1.2, 0.006),
  // Alibaba Model Studio, international (Singapore) prices.
  m("qwen3.8-max", "alibaba", "main", 2, 6),
  m("qwen3.7-plus", "alibaba", "both", 0.4, 1.6),
  m("qwen3.8-flash", "alibaba", "both", 0.15, 0.47),
  m("glm-5.3", "zai", "both", 1.4, 4.4),
  m("glm-5.3-flash", "zai", "both", 0.15, 0.5),
  // NVIDIA's hosted NIM API runs on free developer credits and has no web search, so chat only.
  m("nvidia/nemotron-3-ultra-550b-a55b", "nvidia", "main", 0, 0),
  m("nvidia/nemotron-3-super-120b-a12b", "nvidia", "main", 0, 0),
  m("moonshotai/kimi-k2.6", "nvidia", "main", 0, 0),
  m("deepseek-ai/deepseek-v4.1-flash", "nvidia", "main", 0, 0),
  m("z-ai/glm-5.3", "nvidia", "main", 0, 0),
];

/**
 * OpenRouter serves hundreds of models, so they aren't listed here: any "openrouter:<vendor/model>"
 * id is accepted, for either role, and OpenRouter reports the real cost of each call.
 */
export const OPENROUTER_PREFIX = "openrouter:";
export const openRouterSlug = (id: string) => id.slice(OPENROUTER_PREFIX.length);
export const isOpenRouterModel = (id: string) => /^openrouter:~?[\w.\-]+\/[\w.\-:]+$/.test(id) && id.length <= 140;

const BY_ID = new Map(MODELS.map((x) => [x.id, x]));

export const getModel = (id: string) => BY_ID.get(id);
export const isMainModel = (id: string) => !!BY_ID.get(id)?.main || isOpenRouterModel(id);
export const isCheckerModel = (id: string) => !!BY_ID.get(id)?.checker || isOpenRouterModel(id);

/** The provider that serves a model id; unknown ids are treated as Claude (the original default). */
export const providerOf = (id: string): Provider =>
  id.startsWith(OPENROUTER_PREFIX) ? "openrouter" : (BY_ID.get(id)?.provider ?? "anthropic");

export const priceOf = (id: string) => BY_ID.get(id)?.price ?? { input: 2, output: 10 };

const BRANDS: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek" };

/** "claude-opus-5-5" → "Opus 5.5", "~typesafe/jev-latest" → "Jev", "openai/gpt-6-luna" → "GPT-6 Luna". */
export function modelLabel(id: string): string {
  const parts = id
    .split("/")
    .pop()!
    .replace(/^~/, "")
    .replace(/^(claude|pplx)-/, "")
    .replace(/-latest$/, "")
    .split("-");
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(p) && prev && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else if (/^\d/.test(p) && prev === "GPT") out[out.length - 1] = `GPT-${p}`;
    else out.push(BRANDS[p] ?? (/^v\d/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  return out.join(" ");
}
