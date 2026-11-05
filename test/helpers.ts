// Shared setup for the tests: an isolated SQLite database per test process, requests shaped
// like the browser's, and a reader for the NDJSON streams the routes answer with.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, StreamEvent } from "../lib/types";

/**
 * Point the app at a fresh database in a temp directory. Must run before the first database
 * call (lib/db.ts opens its file lazily, so importing it first is fine).
 */
export function useTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "litmus-test-"));
  const file = path.join(dir, "factcheck.db");
  process.env.FACTCHECK_DB_PATH = file;
  return file;
}

export const TEST_KEYS = { "x-key-anthropic": "sk-ant-test-0000000000000000" };

/** An id in the format the browser and server mint. */
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** A browser-style chat payload. */
export function chat(id = newId("chat"), messages: Partial<ChatMessage>[] = []) {
  return {
    chat: { id, title: "Test chat", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
    messages: messages.map((m, i) => ({
      id: m.id ?? newId("msg"),
      role: m.role ?? "user",
      content: m.content ?? "",
      kind: m.kind ?? "normal",
      model: m.model ?? null,
      createdAt: m.createdAt ?? 1_700_000_000_000 + i,
    })),
  };
}

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = TEST_KEYS, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every event of an NDJSON response, in order. */
export async function readEvents(res: Response): Promise<StreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StreamEvent);
}

export const ofType = <T extends StreamEvent["type"]>(events: StreamEvent[], type: T) =>
  events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);
