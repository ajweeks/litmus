"use client";

/** Who made this and why. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog about" role="dialog" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="about-title">
          litmus
        </h2>
        <p>
          This tool was built by AJ Weeks as a way to automate fact-checking LLM responses, for more reliable answers.
        </p>
        <p className="muted">
          While the chat model answers, a second, cheaper model pulls out its factual claims and checks each one against
          sources on the web. Problems are highlighted in the answer with the evidence in the margin, and corrections can
          be passed back to the chat model. You bring your own API keys; they stay in your browser.
        </p>
        <div className="dialog__actions">
          <button className="btn" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
