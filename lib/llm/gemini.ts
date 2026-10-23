// Google Gemini via generateContent (plain fetch): streamed replies with thought summaries, Google
// Search grounding, URL context and code execution; structured completions; web research.

import { priceOf } from "../models";
import { providerFetch, readSse } from "../sse";
import type { ToolActivity } from "../types";
import type { CompleteArgs, CompleteResult, ReplyArgs, ReplyResult, ResearchArgs, ResearchResult, Usage } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SEARCH_QUERY_USD = 0.014; // per query the model runs, after the monthly free allowance

interface Part {
  text?: string;
  thought?: boolean;
  executableCode?: { code?: string };
}

interface Chunk {
  candidates?: {
    content?: { parts?: Part[] };
    finishReason?: string;
    groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri: string; title?: string } }[] };
    urlContextMetadata?: { urlMetadata?: { retrievedUrl: string; urlRetrievalStatus?: string }[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

function toUsage(model: string, u: Chunk["usageMetadata"], queries: number): Usage {
  const p = priceOf(model);
  const prompt = u?.promptTokenCount ?? 0;
  const cached = u?.cachedContentTokenCount ?? 0;
  const tool = u?.toolUsePromptTokenCount ?? 0;
  const output = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0); // thinking bills as output
  const costUsd =
    ((prompt - cached + tool) * p.input + cached * (p.cachedInput ?? p.input * 0.1) + output * p.output) / 1e6 +
    queries * SEARCH_QUERY_USD;
  return { inputTokens: prompt + tool, outputTokens: output, searches: queries, costUsd };
}

const call = (key: string, model: string, method: string, body: object) =>
  providerFetch("Gemini", `${BASE}/${encodeURIComponent(model)}:${method}`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const system = (text: string) => ({ systemInstruction: { parts: [{ text }] } });

export async function streamGeminiReply(a: ReplyArgs): Promise<ReplyResult> {
  const res = await call(a.key, a.model, "streamGenerateContent?alt=sse", {
    ...system(a.system),
    contents: a.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
    ...(a.tools ? { tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }] } : {}),
    generationConfig: { thinkingConfig: { includeThoughts: true } },
  });

  const activity: ToolActivity[] = [];
  const seenQueries = new Set<string>();
  const seenUrls = new Set<string>();
  let thinkingLength = 0;
  let wroteText = false;
  let blocked = false;
  let usage: Chunk["usageMetadata"];

  for await (const chunk of readSse<Chunk>(res, "Gemini")) {
    if (chunk.promptFeedback?.blockReason) blocked = true;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const cand = chunk.candidates?.[0];
    if (!cand) continue;
    if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") blocked = true;
    let changed = false;
    for (const part of cand.content?.parts ?? []) {
      if (part.executableCode) {
        const code = part.executableCode.code ?? "";
        activity.push({ kind: "code", label: code.split("\n")[0].slice(0, 120) || "code", at: thinkingLength });
        changed = true;
      } else if (part.text && part.thought) {
        thinkingLength += part.text.length;
        a.onThinking(part.text);
      } else if (part.text) {
        wroteText = true;
        a.onText(part.text);
      }
    }
    // Grounding arrives incrementally: new queries and sources since the previous chunk.
    const g = cand.groundingMetadata;
    for (const q of g?.webSearchQueries ?? [])
      if (!seenQueries.has(q)) {
        seenQueries.add(q);
        activity.push({ kind: "search", label: q, results: [], at: thinkingLength });
        changed = true;
      }
    const results = (g?.groundingChunks ?? []).flatMap((c) => (c.web ? [{ url: c.web.uri, title: c.web.title ?? "" }] : []));
    const lastSearch = [...activity].reverse().find((x) => x.kind === "search");
    if (results.length && lastSearch) {
      lastSearch.results = [...(lastSearch.results ?? []), ...results].slice(0, 8);
      changed = true;
    }
    for (const u of cand.urlContextMetadata?.urlMetadata ?? [])
      if (!seenUrls.has(u.retrievedUrl)) {
        seenUrls.add(u.retrievedUrl);
        activity.push({ kind: "fetch", label: u.retrievedUrl, at: thinkingLength });
        changed = true;
      }
    if (changed) a.onActivity(activity);
  }
  const total = toUsage(a.model, usage, seenQueries.size);
  a.onUsage?.(total);
  return { usage: total, refused: blocked && !wroteText };
}

const textOf = (chunk: Chunk) =>
  (chunk.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");

export async function completeGemini(a: CompleteArgs): Promise<CompleteResult> {
  const body = (await (
    await call(a.key, a.model, "generateContent", {
      ...system(a.system),
      contents: [{ role: "user", parts: [{ text: a.user }] }],
      generationConfig: {
        maxOutputTokens: a.maxTokens,
        thinkingConfig: { thinkingLevel: "low" },
        ...(a.schema ? { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: a.schema.schema } } } : {}),
      },
    })
  ).json()) as Chunk;
  return {
    text: textOf(body),
    usage: toUsage(a.model, body.usageMetadata, 0),
    refused: !!body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason === "SAFETY",
  };
}

/**
 * Grounding links are vertexaisearch.cloud.google.com redirects with only the domain as a title.
 * Follow each redirect one hop (without loading the page) to get the real URL.
 */
async function resolveRedirect(uri: string): Promise<string> {
  try {
    if (new URL(uri).hostname !== "vertexaisearch.cloud.google.com") return uri;
    const res = await fetch(uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    return res.headers.get("location") || uri;
  } catch {
    return uri;
  }
}

export async function researchGemini(a: ResearchArgs): Promise<ResearchResult> {
  const body = (await (
    await call(a.key, a.model, "generateContent", {
      ...system(a.system),
      contents: [{ role: "user", parts: [{ text: a.user }] }],
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    })
  ).json()) as Chunk;

  const cand = body.candidates?.[0];
  const g = cand?.groundingMetadata;
  const uris = (g?.groundingChunks ?? []).flatMap((c) => (c.web ? [c.web.uri] : []));
  const resolved = await Promise.all(uris.slice(0, 20).map(resolveRedirect));
  const fetched = (cand?.urlContextMetadata?.urlMetadata ?? [])
    .filter((u) => u.urlRetrievalStatus === "URL_RETRIEVAL_STATUS_SUCCESS")
    .map((u) => u.retrievedUrl);
  return {
    text: textOf(body),
    retrievedUrls: new Set([...resolved, ...fetched]),
    citedText: new Map(),
    usage: toUsage(a.model, body.usageMetadata, g?.webSearchQueries?.length ?? 0),
  };
}
