import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChat } from "../../lib/session";

const good = () => ({
  chat: { id: "chat_0123456789abcdef", title: "Hi", createdAt: 1, updatedAt: 2 },
  messages: [
    { id: "msg_0123456789abcdef", role: "user", content: "q", kind: "normal", model: null, createdAt: 1 },
    { id: "msg_0123456789abcdee", role: "assistant", content: "a", kind: "normal", model: "m", createdAt: 2 },
  ],
});

describe("parseChat", () => {
  it("accepts a well-formed chat and normalises it", () => {
    const p = parseChat(good())!;
    assert.equal(p.chat.id, "chat_0123456789abcdef");
    assert.equal(p.messages.length, 2);
    assert.equal(p.messages[1].model, "m");
  });
  it("rejects non-string and short ids (a number would pass a bare regex test)", () => {
    const c = good();
    (c.chat as { id: unknown }).id = 123;
    assert.equal(parseChat(c), null);
    const d = good();
    d.messages[0].id = "msg_1";
    assert.equal(parseChat(d), null);
  });
  it("rejects bad roles, kinds, content and duplicate ids", () => {
    const a = good();
    a.messages[0].role = "tool";
    assert.equal(parseChat(a), null);
    const b = good();
    b.messages[0].kind = "weird";
    assert.equal(parseChat(b), null);
    const c = good();
    (c.messages[0] as { content: unknown }).content = { x: 1 };
    assert.equal(parseChat(c), null);
    const d = good();
    d.messages[1].id = d.messages[0].id;
    assert.equal(parseChat(d), null);
  });
  it("rejects non-objects and missing parts", () => {
    assert.equal(parseChat(null), null);
    assert.equal(parseChat("x"), null);
    assert.equal(parseChat({ chat: { id: "chat_0123456789abcdef", title: "t" } }), null);
    assert.equal(parseChat({ chat: { id: "chat_0123456789abcdef" }, messages: [] }), null);
  });
  it("coerces odd timestamps and trims the title", () => {
    const c = good();
    (c.chat as { createdAt: unknown }).createdAt = "yesterday";
    (c.messages[0] as { createdAt: unknown }).createdAt = Infinity;
    c.chat.title = "x".repeat(500);
    const p = parseChat(c)!;
    assert.ok(p.chat.createdAt > 0);
    assert.equal(p.messages[0].createdAt, 0);
    assert.equal(p.chat.title.length, 200);
  });
});
