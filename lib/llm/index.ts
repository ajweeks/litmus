// Routes each call to the provider that serves the model, with the key the browser sent for it.

import Anthropic from "@anthropic-ai/sdk";
import { providerOf } from "../models";
import type { ApiKeys } from "../providers";
import { PROVIDER_IDS, PROVIDERS } from "../providers";
import { ProviderError } from "../sse";
import type { ChatMessage } from "../types";
import { streamAnthropicReply } from "./anthropic";
import { completeCompat, researchCompat, streamCompatReply } from "./compat";
import { completeGemini, researchGemini, streamGeminiReply } from "./gemini";
import { completeMistral, researchMistral, streamMistralReply } from "./mistral";
import { completeOpenAi, researchOpenAi, streamOpenAiReply } from "./openai";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Turn } from "./types";

export type * from "./types";

export class MissingKeyError extends Error {}

/** The keys for one request. Only what the browser sent: the server never uses keys of its own. */
export class Llm {
  private client: Anthropic | null;

  constructor(
    readonly keys: ApiKeys,
    client?: Anthropic,
  ) {
    this.client = client ?? null;
  }

  /** Wrap an existing Anthropic client (the evals pass one with a spy attached). */
  static fromClient(client: Anthropic) {
    return new Llm({ anthropic: client.apiKey ?? "" }, client);
  }

  /** The key for this model's provider; throws if there isn't one. */
  require(model: string): string {
    const provider = providerOf(model);
    const key = this.keys[provider];
    if (!key && !(provider === "anthropic" && this.client))
      throw new MissingKeyError(`No ${PROVIDERS[provider].label} API key. Add one in Settings.`);
    return key ?? "";
  }

  anthropic(): Anthropic {
    this.client ??= new Anthropic({ apiKey: this.require("claude-haiku-5-5"), maxRetries: 3 });
    return this.client;
  }
}

export function llmFromRequest(req: Request): Llm {
  const keys: ApiKeys = {};
  for (const p of PROVIDER_IDS) {
    const key = req.headers.get(`x-key-${p}`)?.trim();
    if (key) keys[p] = key;
  }
  return new Llm(keys);
}

/**
 * Stored messages as a provider-neutral history: fact-check notes go to the model as user turns,
 * and consecutive turns from the same side are merged (several APIs require strict alternation).
 */
export function toTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = turns[turns.length - 1];
    if (last?.role === role) last.content += `\n\n${m.content}`;
    else turns.push({ role, content: m.content });
  }
  return turns;
}

export function streamReply(llm: Llm, a: Omit<ReplyArgs, "key">): Promise<ReplyResult> {
  const provider = providerOf(a.model);
  if (provider === "anthropic") return streamAnthropicReply(llm.anthropic(), a);
  const key = llm.require(a.model);
  if (provider === "openai") return streamOpenAiReply({ ...a, key });
  if (provider === "google") return streamGeminiReply({ ...a, key });
  if (provider === "mistral") return streamMistralReply({ ...a, key });
  if (provider === "openrouter") throw new Error("OpenRouter is only used for triage.");
  return streamCompatReply(provider, { ...a, key });
}

/** One non-Claude completion, optionally as structured JSON. (Claude calls go through the SDK directly.) */
export function complete(llm: Llm, a: Omit<CompleteArgs, "key">): Promise<CompleteResult> {
  const provider = providerOf(a.model);
  const key = llm.require(a.model);
  if (provider === "openai") return completeOpenAi({ ...a, key });
  if (provider === "google") return completeGemini({ ...a, key });
  if (provider === "mistral") return completeMistral({ ...a, key });
  if (provider === "anthropic" || provider === "openrouter") throw new Error(`complete() doesn't serve ${provider}.`);
  return completeCompat(provider, { ...a, key });
}

/** Answer with web search enabled, for the verifier on non-Claude models. */
export function research(llm: Llm, a: Omit<ResearchArgs, "key">): Promise<ResearchResult> {
  const provider = providerOf(a.model);
  const key = llm.require(a.model);
  if (provider === "openai") return researchOpenAi({ ...a, key });
  if (provider === "google") return researchGemini({ ...a, key });
  if (provider === "mistral") return researchMistral({ ...a, key });
  if (provider === "anthropic" || provider === "openrouter") throw new Error(`research() doesn't serve ${provider}.`);
  return researchCompat(provider, { ...a, key });
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again shortly.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "network"}): ${err.message}`;
  if (err instanceof ProviderError || err instanceof Error) return err.message;
  return String(err);
}
