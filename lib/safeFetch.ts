// Fetching pages the verifier wants to quote from. The URLs come from a model (through a search
// provider), so this is the one place the server makes a request to an address it didn't choose.
// It only speaks http(s) to public addresses, follows redirects one hop at a time with the same
// check, and reads at most a fixed number of bytes.

import { isIP } from "node:net";
import dns from "node:dns/promises";
import { LIMITS } from "./config";

const MAX_REDIRECTS = 5;

/** Address resolution, swappable so offline tests never touch DNS. */
export const resolver = {
  lookup: async (hostname: string): Promise<string[]> => (await dns.lookup(hostname, { all: true })).map((a) => a.address),
};

/** Whether an IP address is private, loopback, link-local, multicast, or otherwise not a public host. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // Not an address at all: treat as unsafe.
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24 (documentation)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // 198.51.100.0/24 documentation
    (a === 203 && b === 0) || // 203.0.113.0/24 documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:XXXX): judge the embedded IPv4 address.
  const dotted = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateV4(dotted[1]);
  const hex = lower.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const head = parseInt(lower.split(":")[0] || "0", 16);
  return (
    head === 0 || // ::/8: unspecified, loopback and reserved
    (head & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (head & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (head & 0xff00) === 0xff00 || // ff00::/8 multicast
    /^2001:db8:/.test(lower) // documentation
  );
}

/** Hostnames that resolve privately by convention, whatever DNS says. */
const PRIVATE_HOST = /(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet)$/i;

/** Why `url` can't be fetched, or null if it looks like a public web address. Doesn't resolve anything. */
export function urlProblem(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "not http(s)";
  if (url.username || url.password) return "has credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return "no host";
  if (PRIVATE_HOST.test(host)) return "private hostname";
  if (isIP(host) && isPrivateAddress(host)) return "private address";
  return null;
}

/** Resolve the host and refuse if any of its addresses is private. */
async function checkUrl(url: URL): Promise<void> {
  const problem = urlProblem(url);
  if (problem) throw new Error(`Refusing to fetch ${url.hostname}: ${problem}.`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let addresses: string[];
  try {
    addresses = await resolver.lookup(host);
  } catch {
    throw new Error(`Couldn't resolve ${host}.`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`Refusing to fetch ${host}: resolves to a private address.`);
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  /** The body, decoded as UTF-8 and cut at `maxBytes`. */
  text: string;
  /** The URL the final response came from, after redirects. */
  url: string;
}

export interface SafeFetchBytesResult {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  /** True when the body was longer than `maxBytes` and was cut (a cut PDF can't be parsed). */
  truncated: boolean;
  url: string;
}

type FetchOpts = { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> };

/** GET with the checks above, following redirects by hand so every hop is checked. */
async function safeGet(input: string, opts: FetchOpts): Promise<{ res: Response; url: URL }> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    await checkUrl(url);
    const res = await fetch(url, { headers: opts.headers, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = new URL(location, url);
      continue;
    }
    return { res, url };
  }
}

/**
 * GET a public URL with the checks above and a hard byte limit on what is read. Throws on
 * anything refused; callers treat that as "couldn't read the page".
 */
export async function safeFetchText(input: string, opts: FetchOpts = {}): Promise<SafeFetchResult> {
  const { res, url } = await safeGet(input, opts);
  const text = await readUpTo(res, opts.maxBytes ?? LIMITS.pageBytes);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, url: url.toString() };
}

/** Like safeFetchText, but the raw bytes (for PDFs). */
export async function safeFetchBytes(input: string, opts: FetchOpts = {}): Promise<SafeFetchBytesResult> {
  const { res, url } = await safeGet(input, opts);
  const maxBytes = opts.maxBytes ?? LIMITS.pageBytes;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes, truncated, url: url.toString() };
}

/** Read a response body as text, stopping after `maxBytes` (the rest is discarded, never buffered). */
export async function readUpTo(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.byteLength >= room) {
      out += decoder.decode(value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => {});
      break;
    }
    size += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
