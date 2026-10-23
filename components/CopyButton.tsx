"use client";

import { useState } from "react";

/** Copies the raw markdown of an answer. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tally copy"
      title="Copy the answer as markdown"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied (e.g. insecure origin); nothing useful to show.
        }
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
