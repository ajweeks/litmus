// Record-and-replay for every outbound HTTP call the server makes (model providers, triage,
// source pages). Installed over globalThis.fetch, which the Anthropic SDK and the plain-fetch
// provider modules all resolve at call time, so no app code needs to know it's under test.
//
// Modes (LITMUS_CASSETTE_MODE, default "replay"):
//   replay  - serve recorded responses; an unknown request throws, so a test can never go online.
//   record  - make the real call, store it, and serve the stored copy (needs real keys).
//   auto    - replay what's recorded, record what isn't.
//
// Matching, in order: an exact match on the normalised request (method, URL, body with dates
// and ids blanked); a hand-written `match` predicate; then the next unused entry for the same
// "route" (method, host, path and a short signature of the body: the model, whether it streams,
// and the start of the system prompt). The route fallback keeps cassettes usable across prompt
// edits; re-record when a test's calls change shape.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Mode = "replay" | "record" | "auto";

export interface RecordedRequest {
  method: string;
  url: string;
  /** The body as sent, with secrets redacted; null for bodiless requests. */
  body: string | null;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CassetteEntry {
  route: string;
  /** Hash of the normalised request. Hand-written entries may omit it. */
  key?: string;
  /** Hand-written entries can match on the request instead of a key. */
  match?: (req: RecordedRequest) => boolean;
  request?: RecordedRequest;
  response: RecordedResponse;
}

interface StoredEntry {
  route: string;
  key: string;
  request: RecordedRequest;
  response: RecordedResponse;
}

export interface Cassette {
  /** Stop intercepting and, in record mode, write the file. */
  uninstall(): void;
  /** Requests that reached the real network (record/auto) or were refused (replay). */
  misses: RecordedRequest[];
  /** Every request served, in order. */
  served: { request: RecordedRequest; route: string }[];
}

const SECRET_KEYS = /("(?:api_?key|key|authorization|token|secret)"\s*:\s*")[^"]*(")/gi;

/** Blank out the parts of a request that change from run to run without changing its meaning. */
export function normalizeBody(body: string | null): string {
  if (body === null) return "";
  return body
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/\b(?:clm|msg|chat|src|tmp)_[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\b1[6-9]\d{11}\b/g, "<ts>"); // epoch milliseconds
}

export function requestKey(req: RecordedRequest): string {
  return createHash("sha256").update(`${req.method} ${req.url}\n${normalizeBody(req.body)}`).digest("hex").slice(0, 24);
}

/** A coarse description of what the request is for: enough to tell an extractor call from a verifier call. */
export function routeOf(req: RecordedRequest): string {
  let sig = "";
  if (req.body) {
    try {
      const j = JSON.parse(req.body) as Record<string, unknown>;
      const model = typeof j.model === "string" ? j.model : "";
      const stream = j.stream === true ? "stream" : "";
      const system =
        typeof j.system === "string" ? j.system : typeof j.instructions === "string" ? j.instructions : systemOf(j);
      sig = [model, stream, system.slice(0, 40)].filter(Boolean).join(" | ");
    } catch {
      sig = "";
    }
  }
  const u = new URL(req.url);
  return `${req.method} ${u.host}${u.pathname}${sig ? ` [${sig}]` : ""}`;
}

/** The system prompt of OpenAI-style and Gemini bodies. */
function systemOf(j: Record<string, unknown>): string {
  const messages = j.messages as { role?: string; content?: unknown }[] | undefined;
  const sys = messages?.find((m) => m.role === "system");
  if (sys && typeof sys.content === "string") return sys.content;
  const gem = (j.systemInstruction as { parts?: { text?: string }[] } | undefined)?.parts?.[0]?.text;
  return gem ?? "";
}

/** The words of a normalised body, for comparing requests that differ only in detail. */
const words = (body: string | null) => new Set(normalizeBody(body).toLowerCase().split(/[^a-z0-9<>]+/).filter((w) => w.length > 2));

/**
 * Of several recorded calls of the same kind (say, the verifier run on each claim of a reply),
 * the one whose body shares the most words with this request: with concurrent calls the order
 * of a replay can differ from the recording, and this keeps each verdict with its claim.
 */
function closest(req: RecordedRequest, candidates: CassetteEntry[]): CassetteEntry | undefined {
  if (candidates.length < 2) return candidates[0];
  const mine = words(req.body);
  let best: CassetteEntry | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const theirs = words(c.request?.body ?? null);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const score = shared / (mine.size + theirs.size - shared || 1);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function redact(body: string | null): string | null {
  return body === null ? null : body.replace(SECRET_KEYS, "$1<redacted>$2");
}

async function describe(input: RequestInfo | URL, init?: RequestInit): Promise<RecordedRequest> {
  if (input instanceof Request) {
    const body = init?.body ?? (input.method !== "GET" && input.method !== "HEAD" ? await input.clone().text() : null);
    return { method: (init?.method ?? input.method).toUpperCase(), url: input.url, body: redact(await bodyText(body)) };
  }
  const url = typeof input === "string" ? input : input.toString();
  return { method: (init?.method ?? "GET").toUpperCase(), url, body: redact(await bodyText(init?.body ?? null)) };
}

async function bodyText(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBuffer);
  return await new Response(body).text();
}

function toResponse(r: RecordedResponse): Response {
  return new Response(r.body, { status: r.status, headers: r.headers });
}

const KEPT_HEADERS = ["content-type", "request-id", "x-request-id", "location"];

export function installCassette(opts: { file?: string; entries?: CassetteEntry[]; mode?: Mode } = {}): Cassette {
  const mode: Mode = opts.mode ?? ((process.env.LITMUS_CASSETTE_MODE as Mode) || "replay");
  const realFetch = globalThis.fetch;
  const entries: CassetteEntry[] = [...(opts.entries ?? [])];
  if (opts.file && fs.existsSync(opts.file)) entries.push(...(JSON.parse(fs.readFileSync(opts.file, "utf8")) as StoredEntry[]));
  const used = new Set<CassetteEntry>();
  const recorded: StoredEntry[] = [];
  const misses: RecordedRequest[] = [];
  const served: Cassette["served"] = [];

  const find = (req: RecordedRequest, key: string, route: string): CassetteEntry | undefined => {
    const fresh = entries.filter((e) => !used.has(e));
    return (
      fresh.find((e) => e.key === key) ??
      fresh.find((e) => e.match?.(req)) ??
      closest(req, fresh.filter((e) => e.route === route && !e.match)) ??
      entries.find((e) => e.key === key) ??
      entries.find((e) => e.match?.(req))
    );
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = await describe(input, init);
    const key = requestKey(req);
    const route = routeOf(req);
    const hit = find(req, key, route);
    if (hit) {
      used.add(hit);
      served.push({ request: req, route });
      return toResponse(hit.response);
    }
    if (mode === "replay") {
      misses.push(req);
      throw new Error(
        `No cassette entry for ${route} (key ${key}). Add a fixture, or run with LITMUS_CASSETTE_MODE=record and real keys.`,
      );
    }
    misses.push(req);
    const res = await realFetch(input, init);
    const headers: Record<string, string> = {};
    for (const h of KEPT_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    const body = await res.text();
    const entry: StoredEntry = { route, key, request: req, response: { status: res.status, headers, body } };
    entries.push(entry);
    used.add(entry);
    recorded.push(entry);
    served.push({ request: req, route });
    return toResponse(entry.response);
  }) as typeof fetch;

  return {
    misses,
    served,
    uninstall() {
      globalThis.fetch = realFetch;
      if (opts.file && recorded.length) {
        const all = entries.filter((e): e is StoredEntry => !!e.key && !!e.request && !e.match);
        fs.mkdirSync(path.dirname(opts.file), { recursive: true });
        fs.writeFileSync(opts.file, JSON.stringify(all, null, 2) + "\n");
      }
    },
  };
}
