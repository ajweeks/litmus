"use client";

import { useEffect, useRef, useState } from "react";
import type { Importance, Settings, Strictness } from "@/lib/types";
import { DECISION_MODELS } from "@/lib/triage";
import { MODELS, providerOf } from "@/lib/models";
import type { ApiKeys, Provider } from "@/lib/providers";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/providers";
import * as store from "@/lib/chatStore";
import { KeysField } from "./KeysField";
import { modelLabel } from "./UsageMeter";
import { formatCost } from "./status";


/** One scale for both what gets checked and how big an error must be before it's shown. */
const LEVELS: { strictness: Strictness; minImportance: Importance; label: string; hint: string }[] = [
  { strictness: "facts", minImportance: "moderate", label: "Facts", hint: "Dates, numbers, names, scientific and technical facts. The default." },
  { strictness: "judgments", minImportance: "moderate", label: "Facts and judgments", hint: "Also contestable claims presented as settled." },
  { strictness: "critique", minImportance: "minor", label: "Full critique", hint: "Also misleading framing, missing caveats and nitpicks." },
];

/** The level a saved pair of settings corresponds to (settings from before the merge may not match exactly). */
function levelOf(s: Settings): number {
  const exact = LEVELS.findIndex((l) => l.strictness === s.strictness && l.minImportance === s.minImportance);
  return exact >= 0 ? exact : LEVELS.findIndex((l) => l.strictness === s.strictness);
}

/** Models grouped by provider; providers without a key are listed but can't be picked. */
function ModelSelect({
  value,
  use,
  usable,
  onChange,
}: {
  value: string;
  use: "main" | "checker";
  usable: Set<Provider>;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {PROVIDER_IDS.map((p) => {
        const models = MODELS.filter((m) => m.provider === p && m[use]);
        if (!models.length) return null;
        return (
          <optgroup key={p} label={usable.has(p) ? PROVIDERS[p].label : `${PROVIDERS[p].label} (add a key)`}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!usable.has(p)}>
                {modelLabel(m.id)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

interface Props {
  settings: Settings;
  keys: ApiKeys;
  onSave: (s: Settings, keys: ApiKeys) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, keys: savedKeys, onSave, onClose }: Props) {
  const [s, setS] = useState(settings);
  const [keys, setKeys] = useState(savedKeys);
  const total = store.totalUsage();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const usable = new Set(Object.keys(keys) as Provider[]);

  // When keys change, move a model whose provider has no key to the first one that does.
  const changeKeys = (next: ApiKeys) => {
    setKeys(next);
    const ok = new Set(Object.keys(next) as Provider[]);
    const fallback = (use: "main" | "checker", current: string) =>
      ok.has(providerOf(current)) ? current : (MODELS.find((m) => m[use] && ok.has(m.provider))?.id ?? current);
    setS((prev) => ({ ...prev, mainModel: fallback("main", prev.mainModel), checkerModel: fallback("checker", prev.checkerModel) }));
  };

  // Every change is saved as it's made.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onSave(s, keys);
  }, [s, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <h2>Settings</h2>
        {total.chats > 0 && (
          <p className="spend" title="Estimated from list prices, across the chats saved in this browser">
            Spent {formatCost(total.mainUsd + total.checkUsd)} over {total.chats} chat
            {total.chats === 1 ? "" : "s"}: {formatCost(total.mainUsd)} answering, {formatCost(total.checkUsd)} checking.
          </p>
        )}

        <KeysField keys={keys} onChange={changeKeys} />

        <div className="row">
          <label className="field">
            <span>Chat model</span>
            <ModelSelect value={s.mainModel} use="main" usable={usable} onChange={(v) => set("mainModel", v)} />
          </label>
          <label className="field">
            <span>Fact-check model</span>
            <ModelSelect value={s.checkerModel} use="checker" usable={usable} onChange={(v) => set("checkerModel", v)} />
          </label>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={s.mainTools} onChange={(e) => set("mainTools", e.target.checked)} />
          <span>
            Let the chat model use tools
            <small>
              Web search, reading web pages and running code, as far as the provider offers them (DeepSeek and Z.ai
              don&rsquo;t run code).
            </small>
          </span>
        </label>

        <fieldset className="field">
          <span>What to flag</span>
          {LEVELS.map((o, i) => (
            <label key={o.label} className="radio">
              <input
                type="radio"
                name="level"
                checked={levelOf(s) === i}
                onChange={() => setS((prev) => ({ ...prev, strictness: o.strictness, minImportance: o.minImportance }))}
              />
              <span>
                {o.label}
                <small>{o.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <h3>Triage (experimental)</h3>
        <label className="field">
          <span>Decision model</span>
          <input
            list="decision-models"
            value={s.triageModel}
            onChange={(e) => set("triageModel", e.target.value.trim())}
            placeholder="Off. Pick or type an OpenRouter decision-model id"
            spellCheck={false}
          />
          <datalist id="decision-models">
            {DECISION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          <small>
            A decision model (Jev, Decider, Drex, ...) gives each claim a probability of being accurate. Only claims
            below the threshold get the web check. Uses OpenRouter&rsquo;s Decisions API, so it needs an OpenRouter
            key above.
          </small>
        </label>
        {s.triageModel && (
          <>
            <div className="row">
              <label className="field">
                <span>Skip check above</span>
                <input
                  type="number"
                  min={50}
                  max={100}
                  step={1}
                  value={Math.round(s.triageThreshold * 100)}
                  onChange={(e) => set("triageThreshold", Number(e.target.value) / 100)}
                />
                <small>% confidence</small>
              </label>
              <label className="field">
                <span>Audit anyway</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(s.auditRate * 100)}
                  onChange={(e) => set("auditRate", Number(e.target.value) / 100)}
                />
                <small>% of skips, checked at random</small>
              </label>
            </div>
          </>
        )}

        <h3>Display</h3>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.queueCorrections}
            onChange={(e) => set("queueCorrections", e.target.checked)}
          />
          <span>
            Queue corrections for the next message
            <small>Unsent findings go to the model with your next message. The button under each reply sends them now.</small>
          </span>
        </label>

        <label className="toggle">
          <input type="checkbox" checked={s.showSupported} onChange={(e) => set("showSupported", e.target.checked)} />
          <span>
            Show everything
            <small>Also mark claims that checked out, minor errors and claims triage skipped.</small>
          </span>
        </label>

        <div className="dialog__actions">
          <span className="muted small">Changes save automatically.</span>
          <button type="submit" className="btn">
            Done
          </button>
        </div>
      </form>
    </div>
  );
}
