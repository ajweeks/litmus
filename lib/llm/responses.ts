// The Responses API (plain fetch), as offered by OpenAI, xAI and Alibaba Model Studio: streamed
// replies with reasoning summaries, web search and code; structured completions; web research for
// the verifier. The three differ in a few options, set per provider below.

import { priceOf } from "../models";
import { providerFetch, readSse } from "../sse";
import type { ToolActivity } from "../types";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Usage } from "./types";

export type ResponsesProvider = "openai" | "xai" | "alibaba";

const CONFIG: Record<
  ResponsesProvider,
  {
    label: string;
    url: string;
    /** USD per web search call. */
    searchUsd: number;
    /** Accepts `store`, `max_tool_calls` and `include: ["web_search_call.action.sources"]`. */
    openAiExtras: boolean;
    /** Takes a JSON schema for structured output; otherwise the schema goes in the prompt. */
    schemaFormat: boolean;
    /** The reasoning settings to send, if any (some models reject a summary request). */
    reasoning: (model: string, effort: "low" | "medium") => object | undefined;
  }
> = {
  openai: {
    label: "OpenAI",
    url: "https://api.openai.com/v1/responses",
    searchUsd: 0.01,
    openAiExtras: true,
    schemaFormat: true,
    reasoning: (_, effort) => ({ effort, summary: "auto" }),
  },
  xai: {
    label: "xAI",
    url: "https://api.x.ai/v1/responses",
    searchUsd: 0.005,
    openAiExtras: false,
    schemaFormat: true,
    // Grok always reasons; only grok-4.7 returns a summary.
    reasoning: (model, effort) => (/^grok-4\.7/.test(model) ? { effort, summary: "auto" } : { effort }),
  },
  alibaba: {
    label: "Alibaba Cloud",
    // International (Singapore) endpoint: keys only work in the region that issued them.
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/responses",
    searchUsd: 0.01,
    openAiExtras: false,
    // JSON schemas aren't supported in the Singapore region yet.
    schemaFormat: false,
    // Effort levels vary by Qwen model, so leave each on its default.
    reasoning: () => undefined,
  },
};

interface OpenAiUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface OutputItem {
  type: string;
  id?: string;
  code?: string | null;
  action?: { type: string; query?: string; queries?: string[]; url?: string; sources?: { url: string }[] };
  content?: { type: string; text?: string; refusal?: string; annotations?: { type: string; url?: string; title?: string }[] }[];
}

interface ResponseBody {
  status?: string;
  output?: OutputItem[];
  usage?: OpenAiUsage;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  citations?: string[];
}

function toUsage(provider: ResponsesProvider, model: string, u: OpenAiUsage | undefined, searches: number): Usage {
  const searchUsd = CONFIG[provider].searchUsd;
  if (!u) return { inputTokens: 0, outputTokens: 0, searches, costUsd: searches * searchUsd };
  const p = priceOf(model);
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  const fresh = u.input_tokens - cached - written;
  const costUsd =
    (fresh * p.input + written * p.input * 1.25 + cached * (p.cachedInput ?? p.input * 0.1) + u.output_tokens * p.output) / 1e6 +
    searches * searchUsd;
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, searches, costUsd };
}

const post = (provider: ResponsesProvider, key: string, body: object) =>
  providerFetch(CONFIG[provider].label, CONFIG[provider].url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Options only OpenAI accepts: don't store the response, and return each search's sources. */
const extras = (provider: ResponsesProvider, more: object = {}) =>
  CONFIG[provider].openAiExtras ? { store: false, include: ["web_search_call.action.sources"], ...more } : {};

/** What a tool call item did, as one activity line (query, page or first line of code). */
function describe(item: OutputItem, at: number): ToolActivity | null {
  if (item.type === "code_interpreter_call")
    return { kind: "code", label: (item.code ?? "").split("\n")[0].slice(0, 120) || "code", at };
  if (item.type !== "web_search_call") return null;
  const a = item.action;
  if (a?.type === "open_page" || a?.type === "find_in_page") return { kind: "fetch", label: a.url ?? "web page", at };
  return {
    kind: "search",
    label: a?.queries?.[0] ?? a?.query ?? "web search",
    results: a?.sources?.slice(0, 8).map((s) => ({ title: s.url, url: s.url })),
    at,
  };
}

const isSearch = (item: OutputItem) => item.type === "web_search_call" && (item.action?.type ?? "search") === "search";

export async function streamResponsesReply(provider: ResponsesProvider, a: ReplyArgs): Promise<ReplyResult> {
  const reasoning = CONFIG[provider].reasoning(a.model, "medium");
  const res = await post(provider, a.key, {
    model: a.model,
    instructions: a.system,
    input: a.history.map((t) => ({ role: t.role, content: t.content })),
    stream: true,
    ...(reasoning ? { reasoning } : {}),
    ...(a.tools
      ? {
          tools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }],
          ...extras(provider),
        }
      : {}),
  });

  const activity: ToolActivity[] = [];
  const byItem = new Map<string, number>();
  let thinkingLength = 0;
  let wroteText = false;
  let refused = false;
  let searches = 0;
  let usage: Usage = toUsage(provider, a.model, undefined, 0);

  type Event = {
    type: string;
    delta?: string;
    summary_index?: number;
    item?: OutputItem;
    response?: ResponseBody;
    message?: string;
  };
  for await (const e of readSse<Event>(res, CONFIG[provider].label)) {
    switch (e.type) {
      case "response.reasoning_summary_part.added":
        // Separate summary parts the way the model separates paragraphs.
        if (e.summary_index && thinkingLength) a.onThinking("\n\n");
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        thinkingLength += e.delta?.length ?? 0;
        a.onThinking(e.delta ?? "");
        break;
      case "response.output_text.delta":
        wroteText ||= !!e.delta;
        a.onText(e.delta ?? "");
        break;
      case "response.refusal.delta":
        refused = true;
        break;
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = e.item!;
        const line = describe(item, thinkingLength);
        if (!line || !item.id) break;
        // The query and sources arrive with the finished item; the started one may not have them yet.
        const i = byItem.get(item.id);
        if (i === undefined) {
          byItem.set(item.id, activity.length);
          activity.push(line);
        } else activity[i] = { ...line, at: activity[i].at };
        if (e.type === "response.output_item.done" && isSearch(item)) searches++;
        a.onActivity(activity);
        break;
      }
      case "response.completed":
      case "response.incomplete":
        usage = toUsage(provider, a.model, e.response?.usage, searches);
        break;
      case "response.failed":
        throw new Error(`${CONFIG[provider].label}: ${e.response?.error?.message ?? "the response failed"}`);
      case "error":
        throw new Error(`${CONFIG[provider].label}: ${e.message ?? "stream error"}`);
    }
  }
  a.onUsage?.(usage);
  return { usage, refused: refused && !wroteText };
}

const outputText = (body: ResponseBody) =>
  (body.output ?? [])
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .flatMap((c) => (c.type === "output_text" && c.text ? [c.text] : []))
    .join("");

const refusedIn = (body: ResponseBody) =>
  (body.output ?? []).some((o) => o.content?.some((c) => c.type === "refusal"));

export async function completeResponses(provider: ResponsesProvider, a: CompleteArgs): Promise<CompleteResult> {
  const cfg = CONFIG[provider];
  const reasoning = cfg.reasoning(a.model, "low");
  const schemaInPrompt = a.schema && !cfg.schemaFormat;
  const body = (await (
    await post(provider, a.key, {
      model: a.model,
      instructions: schemaInPrompt
        ? `${a.system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(a.schema!.schema)}`
        : a.system,
      input: a.user,
      max_output_tokens: a.maxTokens,
      ...(reasoning ? { reasoning } : {}),
      ...(cfg.openAiExtras ? { store: false } : {}),
      ...(a.schema && cfg.schemaFormat
        ? { text: { format: { type: "json_schema", name: a.schema.name, schema: a.schema.schema, strict: true } } }
        : {}),
    })
  ).json()) as ResponseBody;
  return { text: outputText(body), usage: toUsage(provider, a.model, body.usage, 0), refused: refusedIn(body) };
}

export async function researchResponses(provider: ResponsesProvider, a: ResearchArgs): Promise<ResearchResult> {
  const reasoning = CONFIG[provider].reasoning(a.model, "low");
  const body = (await (
    await post(provider, a.key, {
      model: a.model,
      instructions: a.system,
      input: a.user,
      ...(reasoning ? { reasoning } : {}),
      tools: [{ type: "web_search" }],
      ...extras(provider, { max_tool_calls: a.maxSearches }),
    })
  ).json()) as ResponseBody;

  // xAI also lists every URL it used in a top-level `citations` array.
  const retrievedUrls = new Set<string>(body.citations ?? []);
  for (const o of body.output ?? []) {
    for (const s of o.action?.sources ?? []) retrievedUrls.add(s.url);
    if (o.action?.url) retrievedUrls.add(o.action.url);
    for (const c of o.content ?? []) for (const ann of c.annotations ?? []) if (ann.url) retrievedUrls.add(ann.url);
  }
  const searches = (body.output ?? []).filter(isSearch).length;
  return {
    text: outputText(body),
    retrievedUrls,
    // The Responses API cites URLs but doesn't quote the page text.
    citedText: new Map(),
    usage: toUsage(provider, a.model, body.usage, searches),
  };
}
