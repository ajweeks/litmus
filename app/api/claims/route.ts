import * as db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Current state of the claims with these ids (?ids=a,b,c), for a browser catching up on checks
 * that finished after it disconnected. There's deliberately no listing: the cache holds claims
 * from every user's chats, and each browser only knows the ids of its own.
 */
export function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 500);
  return Response.json(db.getClaims(ids));
}
