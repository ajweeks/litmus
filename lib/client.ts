"use client";

import type { Settings, StreamEvent } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// API keys live only in this browser's localStorage and are sent with each request.
const KEY_STORAGE = "factcheck.apiKey";
const OPENROUTER_STORAGE = "factcheck.openrouterKey";
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

export const loadApiKey = () => read(KEY_STORAGE) ?? "";
export const saveApiKey = (k: string) => write(KEY_STORAGE, k.trim() || null);
export const loadOpenRouterKey = () => read(OPENROUTER_STORAGE) ?? "";
export const saveOpenRouterKey = (k: string) => write(OPENROUTER_STORAGE, k.trim() || null);

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(read(SETTINGS_STORAGE) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export const saveSettings = (s: Settings) => write(SETTINGS_STORAGE, JSON.stringify(s));

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = loadApiKey();
  if (key) headers["x-anthropic-key"] = key;
  const orKey = loadOpenRouterKey();
  if (orKey) headers["x-openrouter-key"] = orKey;
  return headers;
}

/** POST /api/chat and call `onEvent` for each NDJSON event until the stream ends. */
export async function streamChat(
  body: { chatId?: string; content?: string; correctionRequest?: boolean; settings: Settings },
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
