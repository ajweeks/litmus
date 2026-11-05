import nodemailer from "nodemailer";
import { BadRequest, jsonError, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bug reports are emailed to the maintainer. Set REPORT_TO (the address, which never reaches the
// browser) and SMTP_URL (e.g. smtps://user:password@smtp.example.com:465), and optionally REPORT_FROM
// (defaults to the SMTP user).
const MAX_CHARS = 2000;
const PER_SENDER_MS = 60_000;
/** A ceiling across everyone, so a flood from many addresses can't fill the inbox. */
const GLOBAL_PER_HOUR = 30;
/** Senders remembered at once; the oldest are forgotten first. */
const MAX_SENDERS = 10_000;

const lastBySender = new Map<string, number>();
const recent: number[] = [];

/** Drop senders whose cooldown has passed, so a flood of spoofed addresses can't grow the map forever. */
function pruneSenders(now: number) {
  for (const [sender, at] of lastBySender) if (now - at >= PER_SENDER_MS) lastBySender.delete(sender);
  while (lastBySender.size >= MAX_SENDERS) {
    const oldest = lastBySender.keys().next().value;
    if (oldest === undefined) break;
    lastBySender.delete(oldest);
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    if (err instanceof BadRequest) return jsonError(err.message, err.status);
    throw err;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!message) return jsonError("Write a description of the bug first.");
  if (message.length > MAX_CHARS) return jsonError(`Keep it under ${MAX_CHARS} characters.`);
  if (email && (email.length > 200 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)))
    return jsonError("That email address doesn't look right.");

  const now = Date.now();
  // Behind a proxy this is the client address; without one it's whatever the client sent, which
  // is why the global ceiling exists as well.
  const sender = req.headers.get("x-forwarded-for")?.split(",")[0].trim().slice(0, 100) || "unknown";
  pruneSenders(now);
  const last = lastBySender.get(sender) ?? 0;
  if (now - last < PER_SENDER_MS)
    return jsonError(`You can send one report a minute. Try again in ${Math.ceil((PER_SENDER_MS - (now - last)) / 1000)}s.`, 429);
  while (recent.length && now - recent[0] > 3600_000) recent.shift();
  if (recent.length >= GLOBAL_PER_HOUR) return jsonError("Too many reports right now. Try again later.", 429);

  const smtp = process.env.SMTP_URL;
  const to = process.env.REPORT_TO;
  if (!smtp || !to) return jsonError("Bug reports aren't set up on this server yet.", 503);

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
        `Browser: ${(req.headers.get("user-agent") ?? "unknown").slice(0, 300)}`,
        `Sent: ${new Date(now).toISOString()}`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("bug report failed:", err);
    lastBySender.delete(sender);
    return jsonError("Couldn't send the report. Try again later.", 502);
  }
  return Response.json({ ok: true });
}
