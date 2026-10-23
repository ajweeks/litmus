import * as db from "@/lib/db";
import type { Claim, ClaimStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export the claims database.
 *   ?status=refuted     filter by status
 *   ?category=empirical filter by claim type
 *   ?model=claude-...   filter by verifier model
 *   ?q=penicillin       search claim text and quotes
 *   ?chatId=chat_...    filter by chat
 *   ?format=jsonl       one claim per line instead of a JSON array
 *   ?limit=500
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const claims = db.listClaims({
    chatId: url.searchParams.get("chatId") || undefined,
    status: (url.searchParams.get("status") as ClaimStatus | null) || undefined,
    category: (url.searchParams.get("category") as Claim["category"] | null) || undefined,
    verifierModel: url.searchParams.get("model") || undefined,
    q: url.searchParams.get("q") || undefined,
    limit: Number(url.searchParams.get("limit")) || 1000,
  });
  if (url.searchParams.get("format") === "jsonl") {
    return new Response(claims.map((c) => JSON.stringify(c)).join("\n") + "\n", {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }
  return Response.json(claims);
}
