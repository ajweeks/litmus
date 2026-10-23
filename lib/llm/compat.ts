// DeepSeek, Z.ai (GLM) and NVIDIA NIM through their OpenAI-style chat completions APIs (plain fetch).
//
// Z.ai runs web search itself (a built-in `web_search` tool whose results come back beside the
// reply). DeepSeek has no built-in search in chat, but sells Search and Fetch endpoints on the same
// key, so it gets them as ordinary function tools that this module runs between turns.

import { priceOf } from "../models";
import { providerFetch, readSse } from "../sse";
import type { ToolActivity } from "../types";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Usage } from "./types";
import { addUsage, NO_USAGE } from "./types";

export type CompatProvider = "deepseek" | "zai" | "nvidia";

const CHAT_URL: Record<CompatProvider, string> = {
  deepseek: "https://api.deepseek.com/chat/completions",
  zai: "https://api.z.ai/api/paas/v4/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
};
const LABEL: Record<CompatProvider, string> = { deepseek: "DeepSeek", zai: "Z.ai", nvidia: "NVIDIA" };
const SEARCH_USD: Record<CompatProvider, number> = { deepseek: 0.00075, zai: 0.01, nvidia: 0 };
const FETCH_USD = 0.00075; // DeepSeek Fetch, per page
const MAX_ROUNDS = 8;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface CompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface WebResult {
  title?: string;
  link?: string;
  url?: string;
  content?: string;
  snippet?: string;
  summary?: string;
}

function toUsage(model: string, u: CompatUsage | undefined): Usage {
  const p = priceOf(model);
  const input = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  const costUsd = ((input - cached) * p.input + cached * (p.cachedInput ?? p.input * 0.1) + output * p.output) / 1e6;
  return { inputTokens: input, outputTokens: output, searches: 0, costUsd };
}

const post = (provider: CompatProvider, key: string, url: string, body: object) =>
  providerFetch(LABEL[provider], url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------- DeepSeek's search and fetch, as function tools ----------

const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query, at most 128 characters" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Read a web page as Markdown.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
];

interface ToolRun {
  activity: ToolActivity;
  /** What goes back to the model. */
  output: string;
  /** URLs and their verbatim text, for the verifier. */
  pages: { url: string; text: string }[];
  costUsd: number;
}

async function runDeepSeekTool(key: string, call: ToolCall, at: number): Promise<ToolRun> {
  let args: { query?: string; url?: string } = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    // Malformed arguments: report the error back to the model below.
  }
  try {
    if (call.function.name === "web_search") {
      const query = (args.query ?? "").slice(0, 128);
      const res = await post("deepseek", key, "https://api.deepseek.com/v1/tools/search", { query, count: 8 });
      const results = ((await res.json()).results ?? []) as WebResult[];
      return {
        activity: { kind: "search", label: query, results: results.map((r) => ({ title: r.title ?? "", url: r.url ?? "" })), at },
        output: JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? r.summary }))),
        pages: results.flatMap((r) => (r.url ? [{ url: r.url, text: r.snippet ?? "" }] : [])),
        costUsd: SEARCH_USD.deepseek,
      };
    }
    if (call.function.name === "web_fetch" && args.url) {
      const res = await post("deepseek", key, "https://api.deepseek.com/v1/tools/fetch", { url: args.url });
      const page = (await res.json()) as { title?: string; content?: string };
      const text = (page.content ?? "").slice(0, 40_000);
      return {
        activity: { kind: "fetch", label: args.url, at },
        output: `# ${page.title ?? args.url}\n\n${text}`,
        pages: [{ url: args.url, text }],
        costUsd: FETCH_USD,
      };
    }
    throw new Error(`Unknown tool ${call.function.name}`);
  } catch (err) {
    return {
      activity: { kind: call.function.name === "web_fetch" ? "fetch" : "search", label: args.url ?? args.query ?? "", at },
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      pages: [],
      costUsd: 0,
    };
  }
}

// ---------- requests ----------

function requestBody(provider: CompatProvider, model: string, messages: Message[], tools: boolean, effort: "low" | "high") {
  // NIM hosts many model families with different reasoning switches and no search: send neither.
  if (provider === "nvidia") return { model, messages };
  return {
    model,
    messages,
    thinking: { type: "enabled" },
    reasoning_effort: effort,
    ...(tools
      ? provider === "deepseek"
        ? { tools: DEEPSEEK_TOOLS }
        : {
            tools: [
              { type: "web_search", web_search: { enable: true, search_engine: "search-prime", search_result: true, count: 8 } },
            ],
          }
      : {}),
  };
}

/** Z.ai returns search results beside the reply, not as a tool call. */
const zaiSearch = (results: WebResult[], at: number): ToolActivity => ({
  kind: "search",
  label: "web search",
  results: results.slice(0, 8).map((r) => ({ title: r.title ?? "", url: r.link ?? "" })),
  at,
});

export async function streamCompatReply(provider: CompatProvider, a: ReplyArgs): Promise<ReplyResult> {
  const messages: Message[] = [{ role: "system", content: a.system }, ...a.history];
  const activity: ToolActivity[] = [];
  let usage = NO_USAGE;
  let thinkingLength = 0;
  let wroteText = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await post(provider, a.key, CHAT_URL[provider], {
      ...requestBody(provider, a.model, messages, a.tools, "high"),
      stream: true,
      ...(provider !== "zai" ? { stream_options: { include_usage: true } } : {}),
    });
    let content = "";
    let reasoning = "";
    let finish = "";
    const calls: ToolCall[] = [];
    type Chunk = {
      choices?: {
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: CompatUsage | null;
      web_search?: WebResult[];
    };
    for await (const chunk of readSse<Chunk>(res, LABEL[provider])) {
      if (chunk.usage) usage = addUsage(usage, toUsage(a.model, chunk.usage));
      if (chunk.web_search?.length) {
        activity.push(zaiSearch(chunk.web_search, thinkingLength));
        usage = addUsage(usage, { ...NO_USAGE, searches: 1, costUsd: SEARCH_USD[provider] });
        a.onActivity(activity);
      }
      const choice = chunk.choices?.[0];
      const d = choice?.delta;
      if (d?.reasoning_content) {
        reasoning += d.reasoning_content;
        thinkingLength += d.reasoning_content.length;
        a.onThinking(d.reasoning_content);
      }
      if (d?.content) {
        content += d.content;
        wroteText = true;
        a.onText(d.content);
      }
      for (const t of d?.tool_calls ?? []) {
        const c = (calls[t.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (t.id) c.id = t.id;
        if (t.function?.name) c.function.name += t.function.name;
        if (t.function?.arguments) c.function.arguments += t.function.arguments;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    a.onUsage?.(usage);
    if (finish === "sensitive") return { usage, refused: !wroteText };
    if (finish !== "tool_calls" || provider !== "deepseek" || !calls.length) break;

    // Run the searches and fetches, then let the model continue with their results.
    // DeepSeek needs its reasoning sent back within a tool-using turn.
    messages.push({ role: "assistant", content, reasoning_content: reasoning, tool_calls: calls });
    const runs = await Promise.all(calls.map((c) => runDeepSeekTool(a.key, c, thinkingLength)));
    runs.forEach((r, i) => {
      activity.push(r.activity);
      messages.push({ role: "tool", tool_call_id: calls[i].id, content: r.output });
      usage = addUsage(usage, { ...NO_USAGE, searches: r.activity.kind === "search" ? 1 : 0, costUsd: r.costUsd });
    });
    a.onActivity(activity);
  }
  return { usage, refused: false };
}

interface CompletionBody {
  choices?: { message?: Message; finish_reason?: string }[];
  usage?: CompatUsage;
  web_search?: WebResult[];
}

export async function completeCompat(provider: CompatProvider, a: CompleteArgs): Promise<CompleteResult> {
  // Neither offers JSON Schema output, only JSON mode, so the schema goes in the prompt.
  const system = a.schema
    ? `${a.system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(a.schema.schema)}`
    : a.system;
  const res = await post(provider, a.key, CHAT_URL[provider], {
    ...requestBody(provider, a.model, [{ role: "system", content: system }, { role: "user", content: a.user }], false, "low"),
    max_tokens: a.maxTokens,
    ...(a.schema ? { response_format: { type: "json_object" } } : {}),
  });
  const body = (await res.json()) as CompletionBody;
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    usage: toUsage(a.model, body.usage),
    refused: choice?.finish_reason === "sensitive",
  };
}

export async function researchCompat(provider: "deepseek" | "zai", a: ResearchArgs): Promise<ResearchResult> {
  const messages: Message[] = [
    { role: "system", content: a.system },
    { role: "user", content: a.user },
  ];
  const retrievedUrls = new Set<string>();
  const citedText = new Map<string, string[]>();
  const cite = (url: string, text: string) => {
    retrievedUrls.add(url);
    if (text) citedText.set(url, [...(citedText.get(url) ?? []), text]);
  };
  let usage = NO_USAGE;
  let toolCalls = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await post(provider, a.key, CHAT_URL[provider], requestBody(provider, a.model, messages, toolCalls < a.maxSearches, "low"));
    const body = (await res.json()) as CompletionBody;
    usage = addUsage(usage, toUsage(a.model, body.usage));
    if (body.web_search?.length) {
      usage = addUsage(usage, { ...NO_USAGE, searches: 1, costUsd: SEARCH_USD[provider] });
      for (const r of body.web_search) if (r.link) cite(r.link, r.content ?? "");
    }
    const msg = body.choices?.[0]?.message;
    if (!msg?.tool_calls?.length || provider !== "deepseek") return { text: msg?.content ?? "", retrievedUrls, citedText, usage };

    messages.push({ role: "assistant", content: msg.content ?? "", reasoning_content: msg.reasoning_content, tool_calls: msg.tool_calls });
    const runs = await Promise.all(msg.tool_calls.map((c) => runDeepSeekTool(a.key, c, 0)));
    runs.forEach((r, i) => {
      toolCalls++;
      r.pages.forEach((p) => cite(p.url, p.text));
      messages.push({ role: "tool", tool_call_id: msg.tool_calls![i].id, content: r.output });
      usage = addUsage(usage, { ...NO_USAGE, searches: r.activity.kind === "search" ? 1 : 0, costUsd: r.costUsd });
    });
  }
  throw new Error(`${LABEL[provider]} kept searching without answering.`);
}
