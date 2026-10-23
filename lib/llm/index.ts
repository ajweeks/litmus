// Routes each call to the provider that serves the model, with the key the browser sent for it.

import Anthropic from "@anthropic-ai/sdk";
import { providerOf } from "../models";
import type { ApiKeys, Provider } from "../providers";
import { PROVIDER_IDS, PROVIDERS } from "../providers";
import { errorDetail, ProviderError, statusMessage } from "../sse";
import type { ChatMessage } from "../types";
import { anthropicUsage, streamAnthropicReply } from "./anthropic";
import { completeCompat, researchCompat, streamCompatReply } from "./compat";
import { completeGemini, researchGemini, streamGeminiReply } from "./gemini";
import { completeMistral, researchMistral, streamMistralReply } from "./mistral";
import { completeOpenRouter, researchOpenRouter, streamOpenRouterReply } from "./openrouter";
import { completeResponses, researchResponses, streamResponsesReply } from "./responses";
import type { CompleteArgs, CompleteResult, KeyStatus, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Turn } from "./types";

export type * from "./types";

export class MissingKeyError extends Error {}

/** Statuses that mean the key itself didn't work: rejected, no permission, or no credit. */
const KEY_STATUSES = [401, 402, 403];
/** Gemini answers a bad key with a 400 rather than a 401. */
const isKeyError = (status: number, message: string) =>
  KEY_STATUSES.includes(status) || (status === 400 && /api key/i.test(message));


/** The keys for one request. Only what the browser sent: the server never uses keys of its own. */
export class Llm {
  private client: Anthropic | null;
  private status = new Map<Provider, KeyStatus>();
  /** Called whenever a key's status changes during this request (the chat stream forwards it). */
  onKeyStatus?: (s: KeyStatus) => void;

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
    // Every Claude call goes through this fetch, so the key's status is seen however it's used.
    this.client ??= new Anthropic({
      apiKey: this.require("claude-haiku-5-5"),
      maxRetries: 3,
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        if (res.ok) this.note("anthropic", null);
        else if (isKeyError(res.status, ""))
          this.note("anthropic", { status: res.status, message: errorDetail(await res.clone().text()) });
        return res;
      },
    });
    return this.client;
  }

  /** Record how a call with this provider's key went: `null` for success, or the HTTP failure. */
  note(provider: Provider, failure: { status: number; message: string } | null) {
    if (failure && !isKeyError(failure.status, failure.message)) return; // Not the key's fault.
    const next: KeyStatus = failure ? { provider, ok: false, message: failure.message } : { provider, ok: true };
    const prev = this.status.get(provider);
    if (prev && prev.ok === next.ok && prev.message === next.message) return;
    this.status.set(provider, next);
    this.onKeyStatus?.(next);
  }

  /** Every key status seen in this request. */
  statuses(): KeyStatus[] {
    return [...this.status.values()];
  }

  /** Run a call with `provider`'s key and record whether the key worked. */
  async track<T>(provider: Provider, call: () => Promise<T>): Promise<T> {
    try {
      const out = await call();
      if (provider !== "anthropic") this.note(provider, null);
      return out;
    } catch (err) {
      if (err instanceof ProviderError) this.note(provider, { status: err.status, message: err.message });
      throw err;
    }
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

function streamReplyUntracked(llm: Llm, a: Omit<ReplyArgs, "key">): Promise<ReplyResult> {
  const provider = providerOf(a.model);
  if (provider === "anthropic") return streamAnthropicReply(llm.anthropic(), a);
  const args = { ...a, key: llm.require(a.model) };
  switch (provider) {
    case "openai":
    case "xai":
    case "alibaba":
      return streamResponsesReply(provider, args);
    case "google":
      return streamGeminiReply(args);
    case "mistral":
      return streamMistralReply(args);
    case "openrouter":
      return streamOpenRouterReply(args);
    case "deepseek":
    case "zai":
    case "nvidia":
      return streamCompatReply(provider, args);
    case "typesafe":
      throw new Error("TypeSafe models only answer triage questions.");
  }
}

/** One non-Claude completion, optionally as structured JSON. (Claude calls go through the SDK directly.) */
function completeUntracked(llm: Llm, a: Omit<CompleteArgs, "key">): Promise<CompleteResult> {
  const provider = providerOf(a.model);
  const args = { ...a, key: llm.require(a.model) };
  switch (provider) {
    case "openai":
    case "xai":
    case "alibaba":
      return completeResponses(provider, args);
    case "google":
      return completeGemini(args);
    case "mistral":
      return completeMistral(args);
    case "openrouter":
      return completeOpenRouter(args);
    case "deepseek":
    case "zai":
    case "nvidia":
      return completeCompat(provider, args);
    default:
      throw new Error(`complete() doesn't serve ${provider}.`);
  }
}

// The calls the app makes, each recording whether the provider accepted the key.
export const streamReply = (llm: Llm, a: Omit<ReplyArgs, "key">) =>
  llm.track(providerOf(a.model), () => streamReplyUntracked(llm, a));
export const complete = (llm: Llm, a: Omit<CompleteArgs, "key">) =>
  llm.track(providerOf(a.model), () => completeUntracked(llm, a));
export const research = (llm: Llm, a: Omit<ResearchArgs, "key">) =>
  llm.track(providerOf(a.model), () => researchUntracked(llm, a));

/** Plain text from any provider, Claude included: short, low-effort jobs like the summary line or a title. */
export async function generateText(llm: Llm, a: Omit<CompleteArgs, "key" | "schema">): Promise<CompleteResult> {
  if (providerOf(a.model) !== "anthropic") return complete(llm, a);
  const res = await llm.anthropic().messages.create({
    model: a.model,
    max_tokens: a.maxTokens,
    output_config: { effort: "low" },
    system: a.system,
    messages: [{ role: "user", content: a.user }],
  });
  return {
    text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" "),
    usage: anthropicUsage(a.model, res.usage),
    refused: res.stop_reason === "refusal",
  };
}

/** Answer with web search enabled, for the verifier on non-Claude models. */
function researchUntracked(llm: Llm, a: Omit<ResearchArgs, "key">): Promise<ResearchResult> {
  const provider = providerOf(a.model);
  const args = { ...a, key: llm.require(a.model) };
  switch (provider) {
    case "openai":
    case "xai":
    case "alibaba":
      return researchResponses(provider, args);
    case "google":
      return researchGemini(args);
    case "mistral":
      return researchMistral(args);
    case "openrouter":
      return researchOpenRouter(args);
    case "deepseek":
    case "zai":
      return researchCompat(provider, args);
    default:
      throw new Error(`${provider} has no web search, so it can't check claims.`);
  }
}

/** A message for the user, in the same terms whichever provider failed. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Anthropic timed out. Try again.";
  if (err instanceof Anthropic.APIConnectionError)
    return "Couldn't reach Anthropic. Check your connection, or try again shortly.";
  if (err instanceof Anthropic.APIError)
    return statusMessage("Anthropic", err.status ?? 0, err.error ? JSON.stringify(err.error) : err.message);
  if (err instanceof ProviderError || err instanceof MissingKeyError) return err.message;
  if (err instanceof Error) return err.name === "AbortError" ? "The request was cancelled." : err.message;
  return String(err);
}
