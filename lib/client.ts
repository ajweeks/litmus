"use client";

import type { ChatDetail, Settings, StreamEvent } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ApiKeys, Provider } from "./providers";

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

/** One header per stored key: x-key-anthropic, x-key-openai, ... */
export function authHeaders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(loadKeys())
      .filter(([, k]) => k)
      .map(([p, k]) => [`x-key-${p}`, k!]),
  );
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
export async function streamChat(
  body: ReturnType<typeof chatPayload> & { content?: string; correctionRequest?: boolean; settings: Settings },
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/chat", {
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
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}
