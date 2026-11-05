import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequest, isId, parseSettings, readJson } from "../../lib/api";
import { DEFAULT_SETTINGS } from "../../lib/types";

const req = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("readJson", () => {
  it("parses an object", async () => {
    assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
  });
  it("rejects invalid JSON with a 400", async () => {
    await assert.rejects(readJson(req("{nope")), (e: BadRequest) => e instanceof BadRequest && e.status === 400);
  });
  it("rejects arrays and scalars", async () => {
    await assert.rejects(readJson(req("[1]")), BadRequest);
    await assert.rejects(readJson(req("42")), BadRequest);
    await assert.rejects(readJson(req("null")), BadRequest);
  });
  it("refuses a body over the limit, declared or streamed", async () => {
    await assert.rejects(readJson(req("{}", { "content-length": "999999" }), 100), (e: BadRequest) => e.status === 413);
    const big = "{" + '"k":"' + "x".repeat(500) + '"}';
    await assert.rejects(readJson(req(big), 100), (e: BadRequest) => e.status === 413);
  });
});

describe("parseSettings", () => {
  it("defaults everything when nothing is sent", () => {
    assert.deepEqual(parseSettings(undefined, { needMain: true }), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings("garbage", { needMain: true }), DEFAULT_SETTINGS);
  });
  it("rejects unknown models, strictness, importance and triage ids", () => {
    assert.equal(parseSettings({ mainModel: "gpt-99" }, { needMain: true }), null);
    assert.equal(parseSettings({ checkerModel: "nvidia/nemotron-3-ultra-550b-a55b" }, { needMain: false }), null);
    assert.equal(parseSettings({ strictness: "paranoid" }, { needMain: false }), null);
    assert.equal(parseSettings({ minImportance: "huge" }, { needMain: false }), null);
    assert.equal(parseSettings({ triageModel: "a b; rm -rf" }, { needMain: false }), null);
  });
  it("ignores the main model when the route doesn't use it", () => {
    assert.equal(parseSettings({ mainModel: "gpt-99" }, { needMain: false })?.mainModel, "gpt-99");
  });
  it("clamps numbers and drops wrong types", () => {
    const s = parseSettings(
      { triageThreshold: 7, auditRate: -1, queueCorrections: "yes", mainTools: false, disabledKeys: ["openai", "bogus", 3], openrouterModels: "x" },
      { needMain: false },
    )!;
    assert.equal(s.triageThreshold, 1);
    assert.equal(s.auditRate, 0);
    assert.equal(s.queueCorrections, DEFAULT_SETTINGS.queueCorrections);
    assert.equal(s.mainTools, false);
    assert.deepEqual(s.disabledKeys, ["openai"]);
    assert.deepEqual(s.openrouterModels, []);
  });
  it("accepts OpenRouter ids for either role", () => {
    const s = parseSettings({ mainModel: "openrouter:openai/gpt-6-luna", checkerModel: "openrouter:x/y:free" }, { needMain: true });
    assert.ok(s);
  });
});

describe("isId", () => {
  it("accepts the ids the app mints and rejects short or odd ones", () => {
    assert.ok(isId("chat_0123456789abcdef"));
    assert.ok(isId("clm_0123456789abcdef"));
    assert.ok(!isId("chat_1"));
    assert.ok(!isId("chat 0123456789abcdef"));
    assert.ok(!isId(123));
    assert.ok(!isId("x".repeat(65)));
  });
});
