// Chat turns replayed from recorded real traffic. Record once with real keys:
//
//   LITMUS_CASSETTE_MODE=record ANTHROPIC_API_KEY=sk-ant-... npm test -- test/recorded.test.ts
//
// That writes test/cassettes/<name>.json (prompts and responses; keys are never stored), and
// every later run replays it offline. Delete a cassette to re-record it. Without a cassette and
// without record mode, the test is skipped.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { useTempDb, chat, jsonRequest, readEvents, ofType, newId } from "./helpers";
import { installCassette, type Mode } from "./replay";

// lib/db.ts opens its file on first use, after this runs, so the hoisted imports below are fine.
useTempDb();
import { POST } from "../app/api/chat/route";
import { holdCount } from "../lib/session";
import { resolver } from "../lib/safeFetch";

const CASSETTES = path.join(import.meta.dirname, "cassettes");
const mode = (process.env.LITMUS_CASSETTE_MODE as Mode) || "replay";

/** Keys from the environment when recording; placeholders when replaying (they're never compared). */
function keyHeaders(): Record<string, string> {
  const env: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  const headers: Record<string, string> = {};
  for (const [p, name] of Object.entries(env)) {
    const v = mode === "replay" ? `${p}-placeholder-key-0000` : process.env[name];
    if (v) headers[`x-key-${p}`] = v;
  }
  return headers;
}

/** The conversations to record. Add a case, record it, commit the cassette. */
const CASES: { name: string; content: string; settings: Record<string, unknown> }[] = [
  { name: "eiffel-haiku", content: "How tall is the Eiffel Tower, and when was it finished?", settings: { mainModel: "claude-haiku-5-5", mainTools: false } },
];

describe("recorded chat turns", () => {
  for (const c of CASES) {
    const file = path.join(CASSETTES, `${c.name}.json`);
    const available = fs.existsSync(file) || mode !== "replay";
    it(c.name, { skip: available ? false : `no cassette at ${path.relative(process.cwd(), file)}; record it with LITMUS_CASSETTE_MODE=record` }, async () => {
      if (mode === "replay") resolver.lookup = async () => ["93.184.216.34"];
      const tape = installCassette({ file, mode });
      try {
        const chatId = newId("chat");
        const res = await POST(jsonRequest("/api/chat", { ...chat(chatId), content: c.content, settings: c.settings }, keyHeaders()));
        assert.equal(res.status, 200);
        const events = await readEvents(res);
        assert.equal(events[0].type, "meta");
        assert.equal(events[events.length - 1].type, "end");
        assert.deepEqual(ofType(events, "error"), []);
        const text = ofType(events, "text").map((e) => e.delta).join("");
        assert.ok(text.length > 0, "the model answered");
        assert.equal(ofType(events, "message_done")[0].message.content, text);
        const claims = new Map(ofType(events, "claim").map((e) => [e.claim.id, e.claim]));
        for (const claim of claims.values()) {
          assert.ok(!["pending", "verifying"].includes(claim.status), `claim finished: ${claim.status}`);
          assert.ok(claim.startOffset < 0 || text.slice(claim.startOffset, claim.endOffset).length > 0);
        }
        assert.equal(holdCount(chatId), 0);
        if (mode === "replay") assert.equal(tape.misses.length, 0, "every call came from the cassette");
      } finally {
        tape.uninstall();
      }
    });
  }
});
