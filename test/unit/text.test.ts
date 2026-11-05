import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locate, normalize } from "../../lib/text";
import { createChunker, quoteKey, semaphore } from "../../lib/factcheck";
import { isHttpUrl, withTextFragment } from "../../lib/links";
import { htmlToText } from "../../lib/sources";
import { fuzzyMatcher } from "../../lib/fuzzy";

describe("locate", () => {
  it("finds a quote across markdown, smart quotes and whitespace", () => {
    const text = "The **Eiffel Tower** is\n330 metres tall, “roughly”.";
    const at = locate(text, 'eiffel tower is 330 metres tall, "roughly"')!;
    assert.ok(at);
    assert.equal(text.slice(...at), "Eiffel Tower** is\n330 metres tall, “roughly”");
  });
  it("returns null for a missing or empty quote", () => {
    assert.equal(locate("abc", "xyz"), null);
    assert.equal(locate("abc", "**"), null);
  });
  it("searches from an offset", () => {
    const text = "cat dog cat";
    assert.deepEqual(locate(text, "cat", 1), [8, 11]);
  });
  it("normalises consistently", () => {
    assert.equal(normalize("  A  *b*\tC "), "a b c");
    assert.equal(quoteKey("  Hello   World "), "hello world");
  });
});

describe("createChunker", () => {
  /** Feed the text in pieces the way a stream would, collecting every passage. */
  const run = (text: string, step = 5, min = 20) => {
    const c = createChunker(min);
    const out: [number, number][] = [];
    for (let i = step; i <= text.length + step; i += step) {
      const r = c.next(text.slice(0, i));
      if (r) out.push(r);
    }
    const rest = c.rest(text);
    if (rest) out.push(rest);
    return out;
  };

  it("cuts at paragraph breaks once the minimum size is reached and covers everything", () => {
    const text = "First paragraph with enough words.\n\nSecond paragraph, also long enough.\n\nThird.";
    const ranges = run(text);
    assert.equal(ranges[0][0], 0);
    assert.equal(ranges[ranges.length - 1][1], text.length);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1]);
    assert.ok(ranges.length >= 2);
    assert.ok(text.slice(...ranges[0]).startsWith("First paragraph"));
  });

  it("never cuts inside a code fence", () => {
    const text = "Intro paragraph that is long enough to pass the minimum.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code.";
    const ranges = run(text);
    for (const r of ranges) {
      const piece = text.slice(...r);
      const fences = (piece.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `passage splits a fence: ${JSON.stringify(piece)}`);
    }
  });

  it("matches a full-text scan however the text is fed", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(10)).join("\n\n");
    const a = run(text, 1, 60);
    const b = run(text, 500, 60);
    const c = run(text, 37, 60);
    // Different delta sizes can choose different boundaries, but every result must tile the text.
    for (const ranges of [a, b, c]) {
      assert.equal(ranges[0][0], 0);
      assert.equal(ranges[ranges.length - 1][1], text.length);
      for (const r of ranges.slice(0, -1)) assert.ok(text.slice(r[1] - 2, r[1]).includes("\n"), "cut is at a blank line");
    }
  });

  it("returns nothing for empty text", () => {
    const c = createChunker();
    assert.equal(c.next(""), null);
    assert.equal(c.rest(""), null);
  });
});

describe("semaphore", () => {
  it("never runs more than the limit at once", async () => {
    const run = semaphore(2);
    let active = 0;
    let peak = 0;
    const job = () =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, job));
    assert.equal(peak, 2);
    assert.equal(active, 0);
  });
  it("releases the slot when a job throws", async () => {
    const run = semaphore(1);
    await assert.rejects(run(async () => Promise.reject(new Error("x"))));
    assert.equal(await run(async () => 42), 42);
  });
});

describe("links", () => {
  it("only accepts web URLs", () => {
    assert.ok(isHttpUrl("https://a.example/x"));
    assert.ok(!isHttpUrl("javascript:alert(1)"));
    assert.ok(!isHttpUrl("data:text/html,hi"));
    assert.ok(!isHttpUrl("not a url"));
  });
  it("builds a text fragment and refuses non-web targets", () => {
    assert.equal(withTextFragment("javascript:alert(1)", "x"), "#");
    assert.equal(withTextFragment("https://a.example/p", ""), "https://a.example/p");
    assert.equal(withTextFragment("https://a.example/p", "a b-c"), "https://a.example/p#:~:text=a%20b%2Dc");
    const long = withTextFragment("https://a.example/p", "one two three four five six seven eight nine ten eleven twelve");
    assert.equal(long, "https://a.example/p#:~:text=one%20two%20three%20four,nine%20ten%20eleven%20twelve");
  });
});

describe("htmlToText", () => {
  it("drops scripts and tags, decodes entities", () => {
    const t = htmlToText("<p>A &amp; B</p><script>evil()</script><div>C&#39;s &lt;3</div>");
    assert.match(t, /A & B/);
    assert.match(t, /C's <3/);
    assert.ok(!t.includes("evil"));
  });
});

describe("fuzzyMatcher", () => {
  it("matches every word in any order with small typos", () => {
    const m = fuzzyMatcher("tower eifel");
    assert.ok(m("The Eiffel Tower is tall"));
    assert.ok(!m("The Tower of London"));
    assert.ok(fuzzyMatcher("")("anything"));
  });
});
