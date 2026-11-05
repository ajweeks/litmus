"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ChatSummary, Claim, ClaimCategory, ClaimStatus, Importance } from "@/lib/types";
import { isReusable } from "@/lib/types";
import { Bold } from "@/components/Bold";
import * as store from "@/lib/chatStore";
import { fuzzyMatcher } from "@/lib/fuzzy";
import { STATUS, formatCost, hostname, statusInfo } from "@/components/status";
import { withTextFragment } from "@/lib/links";

interface Filters {
  q: string;
  status: ClaimStatus | "";
  category: ClaimCategory | "";
  model: string;
  chatId: string;
  importance: Importance | "";
  minConfidence: number;
  sentOnly: boolean;
  showSuperseded: boolean;
  /** Set by the "Details" link on a margin note. */
  id: string;
}

const EMPTY: Filters = {
  q: "",
  status: "",
  category: "",
  model: "",
  chatId: "",
  importance: "",
  minConfidence: 0,
  sentOnly: false,
  showSuperseded: false,
  id: "",
};

/** The chat this page was opened from (only same-site paths), else the start page. */
function backTo(): string {
  const from = new URLSearchParams(location.search).get("from") ?? "";
  // A same-site path only: not "//host", not "/\\host" (which browsers read as "//host"), no scheme.
  return /^\/(?![\/\\])/.test(from) ? from : "/";
}

/** Whether a verdict is still current, and whether later chats may reuse it. */
function freshness(c: Claim): { label: string; title: string } {
  if (c.supersededBy) return { label: "replaced", title: `Superseded by ${c.supersededBy}` };
  if (c.reusedFrom) return { label: "copied", title: `Verdict reused from ${c.reusedFrom}` };
  if (c.expiresAt !== null && c.expiresAt <= Date.now()) return { label: "stale", title: "Expired; will be re-checked" };
  const until = c.expiresAt === null ? "doesn't expire" : `fresh until ${new Date(c.expiresAt).toLocaleDateString()}`;
  return {
    label: c.volatility ?? "–",
    title: `${until}${isReusable(c) ? "; reusable" : "; not reusable (low confidence, no retrieved source, or not final)"}`,
  };
}

export default function ClaimsPage() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [f, setF] = useState<Filters>(EMPTY);
  const [open, setOpen] = useState<string | null>(null);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const router = useRouter();
  /** Where "← chat" and Esc go; read after mount, since the page is prerendered. */
  const [back, setBack] = useState("/");
  useEffect(() => setBack(backTo()), []);

  // Esc goes back to the chat, unless it's clearing a search box that still has text in it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLInputElement | null;
      if (t?.tagName === "INPUT" && t.value) return;
      router.push(back);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, back]);

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      setF((prev) => ({ ...prev, id, showSuperseded: true }));
      setOpen(id);
    }
    // Only this browser's chats: the claims come from the local chat store, not the server.
    store.load().then(() => {
      setClaims(store.allClaims());
      setChats(store.listChats());
    });
  }, []);

  const models = useMemo(
    () => [...new Set((claims ?? []).map((c) => c.verifierModel).filter((m): m is string => !!m))].sort(),
    [claims],
  );
  const chatTitle = useMemo(() => new Map(chats.map((c) => [c.id, c.title])), [chats]);
  const byId = useMemo(() => new Map((claims ?? []).map((c) => [c.id, c])), [claims]);
  /** Jump to another claim (from "Related"). */
  const pick = (id: string) => {
    setF((prev) => ({ ...prev, id, showSuperseded: true }));
    setOpen(id);
  };

  const shown = useMemo(() => {
    const matches = fuzzyMatcher(f.q);
    return (claims ?? []).filter(
      (c) =>
        (!f.id || c.id === f.id) &&
        (f.showSuperseded || !c.supersededBy) &&
        (!f.importance || c.importance === f.importance) &&
        matches(c.claim, c.quote, c.summary, c.correction, ...c.sources.map((s) => `${s.url} ${s.title}`)) &&
        (!f.status || c.status === f.status) &&
        (!f.category || c.category === f.category) &&
        (!f.model || c.verifierModel === f.model) &&
        (!f.chatId || c.chatId === f.chatId) &&
        (f.minConfidence === 0 || (c.confidence ?? 0) >= f.minConfidence / 100) &&
        (!f.sentOnly || !!c.fedBackIn),
    );
  }, [claims, f]);

  const total = shown.reduce(
    (acc, c) => ({ cost: acc.cost + c.costUsd, tokens: acc.tokens + c.inputTokens + c.outputTokens }),
    { cost: 0, tokens: 0 },
  );
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY);

  /** Download the claims currently shown, as a JSON array or one claim per line. */
  const download = (format: "json" | "jsonl") => {
    const text = format === "json" ? JSON.stringify(shown, null, 2) : shown.map((c) => JSON.stringify(c)).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "application/x-ndjson" }));
    a.download = `claims.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="dbpage">
      <header className="dbpage__head">
        <Link href={back} className="muted">
          ← chat
        </Link>
        <h1>Claims database</h1>
        <div className="dbpage__tools">
          <button className="btn btn--ghost btn--small" onClick={() => download("json")} disabled={!shown.length}>
            Export JSON
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => download("jsonl")} disabled={!shown.length}>
            JSONL
          </button>
        </div>
      </header>

      <div className="filters">
        <input
          type="search"
          placeholder="Search claims, quotes, findings, source URLs…"
          value={f.q}
          onChange={(e) => set("q", e.target.value)}
        />
        <select value={f.status} onChange={(e) => set("status", e.target.value as Filters["status"])}>
          <option value="">Any verdict</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select value={f.category} onChange={(e) => set("category", e.target.value as Filters["category"])}>
          <option value="">Any type</option>
          <option value="empirical">Empirical</option>
          <option value="interpretive">Interpretive</option>
          <option value="framing">Framing</option>
        </select>
        <select value={f.importance} onChange={(e) => set("importance", e.target.value as Filters["importance"])}>
          <option value="">Any importance</option>
          <option value="major">Major</option>
          <option value="moderate">Moderate</option>
          <option value="minor">Minor</option>
        </select>
        <select value={f.model} onChange={(e) => set("model", e.target.value)}>
          <option value="">Any checker</option>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select value={f.chatId} onChange={(e) => set("chatId", e.target.value)}>
          <option value="">All chats</option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title.slice(0, 50)}
            </option>
          ))}
        </select>
        <label title="Minimum verifier confidence">
          conf ≥ {f.minConfidence}%
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={f.minConfidence}
            onChange={(e) => set("minConfidence", Number(e.target.value))}
          />
        </label>
        <label>
          <input type="checkbox" checked={f.sentOnly} onChange={(e) => set("sentOnly", e.target.checked)} />
          sent to model
        </label>
        <label>
          <input
            type="checkbox"
            checked={f.showSuperseded}
            onChange={(e) => set("showSuperseded", e.target.checked)}
          />
          include replaced
        </label>
        {f.id && (
          <button className="chip" onClick={() => set("id", "")}>
            {f.id} ×
          </button>
        )}
        {active && (
          <button className="link" onClick={() => setF(EMPTY)}>
            Clear
          </button>
        )}
      </div>

      {!claims ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="dbstats">
            {shown.length} of {claims.length} claims · {total.tokens.toLocaleString()} tokens · ~{formatCost(total.cost)}
          </p>
          {shown.length === 0 ? (
            <p className="muted">{claims.length ? "No claims match these filters." : "No claims yet."}</p>
          ) : (
            <table className="dbtable">
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>Claim</th>
                  <th>Conf.</th>
                  <th>Fresh</th>
                  <th>Related</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <Fragment key={c.id}>
                    <tr onClick={() => setOpen(open === c.id ? null : c.id)} className="dbtable__row">
                      <td>
                        <span className={`pill pill--${c.status}`}>{statusInfo(c.status).label}</span>
                        {c.importance && <div className="muted small">{c.importance}</div>}
                      </td>
                      <td>
                        {c.claim}
                        {c.summary && (
                          <div className="muted small">
                            <Bold text={c.summary} />
                          </div>
                        )}
                      </td>
                      <td className="num">{c.confidence === null ? "–" : `${Math.round(c.confidence * 100)}%`}</td>
                      <td className="num" title={freshness(c).title}>
                        {freshness(c).label}
                      </td>
                      <td className="num">{c.relatedIds.filter((id) => byId.has(id)).length || "–"}</td>
                    </tr>
                    {open === c.id && (
                      <tr className="dbtable__detail">
                        <td colSpan={5}>
                          <ClaimDetail claim={c} byId={byId} chatTitle={chatTitle.get(c.chatId)} onPick={pick} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

/** The expanded row: what was found and where, with the bookkeeping in one muted line. */
function ClaimDetail({
  claim: c,
  byId,
  chatTitle,
  onPick,
}: {
  claim: Claim;
  byId: Map<string, Claim>;
  chatTitle?: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="cdetail">
      {c.correction && (
        <p className="cdetail__correction">
          <Bold text={c.correction} />
        </p>
      )}
      <p className="cdetail__quote">&ldquo;{c.quote}&rdquo;</p>
      {c.sources.length > 0 && (
        <ul className="sources">
          {c.sources.map((s) => (
            <li key={s.id} className={`source source--${s.stance}`}>
              <a href={withTextFragment(s.url, s.quote)} target="_blank" rel="noreferrer noopener" title={s.title}>
                {hostname(s.url)}
              </a>
              {!s.retrieved && <span className="warn"> · not from search</span>}
              {s.quote && <blockquote>{s.quote}</blockquote>}
            </li>
          ))}
        </ul>
      )}
      {/* Related claims from other people's chats are in the shared cache but not shown here. */}
      {c.relatedIds.some((id) => byId.has(id)) && (
        <div className="cdetail__related">
          <span className="muted small">Related</span>
          {c.relatedIds.filter((id) => byId.has(id)).map((id) => {
            const r = byId.get(id);
            return (
              <button key={id} className="link" onClick={() => onPick(id)}>
                {r ? (
                  <>
                    <span className={`pill pill--${r.status}`}>{statusInfo(r.status).label}</span> {r.claim}
                  </>
                ) : (
                  id
                )}
              </button>
            );
          })}
        </div>
      )}
      <p className="muted small">
        {[
          c.verifierModel,
          c.searchCount ? `${c.searchCount} search${c.searchCount === 1 ? "" : "es"}` : null,
          formatCost(c.costUsd),
          c.triageConfidence !== null ? `triage ${Math.round(c.triageConfidence * 100)}%` : null,
          new Date(c.createdAt).toLocaleString(),
        ]
          .filter(Boolean)
          .join(" · ")}
        {" · "}
        <Link href={`/?c=${c.chatId}`}>{(chatTitle ?? "open chat").slice(0, 40)}</Link>
      </p>
      <details>
        <summary className="muted small">Raw record</summary>
        <pre>{JSON.stringify(c, null, 2)}</pre>
      </details>
    </div>
  );
}
