import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateProviders, detectProvider, keyProblem, maskKey } from "../../lib/providers";
import { isCheckerModel, isMainModel, isOpenRouterModel, modelLabel, providerOf } from "../../lib/models";
import { isValidTriageModel, triageProvider } from "../../lib/triage";
import { errorDetail, statusMessage } from "../../lib/sse";

describe("providers", () => {
  it("recognises key shapes", () => {
    assert.equal(detectProvider("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "anthropic");
    assert.equal(detectProvider("sk-or-v1-abcdefghijklmnopqrstuvwxyz"), "openrouter");
    assert.equal(detectProvider("xai-abcdefghijklmnopqrstuvwxyz"), "xai");
    assert.equal(detectProvider("AIzaSyAbcdefghijklmnopqrstuvwxyz"), "google");
    assert.deepEqual(candidateProviders("sk-" + "a".repeat(32)), ["deepseek", "alibaba"]);
    assert.equal(detectProvider("sk-" + "a".repeat(32)), null);
    assert.equal(detectProvider("sk-proj-abcdefghijklmnopqrstuvwxyz"), "openai");
  });
  it("explains why a paste isn't a key", () => {
    assert.ok(keyProblem("has space in it and is long"));
    assert.ok(keyProblem("short"));
    assert.ok(keyProblem("é" + "a".repeat(30)));
    assert.equal(keyProblem("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), null);
  });
  it("masks all but the prefix and tail", () => {
    const masked = maskKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    assert.ok(masked.startsWith("sk-ant-"));
    assert.ok(masked.endsWith("wxyz"));
    assert.ok(!masked.includes("api03"));
  });
});

describe("models", () => {
  it("knows roles and providers", () => {
    assert.ok(isMainModel("claude-opus-5-5"));
    assert.ok(!isCheckerModel("claude-opus-5-5"));
    assert.ok(isCheckerModel("claude-haiku-5-5"));
    assert.ok(!isCheckerModel("nvidia/nemotron-3-super-120b-a12b"));
    assert.equal(providerOf("gemini-3.8-flash"), "google");
    assert.equal(providerOf("openrouter:x/y"), "openrouter");
  });
  it("validates OpenRouter ids strictly", () => {
    assert.ok(isOpenRouterModel("openrouter:openai/gpt-6-luna"));
    assert.ok(isOpenRouterModel("openrouter:~typesafe/jev-latest"));
    assert.ok(!isOpenRouterModel("openrouter:nope"));
    assert.ok(!isOpenRouterModel("openrouter:a/b c"));
    assert.ok(!isOpenRouterModel("openrouter:" + "a/".repeat(80)));
  });
  it("labels models for people", () => {
    assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
    assert.equal(modelLabel("~typesafe/jev-latest"), "Jev");
    assert.equal(modelLabel("openai/gpt-6-luna"), "GPT-6 Luna");
    assert.equal(modelLabel("deepseek-v4-pro"), "DeepSeek V4 Pro");
  });
});

describe("triage ids", () => {
  it("accepts vendor/model and bare jev ids, rejects anything else", () => {
    assert.ok(isValidTriageModel(""));
    assert.ok(isValidTriageModel("~typesafe/jev-latest"));
    assert.ok(isValidTriageModel("perplexity/pplx-decider-v1.2"));
    assert.ok(!isValidTriageModel("x y"));
    assert.ok(!isValidTriageModel("a".repeat(101)));
    assert.equal(triageProvider("jev-latest"), "typesafe");
    assert.equal(triageProvider("~typesafe/jev-latest"), "openrouter");
  });
});

describe("provider errors", () => {
  it("extracts the message from the formats providers use", () => {
    assert.equal(errorDetail('{"error":{"message":"bad key"}}'), "bad key");
    assert.equal(errorDetail('{"error":"nope"}'), "nope");
    assert.equal(errorDetail('{"detail":[{"msg":"a"},{"msg":"b"}]}'), "a; b");
    assert.equal(errorDetail("<html><b>502</b> Bad Gateway</html>"), "502 Bad Gateway");
    assert.equal(errorDetail("x".repeat(1000)).length, 300);
  });
  it("writes a plain sentence per status", () => {
    assert.match(statusMessage("OpenAI", 401, ""), /didn't accept the API key/);
    assert.match(statusMessage("OpenAI", 418, '{"error":{"message":"teapot"}}'), /\(418\): teapot/);
  });
});
