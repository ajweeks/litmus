// The fact-checking pipeline: extract claims from a passage, optionally triage them with a cheap
// model, then verify the rest with web search.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as db from "./db";
import { estimateCost, describeError, inputTokens, webSearchTool } from "./anthropic";
import { extractorSystem, extractorUser, SUMMARY_SYSTEM, summaryUser, verifierSystem, verifierUser } from "./prompts";
import { verbatimQuote } from "./sources";
import { locate } from "./text";
import { triageClaim } from "./triage";
import type { Claim, ClaimStatus, Importance, Source, Strictness, Volatility } from "./types";
import { isNotableProblem, isReusable, VOLATILITY_TTL_MS } from "./types";

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

export interface ExtractArgs {
  client: Anthropic;
  model: string;
  strictness: Strictness;
  chatId: string;
  messageId: string;
  userQuestion: string;
  replySoFar: string;
  passage: string;
  /** Offset of `passage` within the full message text. */
  passageOffset: number;
}

export async function extractClaims(a: ExtractArgs): Promise<Claim[]> {
  const chatClaims = db.listClaims({ chatId: a.chatId }).map((c) => ({ id: c.id, claim: c.claim }));
  const known = dedupeById([...chatClaims, ...db.recentVerifiedClaims(40)]);
  const knownIds = new Set(known.map((k) => k.id));

  const res = await a.client.messages.parse({
    model: a.model,
    max_tokens: 8000,
    output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
    system: extractorSystem(a.strictness),
    messages: [
      {
        role: "user",
        content: extractorUser({ userQuestion: a.userQuestion, replySoFar: a.replySoFar, passage: a.passage, known }),
      },
    ],
  });
  if (res.stop_reason === "refusal") return [];
  const items = res.parsed_output?.claims ?? [];

  const claims: Claim[] = [];
  for (const item of items) {
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
    for (const rel of item.related_ids) if (knownIds.has(rel)) db.linkClaims(claim.id, rel);
    if (duplicateOf) db.linkClaims(claim.id, duplicateOf);
    claims.push(claim);
  }

  // Split the extraction call's cost evenly across the claims it produced.
  spreadUsage(claims, inputTokens(res.usage), res.usage.output_tokens, estimateCost(a.model, res.usage));
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
  return prior && prior.id !== claim.id && isReusable(prior) ? prior : null;
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

type VerdictInput = {
  verdict: ClaimStatus;
  importance: Importance;
  volatility: Volatility;
  confidence: number;
  summary: string;
  correction: string;
  sources: { url: string; title: string; quote: string; stance: Source["stance"] }[];
};

export interface VerifyArgs {
  client: Anthropic;
  model: string;
  claim: Claim;
  context: string;
  /** Re-check even when an earlier verdict could be reused. */
  force?: boolean;
  /** Optional collector for every API response, e.g. for eval transcripts. */
  log?: Anthropic.Message[];
}

export async function verifyClaim({ client, model, claim, context, force, log }: VerifyArgs): Promise<Claim> {
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
    for (let turn = 0; turn < 6 && !verdict; turn++) {
      const res = await client.messages.create({
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
        if (block.type === "tool_use" && block.name === "submit_verdict") verdict = block.input as VerdictInput;
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
      verdict.sources
        .filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i)
        .slice(0, 3)
        .map(async (s) => {
          const retrieved = retrievedUrls.has(s.url);
          const quote = retrieved ? await verbatimQuote(s.url, s.quote, citedText.get(s.url) ?? []) : "";
          return { ...s, quote, retrieved };
        }),
    );
    const ttl = VOLATILITY_TTL_MS[verdict.volatility];
    db.saveVerdict(claim.id, {
      status: verdict.verdict,
      confidence: Math.min(1, Math.max(0, verdict.confidence)),
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
export async function summarizeMessage(opts: {
  client: Anthropic;
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
    const res = await opts.client.messages.create({
      model: opts.model,
      max_tokens: 2000,
      output_config: { effort: "low" },
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: summaryUser(problems) }],
    });
    db.addCheckUsage(opts.messageId, inputTokens(res.usage) + res.usage.output_tokens, estimateCost(opts.model, res.usage));
    const text = res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (res.stop_reason === "refusal" || !text) return null;
    db.setCheckSummary(opts.messageId, text);
    return text;
  } catch (err) {
    console.error("summary failed:", describeError(err));
    return null;
  }
}

// ---------- orchestration ----------

/** Limits how many verifications run at once per pipeline. */
function semaphore(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export interface TriageConfig {
  /** OpenRouter decision-model id; empty = triage off. */
  model: string;
  threshold: number;
  auditRate: number;
  openrouterKey: string | null;
}

/**
 * Score each claim with the decision model and mark the confident ones "skipped". A random
 * `auditRate` share of would-be-skipped claims is checked anyway, which over time measures how
 * well the model's probabilities predict the real verdict. Returns the claims still to check.
 */
async function triage(cfg: TriageConfig, claims: Claim[], context: string, emit: (c: Claim) => void) {
  if (!cfg.model || !cfg.openrouterKey || !claims.length) return claims;
  const key = cfg.openrouterKey;
  const results = await Promise.all(
    claims.map(async (c): Promise<Claim> => {
      let score;
      try {
        score = await triageClaim({ model: cfg.model, claim: c.claim, context, key });
      } catch (err) {
        console.error("triage failed, checking instead:", describeError(err));
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
  client: Anthropic;
  model: string;
  strictness: Strictness;
  triage: TriageConfig;
  chatId: string;
  messageId: string;
  userQuestion: string;
  emit: (claim: Claim) => void;
}) {
  const limit = semaphore(4);
  const tasks: Promise<unknown>[] = [];

  function addPassage(passage: string, passageOffset: number, replySoFar: string) {
    if (!passage.trim()) return;
    tasks.push(
      (async () => {
        let claims: Claim[];
        try {
          claims = await extractClaims({ ...opts, passage, passageOffset, replySoFar });
        } catch (err) {
          console.error("extraction failed:", describeError(err));
          return;
        }
        claims.forEach(opts.emit);

        // Reuse trustworthy earlier verdicts first; triage only what's left.
        const fresh: Claim[] = [];
        for (const c of claims) {
          const prior = reusableVerdict(c);
          if (prior) opts.emit(copyVerdict(c, prior));
          else fresh.push(c);
        }
        const toCheck = await triage(opts.triage, fresh, opts.userQuestion, opts.emit);

        const context = `User asked: ${opts.userQuestion}\n\nAssistant replied (excerpt): ${passage}`;
        await Promise.all(
          toCheck.map((c) =>
            limit(() => {
              opts.emit({ ...c, status: "verifying" });
              return verifyClaim({ ...opts, claim: c, context, force: true }).then(opts.emit);
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
 * extraction can start before the whole reply has arrived.
 */
export function createChunker(minChars = 600) {
  let emittedUpTo = 0;
  return {
    /** Returns [start, end) of a newly completed passage, if there is one. */
    next(full: string): [number, number] | null {
      let cut = -1;
      let inFence = false;
      let lineStart = 0;
      for (let i = 0; i <= full.length; i++) {
        if (i === full.length || full[i] === "\n") {
          const line = full.slice(lineStart, i);
          if (line.trimStart().startsWith("```")) inFence = !inFence;
          // A blank line ends a paragraph; the line after it must have started (i < length).
          if (!inFence && line.trim() === "" && i < full.length && lineStart > emittedUpTo) cut = lineStart;
          lineStart = i + 1;
        }
      }
      if (cut > emittedUpTo && cut - emittedUpTo >= minChars) {
        const range: [number, number] = [emittedUpTo, cut];
        emittedUpTo = cut;
        return range;
      }
      return null;
    },
    rest(full: string): [number, number] | null {
      if (emittedUpTo >= full.length) return null;
      const range: [number, number] = [emittedUpTo, full.length];
      emittedUpTo = full.length;
      return range;
    },
  };
}
