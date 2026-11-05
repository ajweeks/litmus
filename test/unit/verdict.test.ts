import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVerdict } from "../../lib/factcheck";

describe("parseVerdict", () => {
  it("accepts a complete verdict", () => {
    const v = parseVerdict({
      verdict: "refuted",
      importance: "major",
      volatility: "stable",
      confidence: 0.95,
      summary: "Wrong year.",
      correction: "It was **1889**.",
      sources: [{ url: "https://a.example/x", title: "A", quote: "q", stance: "contradicts" }],
    });
    assert.equal(v.verdict, "refuted");
    assert.equal(v.sources.length, 1);
  });
  it("rejects an unknown verdict rather than storing it", () => {
    assert.throws(() => parseVerdict({ verdict: "SUPPORTED", importance: "minor", volatility: "slow", confidence: 1, summary: "", correction: "", sources: [] }));
    assert.throws(() => parseVerdict("nope"));
    assert.throws(() => parseVerdict(null));
  });
  it("falls back for malformed secondary fields", () => {
    const v = parseVerdict({ verdict: "supported", importance: "huge", volatility: 3, confidence: "0.7", summary: null, correction: 5, sources: "x" });
    assert.equal(v.importance, "minor");
    assert.equal(v.volatility, "slow");
    assert.equal(v.confidence, 0.7);
    assert.equal(v.summary, "");
    assert.deepEqual(v.sources, []);
  });
  it("clamps confidence and treats NaN as unknown", () => {
    assert.equal(parseVerdict({ verdict: "supported", confidence: 7 }).confidence, 1);
    assert.equal(parseVerdict({ verdict: "supported", confidence: -1 }).confidence, 0);
    assert.equal(parseVerdict({ verdict: "supported", confidence: "abc" }).confidence, 0.5);
  });
  it("drops non-web and duplicate sources and keeps at most three", () => {
    const v = parseVerdict({
      verdict: "supported",
      sources: [
        { url: "javascript:alert(1)", title: "x", quote: "", stance: "supports" },
        { url: "https://a.example/1", title: "a", quote: "", stance: "supports" },
        { url: "https://a.example/1", title: "dup", quote: "", stance: "supports" },
        { url: "https://a.example/2", title: "b", quote: "", stance: "nonsense" },
        { url: "https://a.example/3", title: "c", quote: "", stance: "context" },
        { url: "https://a.example/4", title: "d", quote: "", stance: "context" },
      ],
    });
    assert.deepEqual(
      v.sources.map((s) => s.url),
      ["https://a.example/1", "https://a.example/2", "https://a.example/3"],
    );
    assert.equal(v.sources[1].stance, "context");
  });
});
