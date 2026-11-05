"use client";

import type { ChatDetail, Claim, Settings, StreamEvent } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { clearAll as clearChats } from "./chatStore";
import type { ApiKeys, Provider } from "./providers";
import { enabledKeys } from "./providers";

// API keys live only in this browser's localStorage and are sent with each request.
const KEYS_STORAGE = "factcheck.keys";
// Single-key storage from before multi-provider support; read once and folded into KEYS_STORAGE.
const LEGACY_KEYS: [string, Provider][] = [
  ["factcheck.apiKey", "anthropic"],
  ["factcheck.openrouterKey", "openrouter"],
];
const SETTINGS_STORAGE = "factcheck.settings";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode etc.); settings just won't persist.
  }
}

export function loadKeys(): ApiKeys {
  let keys: ApiKeys = {};
  try {
    keys = JSON.parse(read(KEYS_STORAGE) ?? "{}");
  } catch {
    // Corrupt entry: start over.
  }
  const legacy = LEGACY_KEYS.filter(([name]) => read(name));
  if (legacy.length) {
    for (const [name, provider] of legacy) keys[provider] ||= read(name)!;
    saveKeys(keys);
    legacy.forEach(([name]) => write(name, null));
  }
  return keys;
}

export function saveKeys(keys: ApiKeys) {
  const clean = Object.fromEntries(Object.entries(keys).filter(([, v]) => v?.trim()));
  write(KEYS_STORAGE, Object.keys(clean).length ? JSON.stringify(clean) : null);
}

export function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(read(SETTINGS_STORAGE) ?? "{}") };
    // "Only major errors" is no longer offered; fold it into the default.
    if (s.strictness === "facts" && s.minImportance === "major") s.minImportance = "moderate";
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export const saveSettings = (s: Settings) => write(SETTINGS_STORAGE, JSON.stringify(s));

const SIDEBAR_STORAGE = "factcheck.sidebar";
export function loadSidebar(): { width: number; collapsed: boolean } {
  try {
    const v = JSON.parse(read(SIDEBAR_STORAGE) ?? "{}");
    return { width: Number(v.width) || 236, collapsed: !!v.collapsed };
  } catch {
    return { width: 236, collapsed: false };
  }
}
export const saveSidebar = (v: { width: number; collapsed: boolean }) => write(SIDEBAR_STORAGE, JSON.stringify(v));

/** One header per stored, switched-on key: x-key-anthropic, x-key-openai, ... */
export function authHeaders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(enabledKeys(loadKeys(), loadSettings().disabledKeys)).map(([p, k]) => [`x-key-${p}`, k!]),
  );
}

/** Forget this browser's keys and settings, and optionally every saved chat. */
export async function clearLocalData(opts: { chats: boolean }) {
  for (const k of [KEYS_STORAGE, SETTINGS_STORAGE, SIDEBAR_STORAGE, KEY_FAILURES_STORAGE, ...LEGACY_KEYS.map(([name]) => name)])
    write(k, null);
  if (opts.chats) await clearChats();
}

/**
 * The chat as the server needs it for a request: chat history is kept only in this browser, so
 * it's sent along each time. Only what the model and checker need, not thinking or usage.
 */
export function chatPayload(d: ChatDetail) {
  return {
    chat: d.chat,
    messages: d.messages
      .filter((m) => !m.id.startsWith("tmp_"))
      .map(({ id, role, content, kind, model, createdAt }) => ({ id, role, content, kind, model, createdAt })),
  };
}

/** POST /api/chat and call `onEvent` for each NDJSON event until the stream ends. */
export const streamChat = (
  body: ReturnType<typeof chatPayload> & { content?: string; correctionRequest?: boolean; settings: Settings },
  onEvent: (e: StreamEvent) => void,
) => streamEvents("/api/chat", body, onEvent);

/** POST /api/check: retry fact-checking one answer, with the same events as the chat stream. */
export const streamCheck = (
  body: ReturnType<typeof chatPayload> & { messageId: string; reextract: boolean; settings: Settings },
  onEvent: (e: StreamEvent) => void,
) => streamEvents("/api/check", body, onEvent);

async function streamEvents(url: string, body: object, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Request failed");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        continue; // A damaged line shouldn't lose the rest of the stream.
      }
      if (event && typeof event.type === "string") onEvent(event);
    }
  }
}

/** The current state of these claims, for catching up after a reload or dropped connection. Null if the request failed. */
export async function fetchClaims(chatId: string, ids: string[]): Promise<Claim[] | null> {
  const params = new URLSearchParams({ chat: chatId, ids: ids.join(",") });
  const res = await fetch(`/api/claims?${params}`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(body) ? (body as Claim[]) : null;
}

// ---------- keys that didn't work ----------

const KEY_FAILURES_STORAGE = "factcheck.keyFailures";

/** Providers whose key was last rejected, with why and when. Cleared when the key next works. */
export type KeyFailures = Partial<Record<Provider, { message: string; at: number }>>;

export function loadKeyFailures(): KeyFailures {
  try {
    return JSON.parse(read(KEY_FAILURES_STORAGE) ?? "{}");
  } catch {
    return {};
  }
}

export function saveKeyFailures(f: KeyFailures) {
  write(KEY_FAILURES_STORAGE, Object.keys(f).length ? JSON.stringify(f) : null);
}

/** Apply a key status from the server to the stored failures. */
export function withKeyStatus(f: KeyFailures, s: { provider: Provider; ok: boolean; message?: string }): KeyFailures {
  const next = { ...f };
  if (s.ok) delete next[s.provider];
  else next[s.provider] = { message: s.message ?? "The key was rejected.", at: Date.now() };
  return next;
}
