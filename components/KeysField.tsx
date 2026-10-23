"use client";

import { useState } from "react";
import type { KeyFailures } from "@/lib/client";
import type { ApiKeys, Provider } from "@/lib/providers";
import { PROVIDER_IDS, PROVIDERS, candidateProviders, detectProvider, keyProblem, maskKey } from "@/lib/providers";

/**
 * Paste any provider's key; it's recognised from its shape and listed with only its prefix showing.
 * Each key can be switched off without deleting it.
 */
export function KeysField({
  keys,
  disabled,
  failures,
  onChange,
  onToggle,
}: {
  keys: ApiKeys;
  disabled: Provider[];
  /** Keys that didn't work the last time they were used, and why. */
  failures: KeyFailures;
  onChange: (k: ApiKeys) => void;
  onToggle: (p: Provider, on: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Provider | "">("");
  const problem = keyProblem(draft);
  const detected = problem ? null : detectProvider(draft);
  /** Ambiguous keys (DeepSeek or Alibaba) only offer the providers they could be. */
  const candidates = problem ? [] : candidateProviders(draft);
  const choices = candidates.length > 1 ? candidates : PROVIDER_IDS;
  const provider = problem ? null : (detected ?? (picked || null));

  const add = (key = draft, as = provider) => {
    if (!as || !key.trim() || keyProblem(key)) return;
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
          {listed.map((p) => {
            const on = !disabled.includes(p);
            const failed = failures[p];
            return (
              <li
                key={p}
                className={`${on ? "" : "is-off"}${failed ? " is-failed" : ""}`}
                title={failed ? `Didn't work on ${new Date(failed.at).toLocaleString()}: ${failed.message}` : undefined}
              >
                <label className="keys__on" title={on ? "In use. Untick to switch this key off" : "Switched off"}>
                  <input type="checkbox" checked={on} onChange={(e) => onToggle(p, e.target.checked)} />
                  <span className="keys__provider">{PROVIDERS[p].label}</span>
                </label>
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
                {failed && <small className="keys__failed">{failed.message}</small>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="keys__add">
        <input
          type="password"
          value={draft}
          aria-invalid={!!problem}
          onChange={(e) => {
            const v = e.target.value;
            // A pasted key that's recognised goes straight into the list.
            const pasted = (e.nativeEvent as InputEvent).inputType === "insertFromPaste";
            if (pasted && !keyProblem(v) && detectProvider(v)) add(v, detectProvider(v));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Paste an API key"
          autoComplete="off"
          spellCheck={false}
        />
        {draft.trim() && !problem && !detected && (
          <select value={picked} onChange={(e) => setPicked(e.target.value as Provider)} aria-label="Provider">
            <option value="">Provider?</option>
            {choices.map((p) => (
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
      {draft.trim() &&
        (problem ? (
          <small className="keys__error">{problem}</small>
        ) : detected ? (
          <small>Recognised as a {PROVIDERS[detected].label} key.</small>
        ) : candidates.length > 1 ? (
          <small>
            Could be a {candidates.map((p) => PROVIDERS[p].label).join(" or ")} key: they look the same. Pick which.
          </small>
        ) : (
          <small className="keys__warn">Not recognised. Pick the provider it&rsquo;s for.</small>
        ))}
      <small>
        Works with {PROVIDER_IDS.map((p) => PROVIDERS[p].label).join(", ")}. Keys stay in this browser and are sent
        only with your own requests; the server never stores them.
      </small>
    </div>
  );
}
