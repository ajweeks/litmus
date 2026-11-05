import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installCassette, normalizeBody, requestKey, routeOf } from "../replay";

describe("cassette", () => {
  let uninstall = () => {};
  afterEach(() => uninstall());

  it("normalises dates, ids and timestamps so keys survive a re-run", () => {
    const a = normalizeBody('{"d":"2026-11-05","id":"clm_0123456789abcdef","t":1700000000000}');
    const b = normalizeBody('{"d":"2027-01-01","id":"clm_fedcba9876543210","t":1700000099999}');
    assert.equal(a, b);
    assert.equal(
      requestKey({ method: "POST", url: "https://x/y", body: a }),
      requestKey({ method: "POST", url: "https://x/y", body: b }),
    );
  });

  it("describes a call by model, streaming and system prompt", () => {
    const r = routeOf({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages?beta=true",
      body: JSON.stringify({ model: "claude-haiku-5-5", stream: true, system: "You are the verifier in an automated fact-checking system." }),
    });
    assert.equal(r, "POST api.anthropic.com/v1/messages [claude-haiku-5-5 | stream | You are the verifier in an automated fac]");
  });

  it("serves exact matches, then predicates, then same-route entries in order, and refuses the rest", async () => {
    const c = installCassette({
      mode: "replay",
      entries: [
        { route: "r", match: (req) => req.body?.includes("two") ?? false, response: { status: 200, headers: {}, body: "second" } },
        { route: "POST x/", response: { status: 200, headers: {}, body: "first-by-route" } },
        { route: "POST x/", response: { status: 200, headers: {}, body: "second-by-route" } },
      ],
    });
    uninstall = c.uninstall;
    assert.equal(await (await fetch("https://x/", { method: "POST", body: "two" })).text(), "second");
    assert.equal(await (await fetch("https://x/", { method: "POST", body: "one" })).text(), "first-by-route");
    assert.equal(await (await fetch("https://x/", { method: "POST", body: "three" })).text(), "second-by-route");
    await assert.rejects(fetch("https://x/", { method: "POST", body: "four" }), /No cassette entry/);
    assert.equal(c.misses.length, 1);
    assert.equal(c.served.length, 3);
  });

  it("picks the recorded call most like the request when several share a route", async () => {
    const entry = (claim: string, body: string) => ({
      route: "POST x/ [same prompt]",
      key: "k" + claim,
      request: { method: "POST", url: "https://x/", body: `{"system":"same prompt","claim":"${claim}"}` },
      response: { status: 200, headers: {}, body },
    });
    const c = installCassette({
      mode: "replay",
      entries: [entry("the moon orbits the earth", "moon"), entry("water boils at one hundred degrees", "water")],
    });
    uninstall = c.uninstall;
    const ask = async (claim: string) =>
      (await fetch("https://x/", { method: "POST", body: `{"system":"same prompt","claim":"${claim}","extra":1}` })).text();
    assert.equal(await ask("water boils at one hundred degrees celsius"), "water");
    assert.equal(await ask("the moon orbits the earth monthly"), "moon");
  });

  it("restores the real fetch on uninstall", () => {
    const real = globalThis.fetch;
    const c = installCassette({ mode: "replay", entries: [] });
    assert.notEqual(globalThis.fetch, real);
    c.uninstall();
    uninstall = () => {};
    assert.equal(globalThis.fetch, real);
  });
});
