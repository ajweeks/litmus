"use client";

import { useEffect, useState } from "react";

const MAX_CHARS = 2000;
const COOLDOWN_MS = 60_000;
const LAST_SENT = "factcheck.lastBugReport";

function lastSent(): number {
  try {
    return Number(localStorage.getItem(LAST_SENT)) || 0;
  } catch {
    return 0;
  }
}

/** A short form that emails a bug report to the maintainer (at most one a minute). */
export function BugReportDialog({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, COOLDOWN_MS - (now - lastSent()));

  // Count down the cooldown while it's running.
  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wait]);

  const send = async () => {
    setState("sending");
    setError(null);
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, email }),
    }).catch(() => null);
    if (res?.ok) {
      try {
        localStorage.setItem(LAST_SENT, String(Date.now()));
      } catch {
        // The server enforces the limit too.
      }
      setState("sent");
      return;
    }
    setState("idle");
    setError(res ? ((await res.json().catch(() => ({}))).error ?? "Couldn't send the report.") : "Couldn't reach the server.");
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (message.trim() && !wait && state === "idle") send();
        }}
      >
        <h2>Report a bug</h2>
        {state === "sent" ? (
          <p className="muted">Thanks, your report was sent.</p>
        ) : (
          <>
            <label className="field">
              <span>What happened?</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, MAX_CHARS))}
                maxLength={MAX_CHARS}
                rows={7}
                placeholder="What you did, what you expected, and what happened instead."
                autoFocus
              />
              <small className={message.length > MAX_CHARS * 0.9 ? "keys__warn" : ""}>
                {message.length} / {MAX_CHARS}
              </small>
            </label>
            <label className="field">
              <span>Your email (optional)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="If you'd like a reply"
                maxLength={200}
              />
              <small>The report includes your browser version. It never includes your chats or API keys.</small>
            </label>
            {error && <p className="keys__error small">{error}</p>}
          </>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {state === "sent" ? "Close" : "Cancel"}
          </button>
          {state !== "sent" && (
            <button type="submit" className="btn" disabled={!message.trim() || !!wait || state === "sending"}>
              {state === "sending" ? "Sending…" : wait ? `Wait ${Math.ceil(wait / 1000)}s` : "Send"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
