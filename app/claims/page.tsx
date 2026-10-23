"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ChatSummary, Claim, ClaimCategory, ClaimStatus, Importance } from "@/lib/types";
import { isReusable } from "@/lib/types";
import { Bold } from "@/components/Bold";
import { STATUS, formatCost, hostname } from "@/components/status";
import { withTextFragment } from "@/lib/sources";

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

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      setF((prev) => ({ ...prev, id, showSuperseded: true }));
      setOpen(id);
    }
    fetch("/api/claims?limit=5000")
      .then((r) => r.json())
      .then(setClaims);
    fetch("/api/chats")
      .then((r) => r.json())
      .then(setChats);
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
    const q = f.q.trim().toLowerCase();
    return (claims ?? []).filter(
      (c) =>
        (!f.id || c.id === f.id) &&
        (f.showSuperseded || !c.supersededBy) &&
        (!f.importance || c.importance === f.importance) &&
        (!q ||
          c.claim.toLowerCase().includes(q) ||
          c.quote.toLowerCase().includes(q) ||
          (c.summary ?? "").toLowerCase().includes(q) ||
          c.sources.some((s) => s.url.toLowerCase().includes(q))) &&
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

  // Export links carry the filters the API understands.
  const exportQuery = new URLSearchParams(
    Object.entries({ q: f.q.trim(), status: f.status, category: f.category, model: f.model, chatId: f.chatId }).filter(
      ([, v]) => v,
    ),
  ).toString();

  return (
    <div className="dbpage">
      <header className="dbpage__head">
        <Link href="/" className="muted">
          ← chat
        </Link>
        <h1>Claims database</h1>
        <div className="dbpage__tools">
          <a className="btn btn--ghost btn--small" href={`/api/claims?format=json&${exportQuery}`}>
            Export JSON
          </a>
          <a className="btn btn--ghost btn--small" href={`/api/claims?format=jsonl&${exportQuery}`}>
            JSONL
          </a>
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
                        <span className={`pill pill--${c.status}`}>{STATUS[c.status].label}</span>
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
                      <td className="num">{c.relatedIds.length || "–"}</td>
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
      {c.relatedIds.length > 0 && (
        <div className="cdetail__related">
          <span className="muted small">Related</span>
          {c.relatedIds.map((id) => {
            const r = byId.get(id);
            return (
              <button key={id} className="link" onClick={() => onPick(id)}>
                {r ? (
                  <>
                    <span className={`pill pill--${r.status}`}>{STATUS[r.status].label}</span> {r.claim}
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
