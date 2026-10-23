"use client";

import Link from "next/link";
import type { Claim } from "@/lib/types";
import { withTextFragment } from "@/lib/sources";
import { Bold } from "./Bold";
import { STATUS, hostname, isPending } from "./status";

interface Props {
  claim: Claim;
  /** Below the importance threshold: shown muted, as context rather than a correction. */
  minor: boolean;
  active: boolean;
  /** Opened from a footer tally: list source links even while collapsed. */
  showSources?: boolean;
  onSelect: (id: string | null) => void;
  onRecheck: (id: string) => void;
}

// Deliberately brief: cost, models, IDs and related claims live on the claims database page.
export function ClaimNote({ claim, minor, active, showSources, onSelect, onRecheck }: Props) {
  const pending = isPending(claim.status);
  const headline =
    claim.status === "skipped"
      ? `Likely accurate (${Math.round((claim.triageConfidence ?? 0) * 100)}%), so not checked`
      : pending
        ? claim.claim
        : claim.status === "error"
          ? claim.error
          : claim.summary;

  return (
    <div
      className={`note note--${minor ? "minor" : claim.status}${active ? " is-active" : ""}`}
      data-note-id={claim.id}
      onClick={() => onSelect(active ? null : claim.id)}
    >
      <div className="note__head">
        <span className="note__label">{minor ? "Minor" : STATUS[claim.status].label}</span>
        {claim.fedBackIn && <span className="note__sent">sent</span>}
        {claim.confidence !== null && !pending && (
          <span className="note__conf" title="Verifier confidence">
            {Math.round(claim.confidence * 100)}%
          </span>
        )}
      </div>
      <p className={`note__text${active ? "" : " clamp"}`}>
        <Bold text={headline ?? ""} />
      </p>

      {showSources && !active && claim.sources.length > 0 && (
        <p className="note__hosts" onClick={(e) => e.stopPropagation()}>
          {claim.sources.map((src) => (
            <a key={src.id} href={withTextFragment(src.url, src.quote)} target="_blank" rel="noreferrer noopener" title={src.quote || src.title}>
              {hostname(src.url)}
            </a>
          ))}
        </p>
      )}

      {active && (
        <div className="note__detail" onClick={(e) => e.stopPropagation()}>
          {claim.correction && <p className="note__correction">
              <Bold text={claim.correction} />
            </p>}
          {claim.sources.length > 0 && (
            <ul className="sources">
              {claim.sources.map((src) => (
                <li key={src.id} className={`source source--${src.stance}`}>
                  <a href={withTextFragment(src.url, src.quote)} target="_blank" rel="noreferrer noopener" title={src.title}>
                    {hostname(src.url)}
                  </a>
                  {!src.retrieved && <span className="warn"> · not from search</span>}
                  {src.quote && <blockquote className="clamp">{src.quote}</blockquote>}
                </li>
              ))}
            </ul>
          )}
          <div className="note__actions">
            <button className="link" disabled={pending} onClick={() => onRecheck(claim.id)}>
              Re-check
            </button>
            <Link className="link" href={`/claims?id=${claim.id}&from=${encodeURIComponent(`/?c=${claim.chatId}`)}`}>
              Details
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
