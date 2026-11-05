// The fact-checking pipeline: extract claims from a passage, optionally triage them with a cheap
// model, then verify the rest with web search.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as db from "./db";
import { estimateCost, inputTokens, webSearchTool } from "./anthropic";
import { LIMITS, sharedVerdicts } from "./config";
import { isHttpUrl } from "./links";
import { complete, describeError, generateText, Llm, research } from "./llm";
import { providerOf } from "./models";
import {
  extractorSystem,
  extractorUser,
  SUMMARY_SYSTEM,
  summaryUser,
  TITLE_SYSTEM,
  VERDICT_RECORD_SYSTEM,
  verdictRecordUser,
  verifierSystem,
  verifierUser,
} from "./prompts";
import { verbatimQuote } from "./sources";
import { locate } from "./text";
import { triageClaim, triageProvider } from "./triage";
import type { Claim, Importance, Strictness } from "./types";
import { isNotableProblem, isReusable, VOLATILITY_TTL_MS } from "./types";

/** Calls take an Llm; the evals pass a bare Anthropic client instead. */
type WithLlm = { llm?: Llm; client?: Anthropic };
const llmOf = (a: WithLlm) => a.llm ?? Llm.fromClient(a.client!);

/** The JSON text a model returned, without the code fence some wrap it in. */
const parseJson = (text: string): unknown => JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));

// ---------- extraction ----------

const ExtractionSchema = z.object({
  claims: z.array(
    z.object({
      quote: z.string(),
      claim: z.string(),
      category: z.enum(["empirical", "interpretive", "framing"]),
      duplicate_of: z.string().nullable(),
      related_ids: z.array(z.string()),
    }),
  ),
});

// ExtractionSchema as plain JSON Schema, for providers called without the SDK's zod helper.
const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          claim: { type: "string" },
          category: { type: "string", enum: ["empirical", "interpretive", "framing"] },
          duplicate_of: { anyOf: [{ type: "string" }, { type: "null" }] },
          related_ids: { type: "array", items: { type: "string" } },
        },
        required: ["quote", "claim", "category", "duplicate_of", "related_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

export interface ExtractArgs extends WithLlm {
  model: string;
  strictness: Strictness;
  chatId: string;
  messageId: string;
  userQuestion: string;
  replySoFar: string;
  passage: string;
  /** Offset of `passage` within the full message text. */
  passageOffset: number;
  /** Quotes already extracted from this message (when retrying): claims for them are skipped. */
  skipQuotes?: Set<string>;
}

/** A quote reduced to its words, for spotting the same span extracted twice. */
export const quoteKey = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

export async function extractClaims(a: ExtractArgs): Promise<Claim[]> {
  const chatClaims = db.listClaims({ chatId: a.chatId }).map((c) => ({ id: c.id, claim: c.claim }));
  const known = dedupeById([...chatClaims, ...db.recentVerifiedClaims(40)]);
  const knownIds = new Set(known.map((k) => k.id));

  const system = extractorSystem(a.strictness);
  const user = extractorUser({ userQuestion: a.userQuestion, replySoFar: a.replySoFar, passage: a.passage, known });
  let items: z.infer<typeof ExtractionSchema>["claims"];
  let usage: { input: number; output: number; cost: number };
  if (providerOf(a.model) === "anthropic") {
    const res = await llmOf(a).anthropic().messages.parse({
      model: a.model,
      max_tokens: 8000,
      output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") return [];
    items = res.parsed_output?.claims ?? [];
    usage = { input: inputTokens(res.usage), output: res.usage.output_tokens, cost: estimateCost(a.model, res.usage) };
  } else {
    const res = await complete(llmOf(a), {
      model: a.model,
      system,
      user,
      schema: { name: "claims", schema: EXTRACTION_JSON_SCHEMA },
      maxTokens: 8000,
    });
    if (res.refused) return [];
    items = ExtractionSchema.parse(parseJson(res.text)).claims;
    usage = { input: res.usage.inputTokens, output: res.usage.outputTokens, cost: res.usage.costUsd };
  }

  const claims: Claim[] = [];
  const seenQuotes = new Set<string>();
  for (const raw of items.slice(0, LIMITS.claimsPerPassage)) {
    const item = { ...raw, quote: raw.quote.trim().slice(0, LIMITS.quoteChars), claim: raw.claim.trim().slice(0, LIMITS.claimChars) };
    const key = quoteKey(item.quote);
    if (!item.quote || !item.claim || a.skipQuotes?.has(key) || seenQuotes.has(key)) continue;
    seenQuotes.add(key);
    const at = locate(a.passage, item.quote);
    const duplicateOf = item.duplicate_of && knownIds.has(item.duplicate_of) ? item.duplicate_of : null;
    const claim = db.insertClaim({
      chatId: a.chatId,
      messageId: a.messageId,
      quote: item.quote,
      startOffset: at ? a.passageOffset + at[0] : -1,
      endOffset: at ? a.passageOffset + at[1] : -1,
      claim: item.claim,
      category: item.category,
      strictness: a.strictness,
      extractorModel: a.model,
      duplicateOf,
    });
    for (const rel of item.related_ids.slice(0, LIMITS.relatedIds)) if (knownIds.has(rel)) db.linkClaims(claim.id, rel);
    if (duplicateOf) db.linkClaims(claim.id, duplicateOf);
    claims.push(claim);
  }

  // Split the extraction call's cost evenly across the claims it produced, or put it on the
  // message when there were none (so it still shows up in the usage meter).
  if (claims.length) spreadUsage(claims, usage.input, usage.output, usage.cost);
  else db.addCheckUsage(a.messageId, usage.input + usage.output, usage.cost);
  return claims.map((c) => db.getClaim(c.id)!);
}

function spreadUsage(claims: Claim[], inTok: number, outTok: number, cost: number) {
  const n = claims.length;
  for (const c of claims) db.addClaimUsage(c.id, Math.round(inTok / n), Math.round(outTok / n), cost / n);
}

function dedupeById<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

// ---------- reuse ----------

/**
 * Follow a duplicate match to the current verdict for that proposition: through a reused copy
 * to its original, then along any chain of newer verifications.
 */
function currentVersion(id: string): Claim | null {
  let c = db.getClaim(id);
  if (c?.reusedFrom) c = db.getClaim(c.reusedFrom);
  for (let hops = 0; c?.supersededBy && hops < 20; hops++) c = db.getClaim(c.supersededBy);
  return c;
}

/** A trustworthy, unexpired verdict this claim can copy instead of being checked again. */
export function reusableVerdict(claim: Claim): Claim | null {
  if (!claim.duplicateOf) return null;
  const prior = currentVersion(claim.duplicateOf);
  if (!prior || prior.id === claim.id || !isReusable(prior)) return null;
  // Verdicts only cross chats when the server is configured to share them.
  if (!sharedVerdicts() && prior.chatId !== claim.chatId) return null;
  return prior;
}

function copyVerdict(claim: Claim, prior: Claim): Claim {
  db.saveVerdict(claim.id, {
    status: prior.status,
    confidence: prior.confidence,
    summary: prior.summary,
    correction: prior.correction,
    importance: prior.importance,
    volatility: prior.volatility,
    expiresAt: prior.expiresAt,
    verifierModel: prior.verifierModel,
    inputTokens: 0,
    outputTokens: 0,
    searchCount: 0,
    costUsd: 0,
    reusedFrom: prior.id,
    sources: prior.sources,
  });
  return db.getClaim(claim.id)!;
}

// ---------- verification ----------

const VERDICT_TOOL: Anthropic.Tool = {
  name: "submit_verdict",
  description: "Record the final verdict for the claim. Call exactly once, after researching.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["supported", "partially_supported", "misleading", "refuted", "unverifiable"],
      },
      importance: { type: "string", enum: ["minor", "moderate", "major"] },
      volatility: { type: "string", enum: ["stable", "slow", "fast"] },
      confidence: { type: "number" },
      summary: { type: "string" },
      correction: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            quote: { type: "string" },
            stance: { type: "string", enum: ["supports", "contradicts", "context"] },
          },
          required: ["url", "title", "quote", "stance"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "importance", "volatility", "confidence", "summary", "correction", "sources"],
    additionalProperties: false,
  },
};

/**
 * What a verifier must hand back. Claude's strict tool guarantees the shape; other providers'
 * JSON is checked here before anything reaches the database, so a malformed verdict becomes a
 * failed check rather than a bad row.
 */
const VerdictSchema = z.object({
  verdict: z.enum(["supported", "partially_supported", "misleading", "refuted", "unverifiable"]),
  importance: z.enum(["minor", "moderate", "major"]).catch("minor"),
  volatility: z.enum(["stable", "slow", "fast"]).catch("slow"),
  confidence: z.coerce.number().catch(0.5).transform((c) => (Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5)),
  summary: z.string().catch("").transform((t) => t.trim().slice(0, 2000)),
  correction: z.string().catch("").transform((t) => t.trim().slice(0, 4000)),
  sources: z
    .array(
      z.object({
        url: z.string().transform((u) => u.trim()),
        title: z.string().catch("").transform((t) => t.slice(0, 500)),
        quote: z.string().catch("").transform((t) => t.slice(0, 2000)),
        stance: z.enum(["supports", "contradicts", "context"]).catch("context"),
      }),
    )
    .catch([])
    // Only web addresses can be shown as links, and each URL once.
    .transform((xs) => xs.filter((s, i, all) => isHttpUrl(s.url) && all.findIndex((o) => o.url === s.url) === i).slice(0, LIMITS.sources)),
});

type VerdictInput = z.infer<typeof VerdictSchema>;

/** Parse a verdict a model produced; throws a readable error when it isn't one. */
export function parseVerdict(raw: unknown): VerdictInput {
  const res = VerdictSchema.safeParse(raw);
  if (!res.success) throw new Error("The verifier returned a malformed verdict.");
  return res.data;
}

export interface VerifyArgs extends WithLlm {
  model: string;
  claim: Claim;
  context: string;
  /** Re-check even when an earlier verdict could be reused. */
  force?: boolean;
  /** Optional collector for every API response, e.g. for eval transcripts. */
  log?: Anthropic.Message[];
}

export async function verifyClaim(args: VerifyArgs): Promise<Claim> {
  const { model, claim, context, force, log } = args;
  // Copy a trustworthy, fresh verdict for the same proposition instead of searching again.
  const prior = force ? null : reusableVerdict(claim);
  if (prior) return copyVerdict(claim, prior);

  db.setClaimStatus(claim.id, "verifying");
  const today = new Date().toISOString().slice(0, 10);
  const maxSearches = claim.strictness === "facts" ? 3 : 5;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: verifierUser(claim.claim, claim.quote, context) },
  ];
  const retrievedUrls = new Set<string>();
  /** Verbatim page text the search API attached to the model's citations, by URL. */
  const citedText = new Map<string, string[]>();
  let usageIn = 0,
    usageOut = 0,
    searches = 0,
    cost = 0;
  let verdict: VerdictInput | null = null;
  let nudged = false;

  try {
    if (providerOf(model) !== "anthropic") {
      // Other providers research with their own web search and write the verdict out; a second,
      // structured call turns that write-up into the record.
      const llm = llmOf(args);
      const found = await research(llm, {
        model,
        system: verifierSystem(claim.strictness, today, "notes"),
        user: verifierUser(claim.claim, claim.quote, context),
        maxSearches,
      });
      found.retrievedUrls.forEach((u) => retrievedUrls.add(u));
      found.citedText.forEach((t, u) => citedText.set(u, t));
      const record = await complete(llm, {
        model,
        system: VERDICT_RECORD_SYSTEM,
        user: verdictRecordUser(found.text, [...found.retrievedUrls]),
        schema: { name: "verdict", schema: VERDICT_TOOL.input_schema as Record<string, unknown> },
        maxTokens: 4000,
      });
      usageIn = found.usage.inputTokens + record.usage.inputTokens;
      usageOut = found.usage.outputTokens + record.usage.outputTokens;
      searches = found.usage.searches;
      cost = found.usage.costUsd + record.usage.costUsd;
      if (!found.text.trim() || record.refused) throw new Error("The verifier model declined to check this claim.");
      verdict = parseVerdict(parseJson(record.text));
    }
    for (let turn = 0; turn < 6 && !verdict; turn++) {
      const res = await llmOf(args).anthropic().messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: "low" },
        system: verifierSystem(claim.strictness, today),
        tools: [webSearchTool(model, maxSearches), VERDICT_TOOL],
        messages,
      });
      log?.push(res);
      usageIn += inputTokens(res.usage);
      usageOut += res.usage.output_tokens;
      searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      cost += estimateCost(model, res.usage);

      for (const block of res.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content))
          for (const r of block.content) retrievedUrls.add(r.url);
        if (block.type === "text")
          for (const c of block.citations ?? [])
            if (c.type === "web_search_result_location") citedText.set(c.url, [...(citedText.get(c.url) ?? []), c.cited_text]);
        if (block.type === "tool_use" && block.name === "submit_verdict") verdict = parseVerdict(block.input);
      }
      if (verdict) break;
      if (res.stop_reason === "refusal") throw new Error("The verifier model declined to check this claim.");

      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "pause_turn") continue;
      if (nudged) break;
      nudged = true;
      messages.push({ role: "user", content: "Call submit_verdict now with your verdict." });
    }
    if (!verdict) throw new Error("The verifier finished without a verdict.");

    const isProblem = verdict.verdict !== "supported" && verdict.verdict !== "unverifiable";
    // Only keep quotes that are verifiably on the page; URLs the search didn't return get no quote.
    const sources = await Promise.all(
      verdict.sources.map(async (s) => {
        const retrieved = retrievedUrls.has(s.url);
        const quote = retrieved ? await verbatimQuote(s.url, s.quote, citedText.get(s.url) ?? []) : "";
        return { ...s, quote, retrieved };
      }),
    );
    const ttl = VOLATILITY_TTL_MS[verdict.volatility];
    db.saveVerdict(claim.id, {
      status: verdict.verdict,
      confidence: verdict.confidence,
      summary: verdict.summary,
      correction: isProblem ? verdict.correction || null : null,
      importance: isProblem ? verdict.importance : null,
      volatility: verdict.volatility,
      expiresAt: ttl === null ? null : Date.now() + ttl,
      verifierModel: model,
      inputTokens: usageIn,
      outputTokens: usageOut,
      searchCount: searches,
      costUsd: cost,
      reusedFrom: null,
      sources,
    });

    // A fresh check of a proposition that was already in the database replaces the old verdict,
    // whether it agrees or not: it's newer, and the old one wasn't trustworthy enough to reuse.
    if (claim.duplicateOf) {
      const old = currentVersion(claim.duplicateOf);
      if (old && old.id !== claim.id) db.supersede(old.id, claim.id);
    }
  } catch (err) {
    db.addClaimUsage(claim.id, usageIn, usageOut, cost);
    db.setClaimStatus(claim.id, "error", describeError(err));
  }
  return db.getClaim(claim.id)!;
}

// ---------- summary ----------

/**
 * Once every claim in a message is checked, write a one-line digest of the notable problems
 * (or clear it when there are none) and store it on the message.
 */
export async function summarizeMessage(opts: WithLlm & {
  model: string;
  messageId: string;
  minImportance: Importance;
}): Promise<string | null> {
  const claims = db.listClaims({ messageId: opts.messageId });
  if (claims.some((c) => c.status === "pending" || c.status === "verifying")) return null;
  const problems = claims.filter((c) => isNotableProblem(c, opts.minImportance));
  if (!problems.length) {
    db.setCheckSummary(opts.messageId, null);
    return null;
  }
  try {
    const res = await generateText(llmOf(opts), {
      model: opts.model,
      system: SUMMARY_SYSTEM,
      user: summaryUser(problems),
      maxTokens: 2000,
    });
    db.addCheckUsage(opts.messageId, res.usage.inputTokens + res.usage.outputTokens, res.usage.costUsd);
    const text = res.text.replace(/\s+/g, " ").trim();
    if (res.refused || !text) return null;
    db.setCheckSummary(opts.messageId, text);
    return text;
  } catch (err) {
    console.error("summary failed:", describeError(err));
    return null;
  }
}

// ---------- orchestration ----------

/** Limits how many verifications run at once per pipeline. */
export function semaphore(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      // A waiter inherits this slot directly, so `active` never exceeds `limit`.
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

export interface TriageConfig {
  /** OpenRouter decision-model id; empty = triage off. */
  model: string;
  threshold: number;
  auditRate: number;
  /** Key for the triage model's service (OpenRouter or TypeSafe). */
  key: string | null;
}

/**
 * Score each claim with the decision model and mark the confident ones "skipped". A random
 * `auditRate` share of would-be-skipped claims is checked anyway, which over time measures how
 * well the model's probabilities predict the real verdict. Returns the claims still to check.
 */
async function triage(
  cfg: TriageConfig,
  claims: Claim[],
  context: string,
  emit: (c: Claim) => void,
  llm: Llm,
  onError?: (message: string) => void,
) {
  if (!cfg.model || !cfg.key || !claims.length) return claims;
  const key = cfg.key;
  const provider = triageProvider(cfg.model);
  const results = await Promise.all(
    claims.map(async (c): Promise<Claim> => {
      let score;
      try {
        score = await llm.track(provider, () => triageClaim({ model: cfg.model, claim: c.claim, context, key }));
      } catch (err) {
        console.error("triage failed, checking instead:", describeError(err));
        onError?.(`Triage didn't work, so every claim gets the full check. ${describeError(err)}`);
        return c;
      }
      db.addClaimUsage(c.id, 0, 0, score.costUsd);
      const confident = score.pAccurate >= cfg.threshold;
      const audit = confident && Math.random() < cfg.auditRate;
      db.setTriage(c.id, { confidence: score.pAccurate, model: score.model, audit, skip: confident && !audit });
      return db.getClaim(c.id)!;
    }),
  );
  results.filter((c) => c.status === "skipped").forEach(emit);
  return results.filter((c) => c.status !== "skipped");
}

/**
 * Runs fact-checking for one assistant message as it streams. Call `addPassage` for each
 * completed passage and `finish` once the message is done; every claim update goes to `emit`.
 */
export function createPipeline(opts: {
  llm: Llm;
  model: string;
  strictness: Strictness;
  triage: TriageConfig;
  chatId: string;
  messageId: string;
  userQuestion: string;
  emit: (claim: Claim) => void;
  /** Called with the number of passages currently being scanned for claims. */
  onExtracting?: (active: number) => void;
  /** A step failed in a way the user should hear about (e.g. the checker's key was rejected). */
  onError?: (message: string) => void;
  /** Quotes already extracted from this message, when re-checking it. */
  skipQuotes?: Set<string>;
}) {
  const limit = semaphore(4);
  const tasks: Promise<unknown>[] = [];
  let extracting = 0;
  const setExtracting = (delta: number) => opts.onExtracting?.((extracting += delta));

  function addPassage(passage: string, passageOffset: number, replySoFar: string) {
    // Very long answers are checked up to a limit; the rest is left unchecked rather than
    // turned into hundreds of extraction calls.
    if (passageOffset >= LIMITS.checkChars) return;
    if (passageOffset + passage.length > LIMITS.checkChars) passage = passage.slice(0, LIMITS.checkChars - passageOffset);
    if (!passage.trim()) return;
    tasks.push(
      (async () => {
        let claims: Claim[];
        setExtracting(1);
        try {
          claims = await extractClaims({ ...opts, passage, passageOffset, replySoFar });
        } catch (err) {
          console.error("extraction failed:", describeError(err));
          opts.onError?.(`Couldn't pull claims out of this answer. ${describeError(err)}`);
          return;
        } finally {
          setExtracting(-1);
        }
        claims.forEach(opts.emit);

        // Reuse trustworthy earlier verdicts first; triage only what's left.
        const fresh: Claim[] = [];
        for (const c of claims) {
          const prior = reusableVerdict(c);
          if (prior) opts.emit(copyVerdict(c, prior));
          else fresh.push(c);
        }
        const toCheck = await triage(opts.triage, fresh, opts.userQuestion, opts.emit, opts.llm, opts.onError);

        const context = `User asked: ${opts.userQuestion}\n\nAssistant replied (excerpt): ${passage}`;
        await Promise.all(
          toCheck.map((c) =>
            limit(() => {
              opts.emit({ ...c, status: "verifying" });
              return verifyClaim({ ...opts, claim: c, context, force: true }).then((done) => {
                opts.emit(done);
                if (done.status === "error" && done.error) opts.onError?.(`Couldn't check a claim. ${done.error}`);
              });
            }),
          ),
        );
      })(),
    );
  }

  return { addPassage, finish: () => Promise.all(tasks) };
}

/**
 * Splits streaming text into passages at paragraph breaks outside code fences, so
 * extraction can start before the whole reply has arrived. `next` is called with the whole
 * reply so far on every delta; it scans only the new text, remembering where it was.
 */
export function createChunker(minChars = 600) {
  let emittedUpTo = 0;
  /** Scanning state: the first unscanned index, the start of the current line, and whether it's inside a fence. */
  let pos = 0;
  let lineStart = 0;
  let inFence = false;
  /** The most recent paragraph boundary after `emittedUpTo`, or -1. */
  let cut = -1;

  function scan(full: string) {
    if (full.length < pos) {
      // The text was replaced rather than extended: start over.
      pos = lineStart = 0;
      inFence = false;
      cut = -1;
    }
    for (let i = pos; i < full.length; i++) {
      if (full[i] !== "\n") continue;
      const line = full.slice(lineStart, i);
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      // A blank line ends a paragraph; the line after it starts at i + 1.
      if (!inFence && line.trim() === "" && lineStart > emittedUpTo) cut = lineStart;
      lineStart = i + 1;
    }
    pos = full.length;
  }

  return {
    /** Returns [start, end) of a newly completed passage, if there is one. */
    next(full: string): [number, number] | null {
      scan(full);
      if (cut > emittedUpTo && cut - emittedUpTo >= minChars) {
        const range: [number, number] = [emittedUpTo, cut];
        emittedUpTo = cut;
        cut = -1;
        return range;
      }
      return null;
    },
    /** Everything after the last passage, once the text is complete. */
    rest(full: string): [number, number] | null {
      if (emittedUpTo >= full.length) return null;
      const range: [number, number] = [emittedUpTo, full.length];
      emittedUpTo = full.length;
      cut = -1;
      return range;
    },
  };
}

// ---------- chat title ----------

/** A few-word title for a chat, from its first question and answer, like a sidebar entry. */
export async function titleChat(opts: WithLlm & { model: string; messageId: string; question: string; answer: string }) {
  try {
    const res = await generateText(llmOf(opts), {
      model: opts.model,
      system: TITLE_SYSTEM,
      user: `<question>\n${opts.question.slice(0, 2000)}\n</question>\n\n<answer>\n${opts.answer.slice(0, 2000)}\n</answer>`,
      maxTokens: 200,
    });
    db.addCheckUsage(opts.messageId, res.usage.inputTokens + res.usage.outputTokens, res.usage.costUsd);
    const title = res.text.replace(/\s+/g, " ").replace(/^["'\s]+|["'.\s]+$/g, "").trim();
    return res.refused || !title ? null : title.slice(0, 80);
  } catch (err) {
    console.error("title failed:", describeError(err));
    return null;
  }
}
