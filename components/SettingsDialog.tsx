"use client";

import { useEffect, useRef, useState } from "react";
import type { Importance, Settings, Strictness } from "@/lib/types";
import { DECISION_MODELS } from "@/lib/triage";
import { MODELS, OPENROUTER_PREFIX, isOpenRouterModel, openRouterSlug, providerOf } from "@/lib/models";
import type { ApiKeys, Provider } from "@/lib/providers";
import { PROVIDER_IDS, PROVIDERS, enabledKeys, maskKey } from "@/lib/providers";
import { clearLocalData, type KeyFailures } from "@/lib/client";
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

/** Models grouped by provider; providers without a usable key are listed but can't be picked. */
function ModelSelect({
  value,
  use,
  usable,
  keys,
  openrouter,
  onChange,
}: {
  value: string;
  use: "main" | "checker";
  usable: Set<Provider>;
  keys: ApiKeys;
  /** The OpenRouter models the user has chosen to list. */
  openrouter: string[];
  onChange: (id: string) => void;
}) {
  const p = providerOf(value);
  return (
    <>
      <ModelOptions value={value} use={use} usable={usable} openrouter={openrouter} onChange={onChange} />
      {/* Which key this model will be called with. */}
      <small className={usable.has(p) ? "" : "keys__warn"}>
        {usable.has(p)
          ? `Uses your ${PROVIDERS[p].label} key ${maskKey(keys[p]!)}`
          : keys[p]
            ? `Your ${PROVIDERS[p].label} key is switched off`
            : `Needs a ${PROVIDERS[p].label} key`}
      </small>
    </>
  );
}

function ModelOptions({
  value,
  use,
  usable,
  openrouter,
  onChange,
}: {
  value: string;
  use: "main" | "checker";
  usable: Set<Provider>;
  openrouter: string[];
  onChange: (id: string) => void;
}) {
  // OpenRouter's group is whatever the user picked (plus the current choice, if it's one of them).
  const routed = [...new Set([...openrouter, ...(providerOf(value) === "openrouter" ? [openRouterSlug(value)] : [])])];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {PROVIDER_IDS.map((p) => {
        const models =
          p === "openrouter"
            ? routed.map((slug) => ({ id: `${OPENROUTER_PREFIX}${slug}`, label: slug }))
            : MODELS.filter((m) => m.provider === p && m[use]).map((m) => ({ id: m.id, label: modelLabel(m.id) }));
        if (!models.length) return null;
        return (
          <optgroup key={p} label={usable.has(p) ? PROVIDERS[p].label : `${PROVIDERS[p].label} (no key in use)`}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!usable.has(p)}>
                {m.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** USD per million tokens from OpenRouter's per-token price strings ("-1" means it varies). */
const perMillion = (x: string | undefined) => {
  const n = Number(x);
  return !x || n < 0 ? "?" : `$${+(n * 1e6).toFixed(2)}`;
};

/** Choose which of OpenRouter's models appear in the model menus. */
function OpenRouterModels({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [catalog, setCatalog] = useState<OpenRouterModel[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    // The list is public and CORS-enabled, so the browser fetches it directly.
    fetch("https://openrouter.ai/api/v1/models")
      .then((r) => r.json())
      .then((j: { data?: OpenRouterModel[] }) => setCatalog(j.data ?? []))
      .catch(() => {});
  }, []);
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const known = !catalog.length || byId.has(draft.trim());
  const add = () => {
    const id = draft.trim();
    if (!id || !isOpenRouterModel(`${OPENROUTER_PREFIX}${id}`) || value.includes(id)) return;
    onChange([...value, id]);
    setDraft("");
  };
  return (
    <div className="field">
      <span>OpenRouter models</span>
      {value.length > 0 && (
        <ul className="keys">
          {value.map((id) => {
            const m = byId.get(id);
            const search = m?.supported_parameters?.includes("tools");
            return (
              <li key={id}>
                <code title={m?.name}>{id}</code>
                {m && (
                  <small className="muted">
                    {perMillion(m.pricing?.prompt)} / {perMillion(m.pricing?.completion)} per M
                    {search ? "" : " · may not support web search"}
                  </small>
                )}
                <button type="button" className="link" onClick={() => onChange(value.filter((x) => x !== id))}>
                  remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="keys__add">
        <input
          list="openrouter-models"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={catalog.length ? `Search ${catalog.length} models, e.g. moonshotai/kimi-k3` : "vendor/model"}
          spellCheck={false}
        />
        <datalist id="openrouter-models">
          {catalog.map((m) => (
            <option key={m.id} value={m.id} />
          ))}
        </datalist>
        <button type="button" className="btn btn--small" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>
      {draft.trim() && !known && <small className="keys__warn">OpenRouter doesn&rsquo;t list that model.</small>}
      <small>
        Added models appear in both model menus under OpenRouter. The checker needs web search, which OpenRouter adds
        to any model that supports tools.
      </small>
    </div>
  );
}

interface Props {
  settings: Settings;
  keys: ApiKeys;
  /** Keys a provider rejected on their last use. */
  keyFailures: KeyFailures;
  onSave: (s: Settings, keys: ApiKeys) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, keys: savedKeys, keyFailures, onSave, onClose }: Props) {
  const [s, setS] = useState(settings);
  const [keys, setKeys] = useState(savedKeys);
  const total = store.totalUsage();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const usableOf = (k: ApiKeys, disabled: Provider[]) => new Set(Object.keys(enabledKeys(k, disabled)) as Provider[]);
  const usable = usableOf(keys, s.disabledKeys);

  /** Move a model whose key is missing or off to the first model that has one. */
  const withUsableModels = (next: Settings, k: ApiKeys): Settings => {
    const ok = usableOf(k, next.disabledKeys);
    const pick = (use: "main" | "checker", current: string) =>
      ok.has(providerOf(current)) ? current : (MODELS.find((m) => m[use] && ok.has(m.provider))?.id ?? current);
    return { ...next, mainModel: pick("main", next.mainModel), checkerModel: pick("checker", next.checkerModel) };
  };
  const changeKeys = (next: ApiKeys) => {
    // A newly added or replaced key starts switched on.
    const changed = (Object.keys(next) as Provider[]).filter((p) => next[p] !== keys[p]);
    setKeys(next);
    setS((prev) =>
      withUsableModels({ ...prev, disabledKeys: prev.disabledKeys.filter((p) => !changed.includes(p)) }, next),
    );
  };
  const toggleKey = (p: Provider, on: boolean) =>
    setS((prev) =>
      withUsableModels(
        { ...prev, disabledKeys: on ? prev.disabledKeys.filter((x) => x !== p) : [...new Set([...prev.disabledKeys, p])] },
        keys,
      ),
    );

  // Every change is saved as it's made, with a brief "Saved".
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onSave(s, keys);
    setSavedAt(Date.now());
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [s, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        // Enter in a field mustn't close the dialog; everything is already saved.
        onSubmit={(e) => e.preventDefault()}
      >
        <h2>Settings</h2>
        {total.chats > 0 && (
          <p className="spend" title="Estimated from list prices, across the chats saved in this browser">
            Spent {formatCost(total.mainUsd + total.checkUsd)} over {total.chats} chat
            {total.chats === 1 ? "" : "s"}: {formatCost(total.mainUsd)} answering, {formatCost(total.checkUsd)} checking.
          </p>
        )}

        <KeysField
          keys={keys}
          disabled={s.disabledKeys}
          // A key replaced in this dialog hasn't been tried yet.
          failures={Object.fromEntries(
            Object.entries(keyFailures).filter(([p]) => keys[p as Provider] === savedKeys[p as Provider]),
          )}
          onChange={changeKeys}
          onToggle={toggleKey}
        />

        <div className="row">
          <label className="field">
            <span>Chat model</span>
            <ModelSelect
              value={s.mainModel}
              use="main"
              usable={usable}
              keys={keys}
              openrouter={s.openrouterModels}
              onChange={(v) => set("mainModel", v)}
            />
          </label>
          <label className="field">
            <span>Fact-check model</span>
            <ModelSelect
              value={s.checkerModel}
              use="checker"
              usable={usable}
              keys={keys}
              openrouter={s.openrouterModels}
              onChange={(v) => set("checkerModel", v)}
            />
          </label>
        </div>

        {keys.openrouter && (
          <OpenRouterModels value={s.openrouterModels} onChange={(v) => set("openrouterModels", v)} />
        )}

        <label className="toggle">
          <input type="checkbox" checked={s.mainTools} onChange={(e) => set("mainTools", e.target.checked)} />
          <span>
            Let the chat model use tools
            <small>
              Web search, reading web pages and running code, as far as the provider offers them. DeepSeek, Z.ai and
              OpenRouter models can search but not run code; NVIDIA models can do neither.
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
            below the threshold get the web check. Bare Jev ids (<code>jev-latest</code>) use a TypeSafe key; other
            ids go through OpenRouter&rsquo;s Decisions API with an OpenRouter key.
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
          <button type="button" className="link danger" onClick={() => setClearing(true)}>
            Clear all data…
          </button>
          <span className={`saved${savedAt ? " is-shown" : ""}`} aria-live="polite">
            {savedAt ? "Saved" : "Changes save automatically"}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        {clearing && <ClearDataDialog onClose={() => setClearing(false)} />}
      </form>
    </div>
  );
}

/** Confirm wiping this browser's keys and settings, and optionally its chats. */
function ClearDataDialog({ onClose }: { onClose: () => void }) {
  const [chats, setChats] = useState(false);
  const n = store.listChats().length;
  return (
    <div className="overlay overlay--top" onClick={onClose}>
      <div className="dialog dialog--small" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h2>Clear all data?</h2>
        <p className="muted small">
          This removes your API keys and settings from this browser. It can&rsquo;t be undone.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={chats} onChange={(e) => setChats(e.target.checked)} />
          <span>
            Also delete all chats
            <small>
              {n} chat{n === 1 ? "" : "s"} saved in this browser
            </small>
          </span>
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={async () => {
              await clearLocalData({ chats });
              location.assign("/");
            }}
          >
            {chats ? "Clear everything" : "Clear keys and settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
