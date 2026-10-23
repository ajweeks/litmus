import * as db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const detail = db.getChatDetail((await ctx.params).id);
  return detail ? Response.json(detail) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  db.deleteChat((await ctx.params).id);
  return new Response(null, { status: 204 });
}
