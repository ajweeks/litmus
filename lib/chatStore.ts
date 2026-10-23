"use client";

// Chat history lives only in this browser, in IndexedDB. The server keeps a chat just for the
// length of a request, so this store is the record: every streamed event is applied here, whether
// or not that chat is on screen, and written back shortly after.
//
// If IndexedDB is unavailable (some private windows), chats still work but last only for the tab.

import type { ChatDetail, ChatSummary, Claim } from "./types";

const DB_NAME = "factcheck";
const STORE = "chats";
const WRITE_DELAY_MS = 400;

const cache = new Map<string, ChatDetail>();
const listeners = new Set<() => void>();
const dirty = new Set<string>();
let version = 0;
let loading: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "chat.id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
let dbPromise: Promise<IDBDatabase | null> | null = null;
const db = () => (dbPromise ??= openDb());

function notify() {
  version++;
  listeners.forEach((fn) => fn());
}

/** Read every stored chat into memory (once). */
export function load(): Promise<void> {
  return (loading ??= (async () => {
    const d = await db();
    if (!d) return;
    const all = await new Promise<ChatDetail[]>((resolve) => {
      try {
        const req = d.transaction(STORE).objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as ChatDetail[]);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    // Anything already changed in this tab wins over what was on disk.
    for (const c of all) if (!cache.has(c.chat.id)) cache.set(c.chat.id, c);
    notify();
  })());
}

async function flush() {
  flushTimer = null;
  const ids = [...dirty];
  dirty.clear();
  const d = await db();
  if (!d || !ids.length) return;
  try {
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const id of ids) {
      const c = cache.get(id);
      if (c) store.put(c);
      else store.delete(id);
    }
  } catch (err) {
    console.error("Couldn't save chats:", err);
  }
}

function schedule(id: string) {
  dirty.add(id);
  flushTimer ??= setTimeout(flush, WRITE_DELAY_MS);
}

if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    if (flushTimer) clearTimeout(flushTimer);
    void flush();
  });

export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getVersion = () => version;

export const getChat = (id: string): ChatDetail | undefined => cache.get(id);

export const listChats = (): ChatSummary[] =>
  [...cache.values()].map((c) => c.chat).sort((a, b) => b.updatedAt - a.updatedAt);

/** Every claim in every stored chat, newest first (for the claims page). */
export const allClaims = (): Claim[] =>
  [...cache.values()].flatMap((c) => c.claims).sort((a, b) => b.createdAt - a.createdAt);

/** Change one chat. Updates must return new objects, never mutate, so views re-render. */
export function updateChat(id: string, fn: (d: ChatDetail) => ChatDetail, create?: ChatSummary) {
  const current = cache.get(id) ?? (create ? { chat: create, messages: [], claims: [] } : undefined);
  if (!current) return;
  cache.set(id, fn(current));
  schedule(id);
  notify();
}

export function deleteChat(id: string) {
  cache.delete(id);
  schedule(id);
  notify();
}

/** Insert or replace a claim, keeping the rest of the chat as it is. */
export const upsertClaim = (d: ChatDetail, claim: Claim): ChatDetail => {
  const i = d.claims.findIndex((c) => c.id === claim.id);
  return { ...d, claims: i < 0 ? [...d.claims, claim] : d.claims.map((c, j) => (j === i ? claim : c)) };
};

/** Spend across every stored chat: the answering model and the fact-checking, separately. */
export function totalUsage() {
  const all = [...cache.values()];
  const messages = all.flatMap((c) => c.messages);
  return {
    chats: all.length,
    mainUsd: messages.reduce((n, m) => n + (m.usage?.costUsd ?? 0), 0),
    checkUsd:
      messages.reduce((n, m) => n + (m.usage?.checkCostUsd ?? 0), 0) +
      all.flatMap((c) => c.claims).reduce((n, c) => n + c.costUsd, 0),
  };
}
