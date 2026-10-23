export const dynamic = "force-dynamic";

/** Tells the browser whether it has to supply its own API key. */
export function GET() {
  return Response.json({ serverKey: !!process.env.ANTHROPIC_API_KEY });
}
