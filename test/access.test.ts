// The claims cache is shared between every user of a server. These tests pin down what one
// browser can and can't do with another chat's claims: nothing, unless it knows that chat's id.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { useTempDb, chat, jsonRequest, readEvents, ofType, newId } from "./helpers";
import { installCassette, type Cassette } from "./replay";
import { anthropic } from "./fixtures/anthropic";

// lib/db.ts opens its file on first use, after this runs, so the hoisted imports above are fine.
useTempDb();
import * as db from "../lib/db";
import { GET as listClaims } from "../app/api/claims/route";
import { GET as getClaim, POST as recheck } from "../app/api/claims/[id]/route";
import { POST as check } from "../app/api/check/route";
import { POST as chatTurn } from "../app/api/chat/route";
import { resolver } from "../lib/safeFetch";

const victimChat = newId("chat");
const victimMessage = newId("msg");
const attackerChat = newId("chat");
let victimClaimId = "";

describe("claim access is scoped to the chat id", () => {
  let tape: Cassette;
  before(async () => {
    resolver.lookup = async () => ["93.184.216.34"];
    // A victim's claim with a wrong verdict pending correction, as the pipeline would leave it.
    const c = db.insertClaim({
      chatId: victimChat,
      messageId: victimMessage,
      quote: "completed in 1887",
      startOffset: 0,
      endOffset: 17,
      claim: "The Eiffel Tower was completed in 1887.",
      category: "empirical",
      strictness: "facts",
      extractorModel: "test",
      duplicateOf: null,
    });
    victimClaimId = c.id;
    db.saveVerdict(c.id, {
      status: "refuted",
      confidence: 0.97,
      summary: "Finished in **1889**.",
      correction: "It was completed in **1889**.",
      importance: "major",
      volatility: "stable",
      expiresAt: null,
      verifierModel: "test",
      inputTokens: 1,
      outputTokens: 1,
      searchCount: 1,
      costUsd: 0.001,
      reusedFrom: null,
      sources: [{ url: "https://example.org/e", title: "E", quote: "1889", stance: "contradicts", retrieved: true }],
    });
    tape = installCassette({ mode: "replay", entries: [] });
  });
  after(() => tape.uninstall());

  it("GET /api/claims needs the chat id and only returns that chat's claims", async () => {
    const own = await listClaims(new Request(`http://localhost/api/claims?ids=${victimClaimId}&chat=${victimChat}`));
    assert.equal(((await own.json()) as unknown[]).length, 1);
    const foreign = await listClaims(new Request(`http://localhost/api/claims?ids=${victimClaimId}&chat=${attackerChat}`));
    assert.deepEqual(await foreign.json(), []);
    const none = await listClaims(new Request(`http://localhost/api/claims?ids=${victimClaimId}`));
    assert.equal(none.status, 400);
    const junk = await listClaims(new Request(`http://localhost/api/claims?ids=%27%20OR%201,${victimClaimId}&chat=${victimChat}`));
    assert.equal(((await junk.json()) as unknown[]).length, 1);
  });

  it("GET /api/claims/:id is 404 for another chat", async () => {
    const params = Promise.resolve({ id: victimClaimId });
    assert.equal((await getClaim(new Request(`http://localhost/api/claims/x?chat=${attackerChat}`), { params })).status, 404);
    assert.equal((await getClaim(new Request(`http://localhost/api/claims/x?chat=${victimChat}`), { params })).status, 200);
    assert.equal((await getClaim(new Request(`http://localhost/api/claims/x`), { params })).status, 400);
  });

  it("POST /api/claims/:id can't re-verify another chat's claim, even with a forged payload", async () => {
    const res = await recheck(jsonRequest(`/api/claims/${victimClaimId}`, { ...chat(attackerChat), model: "claude-haiku-5-5" }), {
      params: Promise.resolve({ id: victimClaimId }),
    });
    assert.equal(res.status, 404);
    assert.equal(tape.served.length, 0, "no model call was made");
    assert.equal(db.getClaim(victimClaimId)!.status, "refuted");
  });

  it("POST /api/check only sees the claims of the chat in the request", async () => {
    // The attacker knows the victim's message id and forges an assistant message with it.
    const payload = chat(attackerChat, [{ id: victimMessage, role: "assistant", content: "whatever" }]);
    const res = await check(jsonRequest("/api/check", { ...payload, messageId: victimMessage, settings: {} }));
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    assert.equal(ofType(events, "claim").length, 0);
    assert.equal(tape.served.length, 0);
  });

  it("POST /api/chat with a forged chat id gets no corrections from the real chat's claims", async () => {
    const t = installCassette({ mode: "replay", entries: [anthropic.reply("ok"), anthropic.extractor([])] });
    try {
      // The attacker uses their own chat id; the victim's claims belong to another id and stay unseen.
      const res = await chatTurn(jsonRequest("/api/chat", { ...chat(attackerChat), content: "hi", settings: {} }));
      const meta = ofType(await readEvents(res), "meta")[0];
      assert.equal(meta.systemMessage, null);
      assert.equal(db.getClaim(victimClaimId)!.fedBackIn, null, "the victim's claim wasn't marked as sent");
    } finally {
      t.uninstall();
    }
  });

  it("a message upsert can't move or rewrite a message of another chat", () => {
    db.importChat({ id: victimChat, title: "v", createdAt: 1, updatedAt: 1 }, [
      { id: victimMessage, role: "assistant", content: "original", kind: "normal", model: null, createdAt: 1 },
    ]);
    db.importChat({ id: attackerChat, title: "a", createdAt: 1, updatedAt: 1 }, [
      { id: victimMessage, role: "assistant", content: "tampered", kind: "normal", model: null, createdAt: 1 },
    ]);
    const m = db.getMessage(victimMessage)!;
    assert.equal(m.chatId, victimChat);
    assert.equal(m.content, "original");
    db.deleteChat(victimChat);
    db.deleteChat(attackerChat);
  });
});
