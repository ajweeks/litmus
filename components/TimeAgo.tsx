"use client";

import { useEffect, useState } from "react";

const DAY = 24 * 3600 * 1000;

/** "just now", "5 min ago", "3 h ago"; older than a day, the date and time. */
function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s * 1000 < DAY) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(at);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "9s", "1m 20s". */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Relative time that keeps itself current. */
export function TimeAgo({ at, className }: { at: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {ago(at, now)}
    </time>
  );
}
