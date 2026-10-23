"use client";

import { useState } from "react";
import type { Importance, Settings, Strictness } from "@/lib/types";
import { CHECKER_MODELS, MAIN_MODELS } from "@/lib/types";
import { DECISION_MODELS } from "@/lib/triage";

const STRICTNESS: { value: Strictness; label: string; hint: string }[] = [
  { value: "facts", label: "Facts", hint: "Dates, numbers, names, scientific and technical facts." },
  { value: "judgments", label: "Facts + judgments", hint: "Also contestable claims presented as settled." },
  { value: "critique", label: "Full critique", hint: "Also misleading framing and missing caveats." },
];

const IMPORTANCE: { value: Importance; label: string }[] = [
  { value: "major", label: "Only major errors" },
  { value: "moderate", label: "Moderate and major (default)" },
  { value: "minor", label: "Everything, including nitpicks" },
];

interface Props {
  settings: Settings;
  apiKey: string;
  openrouterKey: string;
  onSave: (s: Settings, apiKey: string, openrouterKey: string) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, apiKey, openrouterKey, onSave, onClose }: Props) {
  const [s, setS] = useState(settings);
  const [key, setKey] = useState(apiKey);
  const [orKey, setOrKey] = useState(openrouterKey);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(s, key, orKey);
        }}
      >
        <h2>Settings</h2>

        <label className="field">
          <span>Anthropic API key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
          />
          <small>
            Kept in this browser only and sent with each request. The server uses it for that request and never
            stores it.
          </small>
        </label>

        <div className="row">
          <label className="field">
            <span>Chat model</span>
            <select value={s.mainModel} onChange={(e) => set("mainModel", e.target.value)}>
              {MAIN_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Fact-check model</span>
            <select value={s.checkerModel} onChange={(e) => set("checkerModel", e.target.value)}>
              {CHECKER_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <span>What to check</span>
          {STRICTNESS.map((o) => (
            <label key={o.value} className="radio">
              <input
                type="radio"
                name="strictness"
                checked={s.strictness === o.value}
                onChange={() => set("strictness", o.value)}
              />
              <span>
                {o.label}
                <small>{o.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>Corrections to show</span>
          <select value={s.minImportance} onChange={(e) => set("minImportance", e.target.value as Importance)}>
            {IMPORTANCE.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <small>Smaller errors are hidden, left out of the summary and not sent to the model.</small>
        </label>

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
            below the threshold get the web check. Uses OpenRouter&rsquo;s Decisions API.
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
            <label className="field">
              <span>OpenRouter API key</span>
              <input
                type="password"
                value={orKey}
                onChange={(e) => setOrKey(e.target.value)}
                placeholder="sk-or-…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
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
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
