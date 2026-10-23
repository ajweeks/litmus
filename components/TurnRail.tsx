"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/types";

const preview = (text: string) => {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 7).join(" ") + (words.length > 7 ? "…" : "");
};

/** One dash per question down the left edge; hover shows the questions, click jumps to one. */
export function TurnRail({ messages, onJump }: { messages: ChatMessage[]; onJump: () => void }) {
  const questions = messages.filter((m) => m.role === "user" && m.kind === "normal");
  const [current, setCurrent] = useState<string | null>(null);

  // The current question is the last one whose top has scrolled above the upper third of the view.
  useEffect(() => {
    const update = () => {
      let id: string | null = questions[0]?.id ?? null;
      for (const q of questions) {
        const el = document.getElementById(`turn-${q.id}`);
        if (el && el.getBoundingClientRect().top < window.innerHeight / 3) id = q.id;
      }
      setCurrent(id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [questions.map((q) => q.id).join()]);

  if (questions.length < 2) return null;
  return (
    <nav className="rail" aria-label="Questions in this chat">
      {questions.map((q) => (
        <button
          key={q.id}
          className={`rail__item${q.id === current ? " is-current" : ""}`}
          onClick={(e) => {
            // Drop focus so the rail collapses back to dashes once the pointer leaves.
            e.currentTarget.blur();
            onJump();
            document.getElementById(`turn-${q.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          <i />
          <span>{preview(q.content)}</span>
        </button>
      ))}
    </nav>
  );
}
