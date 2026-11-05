import * as db from "@/lib/db";
import { BadRequest, isId, jsonError, parseSettings, readJson } from "@/lib/api";
import { createChunker, createPipeline, quoteKey, summarizeMessage, verifyClaim } from "@/lib/factcheck";
import { llmFromRequest, MissingKeyError } from "@/lib/llm";
import { ndjsonResponse } from "@/lib/ndjson";
import { holdChat, parseChat, releaseChat } from "@/lib/session";
import { triageProvider } from "@/lib/triage";
import type { Claim } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Retry fact-checking one answer: re-verify its claims whose check failed and, if extraction
 * failed, extract again. Streams the same NDJSON events as /api/chat (claim, extracting,
 * summary, error, key_status, end).
 *
 * Body: `{ chat, messages, messageId, reextract?, settings }`.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err instanceof BadRequest) return jsonError(err.message, err.status);
    throw err;
  }
  const settings = parseSettings(body.settings, { needMain: false });
  if (!settings) return jsonError("Invalid settings.");
  const payload = parseChat(body);
  const target = payload && isId(body.messageId) ? payload.messages.find((m) => m.id === body.messageId && m.role === "assistant") : null;
  if (!payload || !target) return jsonError("Invalid chat.");

  const llm = llmFromRequest(req);
  try {
    llm.require(settings.checkerModel);
  } catch (err) {
    if (err instanceof MissingKeyError) return jsonError(err.message, 401);
    throw err;
  }
  holdChat(payload);

  const chatId = payload.chat.id;
  const messageId = target.id;
  const text = target.content;
  const question = payload.messages.filter((m) => m.role === "user" && m.createdAt <= target.createdAt).pop()?.content ?? "";

  return ndjsonResponse(
    async ({ send, reportOnce }) => {
      const report = (message: string) => reportOnce(message, messageId);
      llm.onKeyStatus = (s) => send({ type: "key_status", ...s });

      // Only this chat's claims for this answer: the chat id in the request is what grants access to them.
      const existing = db.listClaims({ chatId, messageId });
      const failed = existing.filter((c) => c.status === "error");
      const work: Promise<unknown>[] = [];

      // Claims whose own check failed: verify them again.
      const context = `User asked: ${question}\n\nAssistant replied (excerpt): ${text.slice(0, 4000)}`;
      for (const c of failed) {
        send({ type: "claim", claim: { ...c, status: "verifying", error: null } });
        work.push(
          verifyClaim({ llm, model: settings.checkerModel, claim: c, context, force: true }).then((done: Claim) => {
            send({ type: "claim", claim: done });
            if (done.status === "error" && done.error) report(`Couldn't check a claim. ${done.error}`);
          }),
        );
      }

      // Extraction failed for some passages: run it over the whole answer, skipping what's already found.
      if (body.reextract === true) {
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
          chatId,
          messageId,
          userQuestion: question,
          emit: (claim) => send({ type: "claim", claim }),
          onExtracting: (active) => send({ type: "extracting", messageId, active }),
          onError: report,
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
    },
    () => releaseChat(chatId),
  );
}
