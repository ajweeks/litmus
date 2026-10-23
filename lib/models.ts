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
  m("mistral-medium-3-5", "mistral", "both", 1.5, 7.5),
  m("mistral-large-2512", "mistral", "main", 0.5, 1.5),
  m("mistral-small-2603", "mistral", "both", 0.15, 0.6),
  // DeepSeek charges half outside peak hours; these are the peak prices.
  m("deepseek-v4-pro", "deepseek", "both", 1.32, 3.96, 0.044),
  m("deepseek-flash", "deepseek", "both", 0.3, 1.2, 0.006),
  m("glm-5.3", "zai", "both", 1.4, 4.4),
  m("glm-5.3-flash", "zai", "both", 0.15, 0.5),
];

const BY_ID = new Map(MODELS.map((x) => [x.id, x]));

export const getModel = (id: string) => BY_ID.get(id);
export const isMainModel = (id: string) => !!BY_ID.get(id)?.main;
export const isCheckerModel = (id: string) => !!BY_ID.get(id)?.checker;

/** The provider that serves a model id; unknown ids are treated as Claude (the original default). */
export const providerOf = (id: string): Provider => BY_ID.get(id)?.provider ?? "anthropic";

export const priceOf = (id: string) => BY_ID.get(id)?.price ?? { input: 2, output: 10 };
