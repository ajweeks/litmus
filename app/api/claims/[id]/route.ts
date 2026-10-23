import * as db from "@/lib/db";
import { summarizeMessage, verifyClaim } from "@/lib/factcheck";
import { llmFromRequest, MissingKeyError } from "@/lib/llm";
import { holdChat, parseChat, releaseChat } from "@/lib/session";
import { isCheckerModel } from "@/lib/models";
import type { Importance } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const claim = db.getClaim((await ctx.params).id);
  return claim ? Response.json(claim) : Response.json({ error: "Not found" }, { status: 404 });
}

/** Re-verify one claim from scratch, e.g. after changing the checker model or prompts. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const claim = db.getClaim((await ctx.params).id);
  if (!claim) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { model?: string; minImportance?: Importance };
  const { model = DEFAULT_SETTINGS.checkerModel, minImportance = DEFAULT_SETTINGS.minImportance } = body;
  if (!isCheckerModel(model) || !["minor", "moderate", "major"].includes(minImportance))
    return Response.json({ error: "Invalid settings." }, { status: 400 });
  // The browser sends the chat too: the message gives the verifier context, and the summary is stored on it.
  const payload = parseChat(body);
  if (!payload || payload.chat.id !== claim.chatId) return Response.json({ error: "Invalid chat." }, { status: 400 });

  const llm = llmFromRequest(req);
  try {
    llm.require(model);
  } catch (err) {
    if (err instanceof MissingKeyError) return Response.json({ error: err.message }, { status: 401 });
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
  } finally {
    releaseChat(payload.chat.id);
  }
}
