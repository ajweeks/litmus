// OpenRouter (plain fetch): any model it lists, through its OpenAI-style chat completions, with
// its own web search server tool. Model ids in this app are "openrouter:<vendor/model>".

import { openRouterSlug } from "../models";
import { providerFetch, readSse } from "../sse";
import type { ToolActivity } from "../types";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Usage } from "./types";

const URL = "https://openrouter.ai/api/v1/chat/completions";


interface OrUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** What OpenRouter actually charged, in USD. */
  cost?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface Annotation {
  type: string;
  url_citation?: { url: string; title?: string; content?: string };
}

const toUsage = (u: OrUsage | undefined): Usage => ({
  inputTokens: u?.prompt_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
  searches: u?.server_tool_use?.web_search_requests ?? 0,
  costUsd: u?.cost ?? 0,
});

const post = (key: string, body: object) =>
  providerFetch("OpenRouter", URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "litmus",
    },
    body: JSON.stringify(body),
  });

const webSearch = (maxUses: number) => ({
  type: "openrouter:web_search",
  parameters: { engine: "auto", max_results: 5, max_uses: maxUses },
});

/** Reasoning text from a delta or message: the structured entries, else the plain string. */
function reasoningOf(d: { reasoning?: string | null; reasoning_details?: { type: string; text?: string; summary?: string }[] }) {
  if (d.reasoning_details?.length)
    return d.reasoning_details.map((r) => (r.type === "reasoning.encrypted" ? "" : (r.text ?? r.summary ?? ""))).join("");
  return d.reasoning ?? "";
}

export async function streamOpenRouterReply(a: ReplyArgs): Promise<ReplyResult> {
  const res = await post(a.key, {
    model: openRouterSlug(a.model),
    messages: [{ role: "system", content: a.system }, ...a.history],
    stream: true,
    reasoning: { effort: "medium" },
    ...(a.tools ? { tools: [webSearch(8)] } : {}),
  });

  const activity: ToolActivity[] = [];
  const seen = new Set<string>();
  let thinkingLength = 0;
  let wroteText = false;
  let usage = toUsage(undefined);
  type Chunk = {
    choices?: {
      delta?: { content?: string | null; reasoning?: string | null; reasoning_details?: []; annotations?: Annotation[] };
      finish_reason?: string | null;
    }[];
    usage?: OrUsage;
    error?: { message?: string };
  };
  for await (const chunk of readSse<Chunk>(res, "OpenRouter")) {
    if (chunk.error) throw new Error(`OpenRouter: ${chunk.error.message ?? "the response failed"}`);
    if (chunk.usage) usage = toUsage(chunk.usage);
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;
    const thought = reasoningOf(d);
    if (thought) {
      thinkingLength += thought.length;
      a.onThinking(thought);
    }
    if (d.content) {
      wroteText = true;
      a.onText(d.content);
    }
    // OpenRouter doesn't stream the search calls themselves, only the citations they produced.
    const cites = (d.annotations ?? []).flatMap((x) => (x.url_citation && !seen.has(x.url_citation.url) ? [x.url_citation] : []));
    if (cites.length) {
      cites.forEach((c) => seen.add(c.url));
      let search = activity[activity.length - 1];
      if (!search) activity.push((search = { kind: "search", label: "web search", results: [], at: thinkingLength }));
      search.results = [...(search.results ?? []), ...cites.map((c) => ({ title: c.title ?? "", url: c.url }))].slice(0, 8);
      a.onActivity(activity);
    }
  }
  a.onUsage?.(usage);
  return { usage, refused: !wroteText && usage.outputTokens === 0 };
}

interface CompletionBody {
  choices?: { message?: { content?: string | null; annotations?: Annotation[] }; finish_reason?: string }[];
  usage?: OrUsage;
}

export async function completeOpenRouter(a: CompleteArgs): Promise<CompleteResult> {
  const res = await post(a.key, {
    model: openRouterSlug(a.model),
    messages: [
      { role: "system", content: a.system },
      { role: "user", content: a.user },
    ],
    max_tokens: a.maxTokens,
    reasoning: { effort: "low" },
    ...(a.schema
      ? {
          response_format: { type: "json_schema", json_schema: { name: a.schema.name, strict: true, schema: a.schema.schema } },
          // Only route to providers of this model that honour the schema.
          provider: { require_parameters: true },
        }
      : {}),
  });
  const body = (await res.json()) as CompletionBody;
  return { text: body.choices?.[0]?.message?.content ?? "", usage: toUsage(body.usage), refused: false };
}

export async function researchOpenRouter(a: ResearchArgs): Promise<ResearchResult> {
  const res = await post(a.key, {
    model: openRouterSlug(a.model),
    messages: [
      { role: "system", content: a.system },
      { role: "user", content: a.user },
    ],
    reasoning: { effort: "low" },
    tools: [webSearch(a.maxSearches)],
  });
  const body = (await res.json()) as CompletionBody;
  const msg = body.choices?.[0]?.message;
  const retrievedUrls = new Set<string>();
  const citedText = new Map<string, string[]>();
  for (const x of msg?.annotations ?? []) {
    if (!x.url_citation) continue;
    retrievedUrls.add(x.url_citation.url);
    if (x.url_citation.content) citedText.set(x.url_citation.url, [x.url_citation.content]);
  }
  return { text: msg?.content ?? "", retrievedUrls, citedText, usage: toUsage(body.usage) };
}
