// Request parsing shared by the API routes: bounded JSON bodies, settings validation and the
// id formats the routes accept. Every value a route reads from a request goes through here or
// through lib/session.ts, so a malformed request gets a 4xx rather than a stack trace.

import { LIMITS } from "./config";
import { isCheckerModel, isMainModel } from "./models";
import { PROVIDER_IDS, type Provider } from "./providers";
import { isValidTriageModel } from "./triage";
import type { Importance, Settings, Strictness } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const jsonError = (message: string, status = 400) => Response.json({ error: message }, { status });

/** Ids the browser mints (chats, messages) and the server mints (claims): url-safe, and long enough not to be guessed. */
const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/**
 * Parse a JSON body of at most `maxBytes`. Throws BadRequest for anything else, including an
 * over-long body (413) and a body that isn't a JSON object.
 */
export async function readJson(req: Request, maxBytes = LIMITS.bodyBytes): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BadRequest("Request body too large.", 413);
  if (!req.body) throw new BadRequest("Expected a JSON body.");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BadRequest("Request body too large.", 413);
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(concat(chunks, size)));
  } catch {
    throw new BadRequest("Request body isn't valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const STRICTNESS: Strictness[] = ["facts", "judgments", "critique"];
const IMPORTANCE: Importance[] = ["minor", "moderate", "major"];
export const isImportance = (v: unknown): v is Importance => typeof v === "string" && (IMPORTANCE as string[]).includes(v);

const clamp01 = (x: unknown, fallback: number) =>
  typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;

/**
 * The settings a request may carry, each checked and defaulted. Returns null when a value that
 * would reach a provider or the database is invalid (model ids, strictness, importance, triage model).
 */
export function parseSettings(raw: unknown, opts: { needMain: boolean }): Settings | null {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

  const mainModel = str(r.mainModel, d.mainModel);
  const checkerModel = str(r.checkerModel, d.checkerModel);
  const strictness = str(r.strictness, d.strictness);
  const minImportance = str(r.minImportance, d.minImportance);
  const triageModel = str(r.triageModel, d.triageModel);
  if (opts.needMain && !isMainModel(mainModel)) return null;
  if (!isCheckerModel(checkerModel)) return null;
  if (!(STRICTNESS as string[]).includes(strictness)) return null;
  if (!isImportance(minImportance)) return null;
  if (!isValidTriageModel(triageModel)) return null;

  const strings = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, max) : [];
  return {
    mainModel,
    checkerModel,
    strictness: strictness as Strictness,
    minImportance,
    triageModel,
    triageThreshold: clamp01(r.triageThreshold, d.triageThreshold),
    auditRate: clamp01(r.auditRate, d.auditRate),
    queueCorrections: bool(r.queueCorrections, d.queueCorrections),
    mainTools: bool(r.mainTools, d.mainTools),
    showSupported: bool(r.showSupported, d.showSupported),
    disabledKeys: strings(r.disabledKeys, PROVIDER_IDS.length).filter((p): p is Provider => (PROVIDER_IDS as string[]).includes(p)),
    openrouterModels: strings(r.openrouterModels, 50),
  };
}

/** The `chat` query parameter a claims read must carry: the chat id doubles as the capability to read its claims. */
export function chatParam(req: Request): string | null {
  const v = new URL(req.url).searchParams.get("chat");
  return isId(v) ? v : null;
}
