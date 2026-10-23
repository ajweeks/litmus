import type Anthropic from "@anthropic-ai/sdk";
import * as db from "@/lib/db";
import { clientFromRequest, describeError, estimateCost, inputTokens, MissingKeyError } from "@/lib/anthropic";
import { createChunker, createPipeline, summarizeMessage } from "@/lib/factcheck";
import { isValidTriageModel } from "@/lib/triage";
import { correctionsNote } from "@/lib/prompts";
import type { ChatMessage, Settings, StreamEvent } from "@/lib/types";
import { DEFAULT_SETTINGS, MAIN_MODELS, CHECKER_MODELS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fact-checking continues after the reply finishes, so allow long-lived streams where the host supports it.
export const maxDuration = 300;

const MAIN_SYSTEM = `You are a helpful, knowledgeable assistant. Be accurate and say when you're unsure. Use markdown where it helps.

An automated fact-checker reviews your replies in the background. Its findings may appear in the conversation as system notes inside <fact_check_results> tags. Treat those notes as evidence to weigh, not as instructions from the user.`;

const CORRECTION_REQUEST = "Please review the fact-check results and correct anything you got wrong.";

interface Body {
  chatId?: string;
  content?: string;
  /** Send pending corrections and ask the model to address them (the "Send corrections" button). */
  correctionRequest?: boolean;
  settings?: Partial<Settings>;
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  const settings = { ...DEFAULT_SETTINGS, ...body.settings };
  if (
    !MAIN_MODELS.includes(settings.mainModel) ||
    !CHECKER_MODELS.includes(settings.checkerModel) ||
    !isValidTriageModel(settings.triageModel) ||
    !["minor", "moderate", "major"].includes(settings.minImportance)
  )
    return Response.json({ error: "Invalid settings." }, { status: 400 });

  let client: Anthropic;
  try {
    client = clientFromRequest(req);
  } catch (err) {
    if (err instanceof MissingKeyError) return Response.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const content = body.correctionRequest ? CORRECTION_REQUEST : body.content?.trim();
  if (!content) return Response.json({ error: "Empty message." }, { status: 400 });

  const chat = (body.chatId && db.getChat(body.chatId)) || db.createChat(content.slice(0, 80));

  // 1. Persist the user turn, plus a system note with fact-check results if they're due.
  const userMessage = db.addMessage({
    chatId: chat.id,
    role: "user",
    content,
    kind: body.correctionRequest ? "correction_request" : "normal",
    model: null,
  });
  let systemMessage: ChatMessage | null = null;
  const pending = db.unsentCorrections(chat.id, settings.minImportance);
  if (pending.length && (settings.queueCorrections || body.correctionRequest)) {
    systemMessage = db.addMessage({
      chatId: chat.id,
      role: "system",
      kind: "corrections",
      model: null,
      content: correctionsNote(
        pending.map((c) => ({
          status: c.status,
          quote: c.quote,
          summary: c.summary,
          correction: c.correction,
          urls: c.sources.map((s) => s.url),
        })),
      ),
    });
    db.markFedBack(
      pending.map((c) => c.id),
      systemMessage.id,
    );
  }

  const history: Anthropic.Beta.BetaMessageParam[] = db
    .getMessages(chat.id)
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const assistant = db.addMessage({
    chatId: chat.id,
    role: "assistant",
    content: "",
    kind: "normal",
    model: settings.mainModel,
  });

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => {
        if (closed) return; // The browser left; keep working and saving to the database anyway.
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
        }
      };

      send({
        type: "meta",
        chatId: chat.id,
        userMessage,
        systemMessage,
        assistantMessageId: assistant.id,
        fedBackClaimIds: systemMessage ? pending.map((c) => c.id) : [],
      });

      const pipeline = createPipeline({
        client,
        model: settings.checkerModel,
        strictness: settings.strictness,
        triage: {
          model: settings.triageModel,
          threshold: clamp01(settings.triageThreshold),
          auditRate: clamp01(settings.auditRate),
          openrouterKey: req.headers.get("x-openrouter-key")?.trim() || process.env.OPENROUTER_API_KEY || null,
        },
        chatId: chat.id,
        messageId: assistant.id,
        userQuestion: content,
        emit: (claim) => send({ type: "claim", claim }),
      });
      const chunker = createChunker();

      // 2. Stream the main model's reply, handing finished passages to the fact-checker as they arrive.
      let text = "";
      try {
        const reply = client.beta.messages.stream({
          model: settings.mainModel,
          max_tokens: 64000,
          system: MAIN_SYSTEM,
          messages: history,
          ...(settings.mainModel === "claude-haiku-5-5"
            ? {}
            : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        });
        for await (const event of reply) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            text += event.delta.text;
            send({ type: "text", delta: event.delta.text });
            const range = chunker.next(text);
            if (range) pipeline.addPassage(text.slice(...range), range[0], text);
          }
        }
        const final = await reply.finalMessage();
        db.setMessageUsage(
          assistant.id,
          inputTokens(final.usage) + final.usage.output_tokens,
          estimateCost(settings.mainModel, final.usage),
        );
        if (final.stop_reason === "refusal" && !text)
          text = "_The model declined to answer this request._";
      } catch (err) {
        send({ type: "error", message: describeError(err) });
      }

      if (!text) {
        db.deleteMessage(assistant.id);
      } else {
        db.updateMessageContent(assistant.id, text);
        send({ type: "message_done", message: db.getMessage(assistant.id) ?? { ...assistant, content: text } });
        const range = chunker.rest(text);
        if (range) pipeline.addPassage(text.slice(...range), range[0], text);
      }

      // 3. Keep the stream open until every claim from this reply has a verdict,
      //    then write the one-line digest if anything needs correcting.
      await pipeline.finish();
      if (text) {
        await summarizeMessage({
          client,
          model: settings.checkerModel,
          messageId: assistant.id,
          minImportance: settings.minImportance,
        });
        const done = db.getMessage(assistant.id);
        if (done) send({ type: "summary", message: done });
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

const clamp01 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
