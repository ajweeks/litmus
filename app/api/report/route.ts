import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bug reports are emailed to the maintainer. Set REPORT_TO (the address, which never reaches the
// browser) and SMTP_URL (e.g. smtps://user:password@smtp.example.com:465), and optionally REPORT_FROM
// (defaults to the SMTP user).
const MAX_CHARS = 2000;
const PER_SENDER_MS = 60_000;
/** A ceiling across everyone, so a flood from many addresses can't fill the inbox. */
const GLOBAL_PER_HOUR = 30;

const lastBySender = new Map<string, number>();
const recent: number[] = [];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; email?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!message) return Response.json({ error: "Write a description of the bug first." }, { status: 400 });
  if (message.length > MAX_CHARS)
    return Response.json({ error: `Keep it under ${MAX_CHARS} characters.` }, { status: 400 });
  if (email && (email.length > 200 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)))
    return Response.json({ error: "That email address doesn't look right." }, { status: 400 });

  const now = Date.now();
  const sender = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const last = lastBySender.get(sender) ?? 0;
  if (now - last < PER_SENDER_MS)
    return Response.json(
      { error: `You can send one report a minute. Try again in ${Math.ceil((PER_SENDER_MS - (now - last)) / 1000)}s.` },
      { status: 429 },
    );
  while (recent.length && now - recent[0] > 3600_000) recent.shift();
  if (recent.length >= GLOBAL_PER_HOUR)
    return Response.json({ error: "Too many reports right now. Try again later." }, { status: 429 });

  const smtp = process.env.SMTP_URL;
  const to = process.env.REPORT_TO;
  if (!smtp || !to) return Response.json({ error: "Bug reports aren't set up on this server yet." }, { status: 503 });

  lastBySender.set(sender, now);
  recent.push(now);
  try {
    const transport = nodemailer.createTransport(smtp);
    const user = new URL(smtp).username;
    await transport.sendMail({
      from: process.env.REPORT_FROM || decodeURIComponent(user),
      to,
      ...(email ? { replyTo: email } : {}),
      subject: "litmus bug report",
      text: [
        message,
        "",
        "--",
        `From: ${email || "(no email given)"}`,
        `Browser: ${req.headers.get("user-agent") ?? "unknown"}`,
        `Sent: ${new Date(now).toISOString()}`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("bug report failed:", err);
    lastBySender.delete(sender);
    return Response.json({ error: "Couldn't send the report. Try again later." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
