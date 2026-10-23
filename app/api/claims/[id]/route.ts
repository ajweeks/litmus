import type Anthropic from "@anthropic-ai/sdk";
import * as db from "@/lib/db";
import { clientFromRequest, MissingKeyError } from "@/lib/anthropic";
import { summarizeMessage, verifyClaim } from "@/lib/factcheck";
import type { Importance } from "@/lib/types";
import { CHECKER_MODELS, DEFAULT_SETTINGS } from "@/lib/types";

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
  const { model = DEFAULT_SETTINGS.checkerModel, minImportance = DEFAULT_SETTINGS.minImportance } = (await req
    .json()
    .catch(() => ({}))) as { model?: string; minImportance?: Importance };
  if (!CHECKER_MODELS.includes(model) || !["minor", "moderate", "major"].includes(minImportance))
    return Response.json({ error: "Invalid settings." }, { status: 400 });

  let client: Anthropic;
  try {
    client = clientFromRequest(req);
  } catch (err) {
    if (err instanceof MissingKeyError) return Response.json({ error: err.message }, { status: 401 });
    throw err;
  }
  const message = db.getMessage(claim.messageId);
  const context = message ? `Assistant replied (excerpt): ${message.content.slice(0, 4000)}` : "";
  const result = await verifyClaim({ client, model, claim, context, force: true });
  // The verdict changed, so the message's digest may be stale.
  await summarizeMessage({ client, model, messageId: claim.messageId, minImportance });
  return Response.json({ claim: result, message: db.getMessage(claim.messageId) });
}
