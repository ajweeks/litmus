import * as db from "@/lib/db";
import { chatParam, isId, jsonError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Current state of the claims with these ids (?ids=a,b,c&chat=<chat id>), for a browser catching
 * up on checks that finished after it disconnected. Only claims from that chat are returned:
 * the cache holds claims from every user's chats, and the chat id (which only its own browser
 * knows) is what grants access to them. There's deliberately no listing.
 */
export function GET(req: Request) {
  const chat = chatParam(req);
  if (!chat) return jsonError("Missing or invalid chat id.");
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(isId).slice(0, 500);
  return Response.json(db.getClaims(ids, chat));
}
