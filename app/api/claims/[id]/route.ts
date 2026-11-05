import * as db from "@/lib/db";
import { BadRequest, chatParam, isId, isImportance, jsonError, readJson } from "@/lib/api";
import { summarizeMessage, verifyClaim } from "@/lib/factcheck";
import { describeError, llmFromRequest, MissingKeyError } from "@/lib/llm";
import { holdChat, parseChat, releaseChat } from "@/lib/session";
import { isCheckerModel } from "@/lib/models";
import { DEFAULT_SETTINGS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** One claim, for the chat it belongs to (?chat=<chat id>). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const chat = chatParam(req);
  if (!chat) return jsonError("Missing or invalid chat id.");
  const { id } = await ctx.params;
  const claim = isId(id) ? db.getClaim(id) : null;
  if (!claim || claim.chatId !== chat) return jsonError("Not found", 404);
  return Response.json(claim);
}

/** Re-verify one claim from scratch, e.g. after changing the checker model or prompts. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err instanceof BadRequest) return jsonError(err.message, err.status);
    throw err;
  }
  // The browser sends the chat too: it proves the claim is the caller's, gives the verifier
  // context, and the summary is stored on its message.
  const payload = parseChat(body);
  if (!payload) return jsonError("Invalid chat.");
  const { id } = await ctx.params;
  const claim = isId(id) ? db.getClaim(id) : null;
  if (!claim || claim.chatId !== payload.chat.id) return jsonError("Not found", 404);

  const model = typeof body.model === "string" ? body.model : DEFAULT_SETTINGS.checkerModel;
  const minImportance = isImportance(body.minImportance) ? body.minImportance : DEFAULT_SETTINGS.minImportance;
  if (!isCheckerModel(model)) return jsonError("Invalid settings.");

  const llm = llmFromRequest(req);
  try {
    llm.require(model);
  } catch (err) {
    if (err instanceof MissingKeyError) return jsonError(err.message, 401);
    throw err;
  }
  holdChat(payload);
  try {
    const message = db.getMessage(claim.messageId);
    const context = message ? `Assistant replied (excerpt): ${message.content.slice(0, 4000)}` : "";
    const result = await verifyClaim({ llm, model, claim, context, force: true });
    // The verdict changed, so the message's digest may be stale.
    await summarizeMessage({ llm, model, messageId: claim.messageId, minImportance });
    return Response.json({ claim: result, message: db.getMessage(claim.messageId), keyStatus: llm.statuses() });
  } catch (err) {
    return jsonError(describeError(err), 502);
  } finally {
    releaseChat(payload.chat.id);
  }
}
