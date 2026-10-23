// A chat sent by the browser is held in the database only while requests for it are running,
// then forgotten (its claims stay in the shared cache).

import * as db from "./db";
import type { ChatMessage, ChatSummary } from "./types";

export interface ChatPayload {
  chat: ChatSummary;
  messages: Pick<ChatMessage, "id" | "role" | "content" | "kind" | "model" | "createdAt">[];
}

const MAX_MESSAGES = 1000;
const MAX_CHARS = 2_000_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate the chat the browser sent; returns null if it's malformed. */
export function parseChat(raw: unknown): ChatPayload | null {
  const p = raw as Partial<ChatPayload> | null;
  const c = p?.chat;
  if (!c || !ID.test(c.id ?? "") || typeof c.title !== "string" || !Array.isArray(p.messages)) return null;
  if (p.messages.length > MAX_MESSAGES) return null;
  let chars = 0;
  const messages: ChatPayload["messages"] = [];
  for (const m of p.messages) {
    if (!m || !ID.test(m.id ?? "") || typeof m.content !== "string") return null;
    if (!["user", "assistant", "system"].includes(m.role)) return null;
    if (!["normal", "corrections", "correction_request"].includes(m.kind)) return null;
    chars += m.content.length;
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      kind: m.kind,
      model: typeof m.model === "string" ? m.model : null,
      createdAt: Number(m.createdAt) || 0,
    });
  }
  if (chars > MAX_CHARS) return null;
  const now = Date.now();
  return {
    chat: { id: c.id, title: c.title.slice(0, 200), createdAt: Number(c.createdAt) || now, updatedAt: now },
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
