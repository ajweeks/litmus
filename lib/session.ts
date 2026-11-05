// A chat sent by the browser is held in the database only while requests for it are running,
// then forgotten (its claims stay in the shared cache).
//
// The chat id is minted by the browser and never shown to anyone else, so it doubles as the
// capability to act on that chat's claims: every route that reads or changes claims checks the
// claim's chat id against the one in the request.

import { isId } from "./api";
import { LIMITS } from "./config";
import * as db from "./db";
import type { ChatMessage, ChatSummary } from "./types";

export interface ChatPayload {
  chat: ChatSummary;
  messages: Pick<ChatMessage, "id" | "role" | "content" | "kind" | "model" | "createdAt">[];
}

const ROLES = ["user", "assistant", "system"];
const KINDS = ["normal", "corrections", "correction_request"];

/** A finite timestamp, or `fallback` for anything else (strings, NaN, Infinity). */
const time = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

/** Validate the chat the browser sent; returns null if it's malformed. */
export function parseChat(raw: unknown): ChatPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { chat?: unknown; messages?: unknown };
  const c = p.chat as Partial<ChatSummary> | null | undefined;
  if (!c || typeof c !== "object" || !isId(c.id) || typeof c.title !== "string" || !Array.isArray(p.messages)) return null;
  if (p.messages.length > LIMITS.chatMessages) return null;
  let chars = 0;
  const seen = new Set<string>();
  const messages: ChatPayload["messages"] = [];
  for (const raw of p.messages as unknown[]) {
    const m = raw as Partial<ChatMessage> | null;
    if (!m || typeof m !== "object" || !isId(m.id) || typeof m.content !== "string") return null;
    if (typeof m.role !== "string" || !ROLES.includes(m.role)) return null;
    if (typeof m.kind !== "string" || !KINDS.includes(m.kind)) return null;
    if (seen.has(m.id)) return null;
    seen.add(m.id);
    chars += m.content.length;
    if (chars > LIMITS.chatChars) return null;
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      kind: m.kind,
      model: typeof m.model === "string" ? m.model.slice(0, 200) : null,
      createdAt: time(m.createdAt, 0),
    });
  }
  const now = Date.now();
  return {
    chat: { id: c.id, title: c.title.slice(0, 200), createdAt: time(c.createdAt, now), updatedAt: now },
    messages,
  };
}

const holds = new Map<string, number>();

/** Load the chat for a request. Pair every call with `releaseChat`. */
export function holdChat(p: ChatPayload) {
  db.importChat(p.chat, p.messages);
  holds.set(p.chat.id, (holds.get(p.chat.id) ?? 0) + 1);
}

/** Forget the chat's messages once no request is using them. */
export function releaseChat(id: string) {
  const n = (holds.get(id) ?? 1) - 1;
  if (n > 0) holds.set(id, n);
  else {
    holds.delete(id);
    db.deleteChat(id);
  }
}

/** How many requests currently hold a chat (for tests and diagnostics). */
export const holdCount = (id: string) => holds.get(id) ?? 0;
