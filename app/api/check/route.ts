import * as db from "@/lib/db";
import { createChunker, createPipeline, quoteKey, summarizeMessage, verifyClaim } from "@/lib/factcheck";
import { describeError, llmFromRequest, MissingKeyError } from "@/lib/llm";
import { isCheckerModel } from "@/lib/models";
import { holdChat, parseChat, releaseChat } from "@/lib/session";
import { isValidTriageModel, triageProvider } from "@/lib/triage";
import type { Claim, Settings, StreamEvent } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  chat?: unknown;
  messages?: unknown;
  messageId?: string;
  /** Extraction failed last time, so look for claims again (skipping ones already found). */
  reextract?: boolean;
  settings?: Partial<Settings>;
}

/**
 * Retry fact-checking one answer: re-verify its claims whose check failed and, if extraction
 * failed, extract again. Streams the same NDJSON events as /api/chat (claim, extracting,
 * summary, error, key_status, end).
 */
export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  const settings = { ...DEFAULT_SETTINGS, ...body.settings };
  if (
    !isCheckerModel(settings.checkerModel) ||
    !isValidTriageModel(settings.triageModel) ||
    !["minor", "moderate", "major"].includes(settings.minImportance)
  )
    return Response.json({ error: "Invalid settings." }, { status: 400 });
  const payload = parseChat(body);
  const target = payload?.messages.find((m) => m.id === body.messageId && m.role === "assistant");
  if (!payload || !target) return Response.json({ error: "Invalid chat." }, { status: 400 });

  const llm = llmFromRequest(req);
  try {
    llm.require(settings.checkerModel);
  } catch (err) {
    if (err instanceof MissingKeyError) return Response.json({ error: err.message }, { status: 401 });
    throw err;
  }
  holdChat(payload);

  const messageId = target.id;
  const text = target.content;
  const question = payload.messages.filter((m) => m.role === "user" && m.createdAt <= target.createdAt).pop()?.content ?? "";
  const encoder = new TextEncoder();
  let closed = false;

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
      const reported = new Set<string>();
      const reportOnce = (message: string) => {
        if (reported.has(message)) return;
        reported.add(message);
        send({ type: "error", message, messageId });
      };
      llm.onKeyStatus = (s) => send({ type: "key_status", ...s });

      try {
        const existing = db.listClaims({ messageId });
        const failed = existing.filter((c) => c.status === "error");
        const work: Promise<unknown>[] = [];

        // Claims whose own check failed: verify them again.
        const context = `User asked: ${question}\n\nAssistant replied (excerpt): ${text.slice(0, 4000)}`;
        for (const c of failed) {
          send({ type: "claim", claim: { ...c, status: "verifying", error: null } });
          work.push(
            verifyClaim({ llm, model: settings.checkerModel, claim: c, context, force: true }).then((done: Claim) => {
              send({ type: "claim", claim: done });
              if (done.status === "error" && done.error) reportOnce(`Couldn't check a claim. ${done.error}`);
            }),
          );
        }

        // Extraction failed for some passages: run it over the whole answer, skipping what's already found.
        if (body.reextract) {
          const pipeline = createPipeline({
            llm,
            model: settings.checkerModel,
            strictness: settings.strictness,
            triage: {
              model: settings.triageModel,
              threshold: settings.triageThreshold,
              auditRate: settings.auditRate,
              key: llm.keys[triageProvider(settings.triageModel)] ?? null,
            },
            chatId: payload.chat.id,
            messageId,
            userQuestion: question,
            emit: (claim) => send({ type: "claim", claim }),
            onExtracting: (active) => send({ type: "extracting", messageId, active }),
            onError: reportOnce,
            skipQuotes: new Set(existing.map((c) => quoteKey(c.quote))),
          });
          const chunker = createChunker();
          for (let r = chunker.next(text); r; r = chunker.next(text)) pipeline.addPassage(text.slice(...r), r[0], text);
          const rest = chunker.rest(text);
          if (rest) pipeline.addPassage(text.slice(...rest), rest[0], text);
          work.push(pipeline.finish());
        }

        await Promise.all(work);
        await summarizeMessage({ llm, model: settings.checkerModel, messageId, minImportance: settings.minImportance });
        const done = db.getMessage(messageId);
        if (done) send({ type: "summary", message: done });
      } catch (err) {
        reportOnce(describeError(err));
      } finally {
        releaseChat(payload.chat.id);
      }
      send({ type: "end" });
      if (!closed) controller.close();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
