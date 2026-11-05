import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isPrivateAddress, readUpTo, resolver, safeFetchText, urlProblem } from "../../lib/safeFetch";

describe("isPrivateAddress", () => {
  it("flags loopback, RFC1918, link-local, metadata and reserved ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255"])
      assert.ok(isPrivateAddress(ip), ip);
  });
  it("passes public addresses", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
  });
  it("handles IPv6 loopback, unique-local, link-local and mapped IPv4", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1"])
      assert.ok(isPrivateAddress(ip), ip);
    assert.ok(!isPrivateAddress("::ffff:8.8.8.8"));
  });
  it("treats non-addresses as unsafe", () => {
    assert.ok(isPrivateAddress("not-an-ip"));
  });
});

describe("urlProblem", () => {
  it("only allows plain http(s) to public-looking hosts", () => {
    assert.equal(urlProblem(new URL("https://example.com/a")), null);
    assert.ok(urlProblem(new URL("ftp://example.com/")));
    assert.ok(urlProblem(new URL("file:///etc/passwd")));
    assert.ok(urlProblem(new URL("http://user:pw@example.com/")));
    assert.ok(urlProblem(new URL("http://localhost:3000/")));
    assert.ok(urlProblem(new URL("http://db.internal/")));
    assert.ok(urlProblem(new URL("http://127.0.0.1/")));
    assert.ok(urlProblem(new URL("http://[::1]/")));
    assert.ok(urlProblem(new URL("http://169.254.169.254/latest/meta-data/")));
  });
});

describe("safeFetchText", () => {
  const realFetch = globalThis.fetch;
  const realLookup = resolver.lookup;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resolver.lookup = realLookup;
  });

  it("refuses hosts that resolve to private addresses without calling fetch", async () => {
    resolver.lookup = async () => ["10.0.0.5"];
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("x");
    }) as typeof fetch;
    await assert.rejects(safeFetchText("https://evil.example/"), /private/);
    assert.equal(called, false);
  });

  it("follows redirects with the same check on every hop", async () => {
    resolver.lookup = async (host) => (host === "public.example" ? ["93.184.216.34"] : ["127.0.0.1"]);
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      seen.push(url);
      if (url === "https://public.example/a") return new Response(null, { status: 302, headers: { location: "/b" } });
      if (url === "https://public.example/b") return new Response(null, { status: 302, headers: { location: "http://intranet.example/" } });
      return new Response("should not get here");
    }) as typeof fetch;
    await assert.rejects(safeFetchText("https://public.example/a"), /private/);
    assert.deepEqual(seen, ["https://public.example/a", "https://public.example/b"]);
  });

  it("returns the body, cut at the byte limit", async () => {
    resolver.lookup = async () => ["93.184.216.34"];
    globalThis.fetch = (async () => new Response("abcdefghij", { headers: { "content-type": "text/plain" } })) as typeof fetch;
    const r = await safeFetchText("https://public.example/", { maxBytes: 4 });
    assert.equal(r.text, "abcd");
    assert.equal(r.contentType, "text/plain");
  });

  it("gives up after too many redirects", async () => {
    resolver.lookup = async () => ["93.184.216.34"];
    globalThis.fetch = (async () => new Response(null, { status: 301, headers: { location: "/again" } })) as typeof fetch;
    await assert.rejects(safeFetchText("https://public.example/"), /redirects/);
  });
});

describe("readUpTo", () => {
  it("stops reading a long stream at the limit", async () => {
    const chunks = ["12345", "67890", "abcde"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    assert.equal(await readUpTo(new Response(body), 7), "1234567");
    assert.equal(await readUpTo(new Response("short"), 100), "short");
  });
});
