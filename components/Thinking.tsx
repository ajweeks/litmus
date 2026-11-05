"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ToolActivity } from "@/lib/types";
import { modelLabel } from "@/lib/models";
import { hostname } from "./status";

/** The latest heading the summary gave (summaries often start sections with **a title**), else its last line. */
function liveLine(text: string): string {
  const headings = [...text.matchAll(/^\s*\*\*(.+?)\*\*\s*$/gm)];
  if (headings.length) return headings[headings.length - 1][1];
  const lines = text.split("\n").map((l) => l.replace(/[*_#`]/g, "").trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

const VERB = { search: "Searching", fetch: "Reading", code: "Running" } as const;

function describe(a: ToolActivity) {
  return a.kind === "fetch" ? hostname(a.label) : a.kind === "search" ? `\u201c${a.label}\u201d` : a.label;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Collapsed reasoning and tool use above an answer: a live one-line status while the model works,
 * expandable to the full summary and every search, page and code run.
 */
export function Thinking({
  text,
  activity,
  active,
  model,
}: {
  text: string;
  activity: ToolActivity[];
  active: boolean;
  /** The model that wrote this answer. */
  model: string | null;
}) {
  const [open, setOpen] = useState(false);
  const last = activity[activity.length - 1];
  // Whichever happened most recently: a tool call, or more reasoning after it.
  const live = last && last.at >= text.length ? `${VERB[last.kind]} ${describe(last)}` : liveLine(text);
  const count = (k: ToolActivity["kind"]) => activity.filter((a) => a.kind === k).length;
  const tools = [
    count("search") && plural(count("search"), "search"),
    count("fetch") && plural(count("fetch"), "page"),
    count("code") && plural(count("code"), "code run"),
  ].filter(Boolean);
  const label = active
    ? last && last.at >= text.length
      ? "Working"
      : "Thinking"
    : [text ? "Thoughts" : null, ...tools].filter(Boolean).join(" \u00b7 ") || "Details";

  return (
    <div className={`thinking${open ? " is-open" : ""}`}>
      <button className="thinking__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {active && <span className="spinner" />}
        <span className="thinking__label">{label}</span>
        {active && !open && <span className="thinking__live">{live}</span>}
        <span className="thinking__chev">{open ? "\u25be" : "\u25b8"}</span>
      </button>
      {open && (
        <div className="thinking__body">
          {model && <p className="thinking__model">Answered by {modelLabel(model)}</p>}
          {text && <ReactMarkdown>{text}</ReactMarkdown>}
          {activity.length > 0 && (
            <ul className="activity">
              {activity.map((a, i) => (
                <li key={i}>
                  <span className="activity__kind">{a.kind}</span>{" "}
                  {a.kind === "fetch" && isUrl(a.label) ? (
                    <a href={a.label} target="_blank" rel="noreferrer noopener">
                      {hostname(a.label)}
                    </a>
                  ) : (
                    <span>{describe(a)}</span>
                  )}
                  {a.results && a.results.length > 0 && (
                    <span className="activity__results">
                      {a.results.filter((r) => isUrl(r.url)).map((r, j) => (
                        <a key={`${j}-${r.url}`} href={r.url} target="_blank" rel="noreferrer noopener" title={r.title}>
                          {hostname(r.url)}
                        </a>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
