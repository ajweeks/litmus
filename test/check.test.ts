// Retrying a failed check (POST /api/check) and reusing verdicts, offline.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { useTempDb, chat, jsonRequest, readEvents, ofType, newId } from "./helpers";
import { installCassette, type Cassette } from "./replay";
import { anthropic } from "./fixtures/anthropic";

// lib/db.ts opens its file on first use, after this runs, so the hoisted imports above are fine.
useTempDb();
import * as db from "../lib/db";
import { POST as check } from "../app/api/check/route";
import { reusableVerdict, verifyClaim } from "../lib/factcheck";
import { Llm } from "../lib/llm";
import { resolver } from "../lib/safeFetch";

const chatId = newId("chat");
const messageId = newId("msg");
const ANSWER = "Water boils at 100 °C at sea level.\n\nIt freezes at 5 °C.";

describe("POST /api/check (offline)", () => {
  let tape: Cassette;
  before(() => {
    resolver.lookup = async () => ["93.184.216.34"];
  });
  after(() => tape?.uninstall());

  it("re-verifies failed claims and extracts what wasn't found, skipping known quotes", async () => {
    // One claim whose check failed earlier.
    const failed = db.insertClaim({
      chatId,
      messageId,
      quote: "Water boils at 100 °C at sea level",
      startOffset: 0,
      endOffset: 34,
      claim: "Water boils at 100 °C at sea level.",
      category: "empirical",
      strictness: "facts",
      extractorModel: "claude-haiku-5-5",
      duplicateOf: null,
    });
    db.setClaimStatus(failed.id, "error", "Anthropic timed out.");

    tape = installCassette({
      mode: "replay",
      entries: [
        anthropic.verifier({ verdict: "supported", confidence: 0.99, summary: "Standard boiling point." }, (u) => u.includes("boils")),
        anthropic.extractor([
          // The first is already known and must be skipped; the second is new.
          { quote: "Water boils at 100 °C at sea level", claim: "Water boils at 100 °C at sea level." },
          { quote: "It freezes at 5 °C", claim: "Water freezes at 5 °C." },
        ]),
        anthropic.verifier(
          { verdict: "refuted", importance: "major", confidence: 0.99, summary: "Water freezes at **0 °C**.", correction: "Water freezes at **0 °C**." },
          (u) => u.includes("freezes"),
        ),
        anthropic.summary("Water freezes at **0 °C**, not 5 °C."),
      ],
    });

    const payload = chat(chatId, [
      { role: "user", content: "Tell me about water." },
      { id: messageId, role: "assistant", content: ANSWER },
    ]);
    const res = await check(jsonRequest("/api/check", { ...payload, messageId, reextract: true, settings: {} }));
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    assert.equal(ofType(events, "error").length, 0, JSON.stringify(ofType(events, "error")));

    const claims = db.listClaims({ chatId, messageId });
    assert.equal(claims.length, 2, "the known quote was not extracted twice");
    assert.equal(claims.find((c) => c.id === failed.id)!.status, "supported");
    assert.equal(claims.find((c) => c.quote.includes("freezes"))!.status, "refuted");
    assert.equal(ofType(events, "summary")[0].message.checkSummary, "Water freezes at **0 °C**, not 5 °C.");
    assert.equal(tape.misses.length, 0);
  });

  it("rejects a message id that isn't an assistant message in the payload", async () => {
    const payload = chat(chatId, [{ id: messageId, role: "user", content: "x" }]);
    const res = await check(jsonRequest("/api/check", { ...payload, messageId, settings: {} }));
    assert.equal(res.status, 400);
  });
});

describe("verdict reuse", () => {
  it("copies a trustworthy earlier verdict instead of searching, and never a shaky one", async () => {
    const llm = new Llm({ anthropic: "sk-ant-test" });
    const tape = installCassette({ mode: "replay", entries: [] });
    try {
      const prior = db.insertClaim({
        chatId: newId("chat"),
        messageId: newId("msg"),
        quote: "q",
        startOffset: -1,
        endOffset: -1,
        claim: "The Moon orbits the Earth.",
        category: "empirical",
        strictness: "facts",
        extractorModel: "t",
        duplicateOf: null,
      });
      db.saveVerdict(prior.id, {
        status: "supported",
        confidence: 0.99,
        summary: "Yes.",
        correction: null,
        importance: null,
        volatility: "stable",
        expiresAt: null,
        verifierModel: "claude-haiku-5-5",
        inputTokens: 10,
        outputTokens: 10,
        searchCount: 1,
        costUsd: 0.01,
        reusedFrom: null,
        sources: [{ url: "https://example.org/moon", title: "Moon", quote: "orbits", stance: "supports", retrieved: true }],
      });
      const dup = db.insertClaim({ ...prior, chatId: newId("chat"), messageId: newId("msg"), duplicateOf: prior.id });
      assert.equal(reusableVerdict(db.getClaim(dup.id)!)?.id, prior.id);
      const copied = await verifyClaim({ llm, model: "claude-haiku-5-5", claim: db.getClaim(dup.id)!, context: "" });
      assert.equal(copied.status, "supported");
      assert.equal(copied.reusedFrom, prior.id);
      assert.equal(copied.costUsd, 0);
      assert.equal(tape.served.length, 0, "no model call for a reused verdict");

      // Low confidence, or no retrieved source, or expired: not reusable.
      db.saveVerdict(prior.id, { ...db.getClaim(prior.id)!, confidence: 0.6, sources: db.getClaim(prior.id)!.sources });
      assert.equal(reusableVerdict(db.getClaim(dup.id)!), null);
      db.saveVerdict(prior.id, { ...db.getClaim(prior.id)!, confidence: 0.99, sources: [] });
      assert.equal(reusableVerdict(db.getClaim(dup.id)!), null);
      db.saveVerdict(prior.id, { ...db.getClaim(prior.id)!, expiresAt: Date.now() - 1, sources: db.getClaim(prior.id)!.sources });
      assert.equal(reusableVerdict(db.getClaim(dup.id)!), null);
    } finally {
      tape.uninstall();
    }
  });

  it("stays within a chat when FACTCHECK_SHARED_VERDICTS=off", () => {
    process.env.FACTCHECK_SHARED_VERDICTS = "off";
    try {
      const a = db.insertClaim({
        chatId: newId("chat"),
        messageId: newId("msg"),
        quote: "q",
        startOffset: -1,
        endOffset: -1,
        claim: "Paris is the capital of France.",
        category: "empirical",
        strictness: "facts",
        extractorModel: "t",
        duplicateOf: null,
      });
      db.saveVerdict(a.id, {
        status: "supported",
        confidence: 0.99,
        summary: "Yes.",
        correction: null,
        importance: null,
        volatility: "stable",
        expiresAt: null,
        verifierModel: "t",
        inputTokens: 0,
        outputTokens: 0,
        searchCount: 1,
        costUsd: 0,
        reusedFrom: null,
        sources: [{ url: "https://example.org/paris", title: "P", quote: "", stance: "supports", retrieved: true }],
      });
      const sameChat = db.insertClaim({ ...a, messageId: newId("msg"), duplicateOf: a.id });
      const otherChat = db.insertClaim({ ...a, chatId: newId("chat"), messageId: newId("msg"), duplicateOf: a.id });
      assert.equal(reusableVerdict(db.getClaim(sameChat.id)!)?.id, a.id);
      assert.equal(reusableVerdict(db.getClaim(otherChat.id)!), null);
      assert.deepEqual(db.recentVerifiedClaims(), []);
    } finally {
      delete process.env.FACTCHECK_SHARED_VERDICTS;
    }
  });
});
