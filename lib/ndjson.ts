// The NDJSON event stream the chat and check routes answer with. The browser may leave early;
// the work carries on regardless (results land in the claims cache), and nothing it does
// afterwards can throw into the response.

import type { StreamEvent } from "./types";

export interface StreamContext {
  /** Queue an event for the browser; a no-op once it has gone. */
  send: (e: StreamEvent) => void;
  /** Whether the browser is still connected. */
  open: () => boolean;
  /** Report a problem once, however many steps hit it. `messageId` marks it as a failed check of that answer. */
  reportOnce: (message: string, messageId?: string) => void;
}

/**
 * Run `work` against a streaming NDJSON response. `end` is sent when it resolves; an exception
 * becomes an `error` event. `cleanup` always runs last, connected or not.
 */
export function ndjsonResponse(work: (ctx: StreamContext) => Promise<void>, cleanup?: () => void): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const reported = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
        }
      };
      const ctx: StreamContext = {
        send,
        open: () => !closed,
        reportOnce: (message, messageId) => {
          if (reported.has(message)) return;
          reported.add(message);
          send({ type: "error", message, ...(messageId ? { messageId } : {}) });
        },
      };
      try {
        await work(ctx);
      } catch (err) {
        ctx.reportOnce(err instanceof Error ? err.message : String(err));
      } finally {
        try {
          cleanup?.();
        } catch (err) {
          console.error("stream cleanup failed:", err);
        }
      }
      send({ type: "end" });
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
