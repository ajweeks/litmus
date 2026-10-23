"use client";

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeClaims, type HighlightTarget } from "@/lib/rehypeClaims";
import type { ChatMessage, Claim, Importance } from "@/lib/types";
import { CORRECTABLE_STATUSES, isNotableProblem } from "@/lib/types";
import { Bold } from "./Bold";
import { ClaimNote } from "./ClaimNote";
import { SEVERITY, STATUS, isPending } from "./status";

interface Props {
  message: ChatMessage;
  claims: Claim[];
  streaming: boolean;
  /** The server is still extracting/checking claims for this answer. */
  analysing: boolean;
  showSupported: boolean;
  minImportance: Importance;
  queueCorrections: boolean;
  onToggleQueue: (on: boolean) => void;
  activeClaimId: string | null;
  onSelect: (id: string | null) => void;
  onRecheck: (id: string) => void;
  onSendCorrections: () => void;
}

const Markdown = memo(function Markdown({ text, targets }: { text: string; targets: HighlightTarget[] }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeClaims, { claims: targets }]]}>
      {text}
    </ReactMarkdown>
  );
});

export function MessageView(p: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const marginRef = useRef<HTMLDivElement>(null);
  /** Footer tally whose claims are shown in the margin (e.g. "supported"). */
  const [openBucket, setOpenBucket] = useState<string | null>(null);

  // Problems below the importance threshold are "minor": hidden like confirmations unless asked for.
  const isMinor = (c: Claim) => CORRECTABLE_STATUSES.includes(c.status) && !isNotableProblem(c, p.minImportance);
  const quiet = (c: Claim) => c.status === "supported" || c.status === "skipped" || isMinor(c);

  const bucket = (c: Claim) => (isMinor(c) ? "minor" : c.status);

  // Visible claims in reading order: problems, plus the bucket opened from the footer.
  const visible = useMemo(
    () =>
      p.claims
        .filter((c) => p.showSupported || !quiet(c) || bucket(c) === openBucket)
        .sort((a, b) => (a.startOffset < 0 ? Infinity : a.startOffset) - (b.startOffset < 0 ? Infinity : b.startOffset)),
    [p.claims, p.showSupported, p.minImportance, openBucket],
  );
  const targets = useMemo(
    () =>
      // Most severe first, so they win when two quotes overlap.
      [...visible]
        .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])
        .map((c) => ({ id: c.id, quote: c.quote, status: isMinor(c) ? "minor" : c.status })),
    [visible],
  );

  // Pin each margin note next to its highlight, pushing notes down so they never overlap.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const margin = marginRef.current;
    if (!body || !margin) return;

    const layout = () => {
      const notes = [...margin.querySelectorAll<HTMLElement>("[data-note-id]")];
      if (getComputedStyle(margin).position !== "relative") {
        // Narrow screens: notes flow below the message.
        notes.forEach((n) => (n.style.top = ""));
        margin.style.minHeight = "";
        return;
      }
      const base = body.getBoundingClientRect().top;
      const placed = notes
        .map((n) => {
          const mark = body.querySelector<HTMLElement>(`mark[data-claim-id="${n.dataset.noteId}"]`);
          return { n, want: mark ? mark.getBoundingClientRect().top - base : Infinity };
        })
        .sort((a, b) => a.want - b.want);
      let bottom = 0;
      for (const { n, want } of placed) {
        const top = Math.max(want === Infinity ? bottom : want, bottom);
        n.style.top = `${top}px`;
        bottom = top + n.offsetHeight + 8;
      }
      margin.style.minHeight = `${bottom}px`;
    };

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(body);
    margin.querySelectorAll("[data-note-id]").forEach((n) => ro.observe(n));
    return () => ro.disconnect();
  });

  // The selected claim's highlight gets an outline.
  useLayoutEffect(() => {
    bodyRef.current?.querySelectorAll("mark.claim").forEach((m) => {
      m.classList.toggle("is-active", (m as HTMLElement).dataset.claimId === p.activeClaimId);
    });
  });

  const onBodyClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-claim-id]");
    if (el) p.onSelect(el.dataset.claimId === p.activeClaimId ? null : el.dataset.claimId!);
  };

  if (p.message.role === "user") {
    const auto = p.message.kind === "correction_request";
    return (
      <div className="turn turn--user">
        <div className="turn__label">{auto ? "Auto" : "You"}</div>
        <div className={`question${auto ? " question--auto" : ""}`}>{p.message.content}</div>
      </div>
    );
  }

  if (p.message.role === "system") {
    const n = (p.message.content.match(/^- \[/gm) ?? []).length;
    return (
      <div className="turn turn--system">
        <div className="turn__label">Sent</div>
        <details className="sysnote">
          <summary>
            {n} fact-check finding{n === 1 ? "" : "s"} passed to the model
          </summary>
          <pre>{p.message.content}</pre>
        </details>
      </div>
    );
  }

  const done = p.claims.filter((c) => !isPending(c.status));
  const checking = p.claims.length - done.length;
  const problems = p.claims.filter((c) => isNotableProblem(c, p.minImportance));
  const unsent = problems.filter((c) => !c.fedBackIn);
  const worst = [...problems].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])[0];
  // Footer tallies: notable problems by verdict, plus "minor", "supported" and "not checked".
  const order = (k: string) => (k === "minor" ? 2.5 : SEVERITY[k as Claim["status"]]);
  const counts = Object.entries(
    done.reduce<Record<string, number>>((acc, c) => ((acc[bucket(c)] = (acc[bucket(c)] ?? 0) + 1), acc), {}),
  ).sort(([a], [b]) => order(a) - order(b));

  return (
    <div className="turn turn--assistant">
      <div className="turn__label">{p.streaming ? <span className="live" /> : "Answer"}</div>
      <div className="turn__main">
        <div className="prose" ref={bodyRef} onClick={onBodyClick}>
          <Markdown text={p.message.content} targets={targets} />
          {p.streaming && <span className="cursor" />}
        </div>

        {problems.length > 0 && (
          <div className={`verdict verdict--${worst.status}`}>
            <span className="verdict__label">Fact-check</span>
            {p.message.checkSummary ? (
              <span className="verdict__text">
                <Bold text={p.message.checkSummary} />
              </span>
            ) : (
              <span className="verdict__text muted">
                {checking > 0 ? "Summarising once all claims are checked…" : "Writing summary…"}
              </span>
            )}
          </div>
        )}

        {(p.claims.length > 0 || (!p.streaming && p.message.content)) && (
          <div className="turn__footer">
            {p.claims.length === 0 &&
              !p.streaming &&
              (p.analysing ? (
                <span className="tally">
                  <span className="spinner" /> finding claims…
                </span>
              ) : (
                <span>No checkable claims</span>
              ))}
            {counts.map(([key, n]) => (
              <button
                key={key}
                className={`tally tally--${key}${openBucket === key ? " is-open" : ""}`}
                onClick={() => setOpenBucket(openBucket === key ? null : key)}
                title="Show these claims and their sources in the margin"
              >
                <i /> {n} {key === "minor" ? "minor" : STATUS[key as Claim["status"]].label.toLowerCase()}
              </button>
            ))}
            {checking > 0 && (
              <span className="tally">
                <span className="spinner" /> checking {checking}
              </span>
            )}
            {unsent.length > 0 && (
              <span className="feedback">
                <label title="Send these findings to the model along with your next message">
                  <input
                    type="checkbox"
                    checked={p.queueCorrections}
                    onChange={(e) => p.onToggleQueue(e.target.checked)}
                  />
                  queue for next message
                </label>
                <button className="btn btn--small" onClick={p.onSendCorrections}>
                  Send {unsent.length} correction{unsent.length === 1 ? "" : "s"} now
                </button>
              </span>
            )}
          </div>
        )}

      </div>
      <div className="margin" ref={marginRef}>
        {visible.map((c) => (
          <ClaimNote
            key={c.id}
            claim={c}
            minor={isMinor(c)}
            showSources={bucket(c) === openBucket}
            active={p.activeClaimId === c.id}
            onSelect={p.onSelect}
            onRecheck={p.onRecheck}
          />
        ))}
      </div>
    </div>
  );
}
