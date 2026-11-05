// A whole chat turn, offline: POST /api/chat with every provider call answered from a cassette
// built in code (test/fixtures/anthropic.ts). To test against recorded real traffic instead,
// see test/recorded.test.ts.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { useTempDb, chat, jsonRequest, readEvents, ofType, TEST_KEYS, newId } from "./helpers";
import { installCassette, type Cassette } from "./replay";
import { anthropic } from "./fixtures/anthropic";

// lib/db.ts opens its file on first use, after this runs, so the hoisted imports above are fine.
useTempDb();
import { POST } from "../app/api/chat/route";
import * as db from "../lib/db";
import { holdCount } from "../lib/session";
import { resolver } from "../lib/safeFetch";

const REPLY = "The Eiffel Tower is 330 metres tall.\n\nIt was completed in 1887 for the World's Fair.";
const SOURCE = { url: "https://example.org/eiffel", title: "Eiffel Tower", quote: "opened on 31 March 1889", stance: "contradicts" };

function cassette(): Cassette {
  return installCassette({
    mode: "replay",
    entries: [
      anthropic.reply(REPLY, { thinking: "Let me recall the facts." }),
      anthropic.extractor([
        { quote: "The Eiffel Tower is 330 metres tall", claim: "The Eiffel Tower is 330 metres tall." },
        { quote: "completed in 1887", claim: "The Eiffel Tower was completed in 1887." },
      ]),
      anthropic.verifier(
        { verdict: "supported", confidence: 0.95, summary: "Its current height is 330 m.", sources: [{ ...SOURCE, quote: "330 metres", stance: "supports" }] },
        (user) => user.includes("330 metres"),
      ),
      anthropic.verifier(
        {
          verdict: "refuted",
          importance: "major",
          confidence: 0.97,
          summary: "It was finished in **1889**, not 1887.",
          correction: "The Eiffel Tower was completed in **1889**.",
          sources: [SOURCE],
        },
        (user) => user.includes("1887"),
      ),
      anthropic.summary("Completed in **1889**, not 1887."),
      anthropic.title("Eiffel Tower facts"),
    ],
  });
}

describe("POST /api/chat (offline)", () => {
  let tape: Cassette;
  before(() => {
    tape = cassette();
    resolver.lookup = async () => ["93.184.216.34"];
  });
  after(() => tape.uninstall());

  const chatId = newId("chat");

  it("streams the reply, checks its claims, summarises and titles the chat, then forgets the messages", async () => {
    const res = await POST(jsonRequest("/api/chat", { ...chat(chatId), content: "How tall is the Eiffel Tower?", settings: {} }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /x-ndjson/);
    const events = await readEvents(res);

    // Order and completeness of the stream.
    assert.equal(events[0].type, "meta");
    assert.equal(events[events.length - 1].type, "end");
    const meta = ofType(events, "meta")[0];
    assert.equal(meta.chatId, chatId);
    assert.equal(meta.userMessage.content, "How tall is the Eiffel Tower?");
    assert.equal(ofType(events, "text").map((e) => e.delta).join(""), REPLY);
    assert.equal(ofType(events, "thinking").map((e) => e.delta).join(""), "Let me recall the facts.");
    const done = ofType(events, "message_done")[0];
    assert.equal(done.message.content, REPLY);
    assert.equal(done.message.thinking, "Let me recall the facts.");
    assert.equal(ofType(events, "title")[0].title, "Eiffel Tower facts");
    assert.equal(ofType(events, "error").length, 0, JSON.stringify(ofType(events, "error")));

    // Claims: both extracted, located in the text, then verified.
    const claims = ofType(events, "claim").map((e) => e.claim);
    const final = new Map(claims.map((c) => [c.id, c]));
    assert.equal(final.size, 2);
    const byQuote = (q: string) => [...final.values()].find((c) => c.quote.includes(q))!;
    const height = byQuote("330 metres");
    const year = byQuote("1887");
    assert.equal(height.status, "supported");
    assert.equal(year.status, "refuted");
    assert.equal(year.importance, "major");
    assert.equal(year.correction, "The Eiffel Tower was completed in **1889**.");
    assert.equal(REPLY.slice(height.startOffset, height.endOffset), "The Eiffel Tower is 330 metres tall");
    assert.equal(year.sources.length, 1);
    assert.equal(year.sources[0].retrieved, true, "the URL came back from the search");
    assert.equal(year.sources[0].quote, "opened on 31 March 1889", "the quote matched the cited text");
    assert.ok(year.costUsd > 0 && year.searchCount === 1);
    assert.equal(year.verifierModel, "claude-haiku-5-5");

    // The one-line digest covers the problem.
    const summary = ofType(events, "summary")[0];
    assert.equal(summary.message.checkSummary, "Completed in **1889**, not 1887.");
    assert.ok((summary.message.usage?.checkCostUsd ?? 0) > 0);

    // Server state afterwards: claims kept, chat and messages forgotten, nothing held.
    assert.equal(holdCount(chatId), 0);
    assert.equal(db.getMessages(chatId).length, 0);
    assert.equal(db.listClaims({ chatId }).length, 2);
    assert.equal(tape.misses.length, 0);
    assert.equal(tape.served.length, 6);
  });

  it("feeds unsent corrections back on the next turn", async () => {
    const assistantId = newId("msg");
    const nextTape = installCassette({
      mode: "replay",
      entries: [anthropic.reply("You're right, it was 1889."), anthropic.extractor([])],
    });
    try {
      const payload = chat(chatId, [
        { role: "user", content: "How tall is the Eiffel Tower?" },
        { id: assistantId, role: "assistant", content: REPLY, model: "claude-opus-5-5" },
      ]);
      const res = await POST(jsonRequest("/api/chat", { ...payload, content: "Are you sure?", settings: {} }));
      const events = await readEvents(res);
      const meta = ofType(events, "meta")[0];
      assert.ok(meta.systemMessage, "a corrections note was added");
      assert.match(meta.systemMessage!.content, /<fact_check_results>/);
      assert.match(meta.systemMessage!.content, /\*\*1889\*\*/);
      assert.equal(meta.fedBackClaimIds.length, 1);
      // The note went to the model as part of the history.
      const mainCall = nextTape.served.find((s) => s.route.includes("stream"))!;
      assert.match(mainCall.request.body ?? "", /fact_check_results/);
      // And the claim is now marked as sent, so it won't be sent twice.
      assert.equal(db.unsentCorrections(chatId, "moderate").length, 0);
      assert.equal(ofType(events, "error").length, 0);
    } finally {
      nextTape.uninstall();
      tape = cassette();
    }
  });

  it("rejects bad input before holding or saving anything", async () => {
    const bad = async (body: unknown, headers: Record<string, string> = TEST_KEYS) => {
      const res = await POST(jsonRequest("/api/chat", body, headers));
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    assert.deepEqual(await bad("{not json"), { status: 400, error: "Request body isn't valid JSON." });
    assert.equal((await bad({ ...chat(), content: "hi", settings: { strictness: "max" } })).status, 400);
    assert.equal((await bad({ ...chat(), content: 42, settings: {} })).status, 400);
    assert.equal((await bad({ ...chat(), content: "   ", settings: {} })).status, 400);
    assert.equal((await bad({ ...chat(), content: "x".repeat(100_001), settings: {} })).status, 400);
    assert.equal((await bad({ chat: { id: "chat_1", title: "" }, messages: [], content: "hi", settings: {} })).status, 400);
    assert.equal((await bad({ ...chat(), content: "hi", settings: {} }, {})).status, 401);
    const other = newId("chat");
    assert.equal(holdCount(other), 0);
    assert.equal(db.getMessages(other).length, 0);
  });

  it("reports a provider failure as an error event and leaves no empty answer behind", async () => {
    const failing = installCassette({
      mode: "replay",
      entries: [{ route: "anthropic reply", match: () => true, response: anthropic.error(401, "invalid x-api-key") }],
    });
    try {
      const id = newId("chat");
      const res = await POST(jsonRequest("/api/chat", { ...chat(id), content: "hi", settings: {} }));
      const events = await readEvents(res);
      const errors = ofType(events, "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /didn't accept the API key/);
      assert.ok(ofType(events, "key_status").some((k) => k.provider === "anthropic" && !k.ok));
      assert.equal(ofType(events, "message_done").length, 0);
      assert.equal(events[events.length - 1].type, "end");
      assert.equal(holdCount(id), 0);
    } finally {
      failing.uninstall();
      tape = cassette();
    }
  });
});
