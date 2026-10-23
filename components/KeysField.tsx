"use client";

import { useState } from "react";
import type { ApiKeys, Provider } from "@/lib/providers";
import { PROVIDER_IDS, PROVIDERS, detectProvider, maskKey } from "@/lib/providers";

/** Paste any provider's key; it's recognised from its shape and listed with only its prefix showing. */
export function KeysField({
  keys,
  onChange,
}: {
  keys: ApiKeys;
  onChange: (k: ApiKeys) => void;
}) {
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Provider | "">("");
  const detected = detectProvider(draft);
  const provider = detected ?? (picked || null);

  const add = (key = draft, as = provider) => {
    if (!as || !key.trim()) return;
    onChange({ ...keys, [as]: key.trim() });
    setDraft("");
    setPicked("");
  };

  const listed = PROVIDER_IDS.filter((p) => keys[p]);

  return (
    <div className="field">
      <span>API keys</span>
      {listed.length > 0 && (
        <ul className="keys">
          {listed.map((p) => (
            <li key={p}>
              <span className="keys__provider">{PROVIDERS[p].label}</span>
              <code>{maskKey(keys[p]!)}</code>
              <button
                  type="button"
                  className="link"
                  aria-label={`Remove ${PROVIDERS[p].label} key`}
                  onClick={() => {
                    const next = { ...keys };
                    delete next[p];
                    onChange(next);
                  }}
                >
                  remove
                </button>
            </li>
          ))}
        </ul>
      )}
      <div className="keys__add">
        <input
          type="password"
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            // A pasted key that's recognised goes straight into the list.
            const pasted = (e.nativeEvent as InputEvent).inputType === "insertFromPaste";
            if (pasted && detectProvider(v)) add(v, detectProvider(v));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Paste a key: Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Z.ai, OpenRouter"
          autoComplete="off"
          spellCheck={false}
        />
        {draft.trim() && !detected && (
          <select value={picked} onChange={(e) => setPicked(e.target.value as Provider)} aria-label="Provider">
            <option value="">Provider?</option>
            {PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].label}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn--small" disabled={!provider || !draft.trim()} onClick={() => add()}>
          {provider ? `Add ${PROVIDERS[provider].label}` : "Add"}
        </button>
      </div>
      <small>
        Kept in this browser only and sent with each request. The server uses them for that request and never stores
        them. Adding a key for a provider you already have replaces it.
      </small>
    </div>
  );
}
