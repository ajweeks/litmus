// The provider-neutral surface the chat route and the fact-checker call. Each provider module
// implements the parts its API supports.

import type { Provider } from "../providers";
import type { ToolActivity } from "../types";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Web searches the provider billed for. */
  searches: number;
  costUsd: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  searches: a.searches + b.searches,
  costUsd: a.costUsd + b.costUsd,
});

export interface ReplyArgs {
  key: string;
  model: string;
  system: string;
  history: Turn[];
  /** Let the model search the web, read pages and run code where the provider offers it. */
  tools: boolean;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  /** The full list so far, each time a call starts or its results arrive. */
  onActivity: (items: ToolActivity[]) => void;
  /** Running total, reported after each billed round so a crash still records the spend. */
  onUsage?: (u: Usage) => void;
}

export interface ReplyResult {
  usage: Usage;
  refused: boolean;
  /** The model that actually answered, if the provider says and it differs (e.g. a fallback). */
  model?: string;
}

export interface CompleteArgs {
  key: string;
  model: string;
  system: string;
  user: string;
  /** JSON Schema for structured output; the reply text is then that JSON. */
  schema?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  refused: boolean;
}

export interface ResearchArgs {
  key: string;
  model: string;
  system: string;
  user: string;
  maxSearches: number;
}

export interface ResearchResult {
  /** The model's final text, which should end with the JSON verdict. */
  text: string;
  /** Every URL the web search returned (so sources can be marked as really retrieved). */
  retrievedUrls: Set<string>;
  /** Verbatim page text the provider attached to citations, by URL, where it gives any. */
  citedText: Map<string, string[]>;
  usage: Usage;
}

/** Whether a provider's key worked on its latest call, and why not if it didn't. */
export interface KeyStatus {
  provider: Provider;
  ok: boolean;
  message?: string;
}
