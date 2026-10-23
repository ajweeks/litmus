"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import * as store from "@/lib/chatStore";
import {
  authHeaders,
  chatPayload,
  loadKeys,
  loadSettings,
  loadSidebar,
  saveKeys,
  saveSettings,
  saveSidebar,
  loadKeyFailures,
  saveKeyFailures,
  streamChat,
  streamCheck,
  withKeyStatus,
  type KeyFailures,
} from "@/lib/client";
import type { KeyStatus } from "@/lib/llm/types";
import type { ApiKeys, Provider } from "@/lib/providers";
import { PROVIDER_IDS, PROVIDERS, enabledKeys } from "@/lib/providers";
import type { ChatDetail, ChatMessage, Claim, Settings, StreamEvent } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { MessageView } from "./MessageView";
import { TurnRail } from "./TurnRail";
import { UsageMeter, modelLabel } from "./UsageMeter";
import { AboutDialog } from "./AboutDialog";
import { BugReportDialog } from "./BugReportDialog";
import { MODELS, OPENROUTER_PREFIX, openRouterSlug, providerOf } from "@/lib/models";
import { SettingsDialog } from "./SettingsDialog";
import { isPending } from "./status";

const NO_MESSAGES: ChatMessage[] = [];
const SIDEBAR_DEFAULT = 236;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
/** Dragging the edge closer than this to the left of the window hides the sidebar. */
const SIDEBAR_HIDE_AT = 110;

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<ApiKeys>({});
  /** Keys are read from localStorage after mount; don't nag about missing ones before that. */
  const [keysLoaded, setKeysLoaded] = useState(false);
  /** Keys a provider rejected, shown in red in Settings until they next work. */
  const [keyFailures, setKeyFailures] = useState<KeyFailures>({});
  const noteKey = (s: { provider: Provider; ok: boolean; message?: string }) =>
    setKeyFailures((prev) => {
      const next = withKeyStatus(prev, s);
      saveKeyFailures(next);
      return next;
    });
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Desktop sidebar width and whether it's hidden; remembered in this browser. */
  const [side, setSide] = useState({ width: SIDEBAR_DEFAULT, collapsed: false });
  const sideLoaded = useRef(false);
  useEffect(() => {
    if (!sideLoaded.current) {
      sideLoaded.current = true;
      setSide(loadSidebar());
      return;
    }
    saveSidebar(side);
  }, [side]);

  // Chats live in this browser (lib/chatStore.ts); re-render whenever the store changes.
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  const [chatId, setChatId] = useState<string | null>(null);
  const chats = useMemo(() => store.listChats(), [storeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const detail = chatId ? store.getChat(chatId) : undefined;
  const messages = detail?.messages ?? NO_MESSAGES;
  const claims = useMemo(() => new Map((detail?.claims ?? []).map((c) => [c.id, c])), [detail]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Answers whose claim extraction/checking stream is still open (so "no claims" isn't premature). */
  const [analysingIds, setAnalysingIds] = useState<Set<string>>(new Set());
  /** Answers with a passage currently being scanned for claims (this starts while the reply streams). */
  const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const openStreams = useRef(0);
  /** ID of the send that currently owns the busy/streaming state. */
  const currentSend = useRef<string | null>(null);
  /** Whether the view follows new content. Any upward scroll gesture detaches it; reaching the bottom re-attaches. */
  const followRef = useRef(true);

  // ---------- loading ----------

  useEffect(() => {
    setSettings(loadSettings());
    setKeys(loadKeys());
    setKeyFailures(loadKeyFailures());
    setKeysLoaded(true);
    const id = new URLSearchParams(location.search).get("c");
    store.load().then(() => {
      if (!id) return;
      if (store.getChat(id)) setChatId(id);
      else setError("That chat isn't saved in this browser.");
    });
  }, []);

  const selectChat = (id: string | null) => {
    setSidebarOpen(false);
    setActiveClaimId(null);
    setError(null);
    // A reply still streaming elsewhere keeps going and is still saved; don't block this chat on it.
    currentSend.current = null;
    setBusy(false);
    setStreamingId(null);
    history.replaceState(null, "", id ? `/?c=${id}` : "/");
    setChatId(id);
  };

  // If a reload or a dropped connection left claims mid-check, ask the server for them until they finish.
  const pendingIds = useMemo(
    () => [...claims.values()].filter((c) => isPending(c.status)).map((c) => c.id),
    [claims],
  ).join(",");
  useEffect(() => {
    if (!pendingIds || !chatId) return;
    const id = chatId;
    const t = setInterval(async () => {
      if (openStreams.current > 0) return;
      const res = await fetch(`/api/claims?ids=${pendingIds}`).catch(() => null);
      if (!res?.ok) return;
      const fresh = (await res.json()) as Claim[];
      const found = new Set(fresh.map((c) => c.id));
      store.updateChat(id, (d) =>
        // A claim the server no longer has was interrupted (e.g. by a restart) and won't finish.
        d.claims
          .filter((c) => pendingIds.includes(c.id) && !found.has(c.id))
          .map((c): Claim => ({ ...c, status: "error", error: "The check was interrupted. Re-check to try again." }))
          .concat(fresh)
          .reduce(store.upsertClaim, d),
      );
    }, 4000);
    return () => clearInterval(t);
  }, [pendingIds, chatId]);

  // ---------- sending ----------

  const send = async (content: string, correctionRequest = false) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    followRef.current = true;
    const now = Date.now();
    // A new chat gets its id here, so every event can be stored against it from the start.
    const id = chatId ?? `chat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const chat = store.getChat(id)?.chat ?? { id, title: content.slice(0, 80), createdAt: now, updatedAt: now };
    const sent = chatPayload(store.getChat(id) ?? { chat, messages: [], claims: [] });
    const update = (fn: (d: ChatDetail) => ChatDetail) => store.updateChat(id, fn, chat);
    /** Apply `fn` to one message of this chat. */
    const patchMessage = (messageId: string, fn: (m: ChatMessage) => ChatMessage) =>
      update((d) => ({ ...d, messages: d.messages.map((m) => (m.id === messageId ? fn(m) : m)) }));

    const tempId = `tmp_${now}`;
    update((d) => ({
      ...d,
      chat: { ...d.chat, updatedAt: now },
      messages: correctionRequest
        ? d.messages
        : [
            ...d.messages,
            { id: tempId, chatId: id, role: "user", content, kind: "normal", model: null, checkSummary: null, createdAt: now },
          ],
    }));
    if (!chatId) {
      history.replaceState(null, "", `/?c=${id}`);
      setChatId(id);
    }
    currentSend.current = tempId;
    openStreams.current++;
    let assistantId: string | null = null;

    // Every event is stored, even if the user has moved to another chat meanwhile.
    const onEvent = (e: StreamEvent) => {
      switch (e.type) {
        case "meta": {
          const placeholder: ChatMessage = {
            id: e.assistantMessageId,
            chatId: id,
            role: "assistant",
            content: "",
            kind: "normal",
            model: settings.mainModel,
            checkSummary: null,
            createdAt: Date.now(),
          };
          const fedBack = new Set(e.fedBackClaimIds);
          update((d) => ({
            ...d,
            messages: [
              ...d.messages.filter((x) => x.id !== tempId),
              e.userMessage,
              ...(e.systemMessage ? [e.systemMessage] : []),
              placeholder,
            ],
            claims: d.claims.map((c) => (fedBack.has(c.id) ? { ...c, fedBackIn: e.systemMessage!.id } : c)),
          }));
          if (currentSend.current === tempId) setStreamingId(e.assistantMessageId);
          assistantId = e.assistantMessageId;
          setAnalysingIds((prev) => new Set(prev).add(e.assistantMessageId));
          break;
        }
        case "activity":
          if (assistantId) patchMessage(assistantId, (m) => ({ ...m, activity: e.items }));
          break;
        case "thinking":
          if (assistantId) patchMessage(assistantId, (m) => ({ ...m, thinking: (m.thinking ?? "") + e.delta }));
          break;
        case "text":
          if (assistantId) patchMessage(assistantId, (m) => ({ ...m, content: m.content + e.delta }));
          break;
        case "message_done":
          patchMessage(e.message.id, () => e.message);
          if (currentSend.current === tempId) {
            setStreamingId(null);
            setBusy(false);
          }
          break;
        case "claim":
          update((d) => store.upsertClaim(d, e.claim));
          break;
        case "extracting":
          setExtractingIds((prev) => {
            const next = new Set(prev);
            if (e.active > 0) next.add(e.messageId);
            else next.delete(e.messageId);
            return next;
          });
          break;
        case "summary":
          patchMessage(e.message.id, (m) => ({ ...m, checkSummary: e.message.checkSummary, usage: e.message.usage }));
          break;
        case "title":
          update((d) => ({ ...d, chat: { ...d.chat, title: e.title } }));
          break;
        case "key_status":
          noteKey(e);
          break;
        case "error":
          setError(e.message);
          if (e.messageId) patchMessage(e.messageId, (m) => ({ ...m, checkFailed: true }));
          break;
      }
    };

    try {
      await streamChat({ ...sent, content, correctionRequest, settings }, onEvent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      update((d) => ({ ...d, messages: d.messages.filter((x) => x.id !== tempId) }));
      // Nothing was saved for a brand-new chat that failed outright.
      if (!store.getChat(id)?.messages.length) {
        store.deleteChat(id);
        if (!chatId) selectChat(null);
      }
      if (!correctionRequest) setDraft(content);
    } finally {
      openStreams.current--;
      if (assistantId) {
        const done = assistantId;
        // A reply that failed before writing anything leaves no empty answer behind.
        update((d) => ({ ...d, messages: d.messages.filter((m) => m.id !== done || m.content) }));
        const drop = (prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(done);
          return next;
        };
        setAnalysingIds(drop);
        setExtractingIds(drop);
      }
      if (currentSend.current === tempId) {
        currentSend.current = null;
        setStreamingId(null);
        setBusy(false);
      }
    }
  };

  /** Both the chat model's and the checker's providers need a key before anything can be sent. */
  const usableKeys = enabledKeys(keys, settings.disabledKeys);
  const missingModel = [settings.mainModel, settings.checkerModel].find((m) => !usableKeys[providerOf(m)]) ?? "";
  const missing = providerOf(missingModel);
  const hasKeys = !missingModel;

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !hasKeys) return;
    setDraft("");
    send(text);
  };

  const recheck = async (claimId: string) => {
    const c = claims.get(claimId);
    if (!c || !chatId) return;
    const id = chatId;
    store.updateChat(id, (d) => store.upsertClaim(d, { ...c, status: "verifying" }));
    const res = await fetch(`/api/claims/${claimId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model: settings.checkerModel,
        minImportance: settings.minImportance,
        ...chatPayload(store.getChat(id)!),
      }),
    });
    if (res.ok) {
      const { claim, message, keyStatus } = (await res.json()) as {
        claim: Claim;
        message: ChatMessage | null;
        keyStatus: KeyStatus[];
      };
      keyStatus.forEach(noteKey);
      store.updateChat(id, (d) => ({
        ...store.upsertClaim(d, claim),
        messages: d.messages.map((x) =>
          // The server only saw this request, so its check usage is what the summary just cost.
          message && x.id === message.id
            ? {
                ...x,
                checkSummary: message.checkSummary,
                usage: x.usage && {
                  ...x.usage,
                  checkTokens: x.usage.checkTokens + (message.usage?.checkTokens ?? 0),
                  checkCostUsd: x.usage.checkCostUsd + (message.usage?.checkCostUsd ?? 0),
                },
              }
            : x,
        ),
      }));
    } else {
      store.updateChat(id, (d) => store.upsertClaim(d, c));
      setError((await res.json().catch(() => ({}))).error ?? "Re-check failed.");
    }
  };

  /** Retry fact-checking an answer whose check failed: failed claims, and extraction if that failed. */
  const retryCheck = async (messageId: string) => {
    if (!chatId) return;
    const id = chatId;
    const d = store.getChat(id);
    const target = d?.messages.find((m) => m.id === messageId);
    if (!d || !target) return;
    const reextract = !!target.checkFailed || !d.claims.some((c) => c.messageId === messageId);
    store.updateChat(id, (d) => ({
      ...d,
      messages: d.messages.map((m) => (m.id === messageId ? { ...m, checkFailed: false } : m)),
    }));
    setError(null);
    setAnalysingIds((prev) => new Set(prev).add(messageId));
    openStreams.current++;
    try {
      await streamCheck({ ...chatPayload(d), messageId, reextract, settings }, (e) => {
        switch (e.type) {
          case "claim":
            store.updateChat(id, (d) => store.upsertClaim(d, e.claim));
            break;
          case "extracting":
            setExtractingIds((prev) => {
              const next = new Set(prev);
              if (e.active > 0) next.add(messageId);
              else next.delete(messageId);
              return next;
            });
            break;
          case "summary":
            // The server only saw this retry, so its check usage is what the retry cost.
            store.updateChat(id, (d) => ({
              ...d,
              messages: d.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      checkSummary: e.message.checkSummary,
                      usage: m.usage && {
                        ...m.usage,
                        checkTokens: m.usage.checkTokens + (e.message.usage?.checkTokens ?? 0),
                        checkCostUsd: m.usage.checkCostUsd + (e.message.usage?.checkCostUsd ?? 0),
                      },
                    }
                  : m,
              ),
            }));
            break;
          case "key_status":
            noteKey(e);
            break;
          case "error":
            setError(e.message);
            store.updateChat(id, (d) => ({
              ...d,
              messages: d.messages.map((m) => (m.id === messageId ? { ...m, checkFailed: true } : m)),
            }));
            break;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      store.updateChat(id, (d) => ({
        ...d,
        messages: d.messages.map((m) => (m.id === messageId ? { ...m, checkFailed: true } : m)),
      }));
    } finally {
      openStreams.current--;
      const drop = (prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      };
      setAnalysingIds(drop);
      setExtractingIds(drop);
    }
  };

  const deleteChat = (id: string) => {
    if (!confirm("Delete this chat and its claims?")) return;
    store.deleteChat(id);
    if (id === chatId) selectChat(null);
  };

  // Follow new content only while the user is at the bottom. Detaching on the gesture itself
  // (not on a distance threshold) means streaming can never pull the page back down mid-scroll.
  useEffect(() => {
    const atBottom = () => {
      const el = document.scrollingElement!;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    };
    const onScroll = () => {
      if (atBottom()) followRef.current = true;
    };
    const detach = () => {
      if (!atBottom()) followRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) && !(e.target instanceof HTMLTextAreaElement))
        followRef.current = false;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", detach, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", detach);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Follow only while a reply is being written. Fact-check results arriving afterwards (notes,
  // highlights, the summary line) never move the page.
  useLayoutEffect(() => {
    if (!busy || !followRef.current) return;
    const el = document.scrollingElement!;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Scroll a selected claim's highlight into view (e.g. when picked from "Related").
  useEffect(() => {
    if (!activeClaimId) return;
    document.querySelector(`mark[data-claim-id="${activeClaimId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeClaimId]);

  const claimsByMessage = useMemo(() => {
    const by = new Map<string, Claim[]>();
    for (const c of claims.values()) by.set(c.messageId, [...(by.get(c.messageId) ?? []), c]);
    return by;
  }, [claims]);

  const empty = messages.length === 0;

  // ---------- sidebar: drag its edge to resize, or past the left edge (or the arrow) to hide ----------

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      if (ev.clientX < SIDEBAR_HIDE_AT) setSide((p) => ({ ...p, collapsed: true }));
      else setSide({ collapsed: false, width: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)) });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  /** On phones the sidebar is an overlay, so "hide" just closes it. */
  const hideSidebar = () =>
    matchMedia("(max-width: 760px)").matches ? setSidebarOpen(false) : setSide((p) => ({ ...p, collapsed: true }));

  return (
    <div
      className={`app${sidebarOpen ? " sidebar-open" : ""}${side.collapsed ? " sidebar-collapsed" : ""}`}
      style={{ "--side-w": `${side.width}px` } as React.CSSProperties}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            ✓
          </span>
          <span className="brand__name">litmus</span>
          <button className="sidebar__toggle" onClick={hideSidebar} aria-label="Hide sidebar" title="Hide sidebar">
            ‹
          </button>
        </div>
        <button className="btn btn--new" onClick={() => selectChat(null)}>
          New chat <kbd>+</kbd>
        </button>
        <div className="sidebar__heading">History</div>
        <nav className="chatlist">
          {chats.map((c) => (
            <div key={c.id} className={`chatlist__item${c.id === chatId ? " is-current" : ""}`}>
              <button onClick={() => selectChat(c.id)} title={c.title}>
                {c.title}
              </button>
              <button className="chatlist__del" onClick={() => deleteChat(c.id)} aria-label="Delete chat">
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar__foot">
          <Link href={chatId ? `/claims?from=${encodeURIComponent(`/?c=${chatId}`)}` : "/claims"}>Claims database</Link>
          <button className="link" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="link" onClick={() => setShowAbout(true)}>
            About
          </button>
          <button className="link" onClick={() => setShowBugReport(true)}>
            Report a bug
          </button>
        </div>
        <div
          className="sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar (drag to the left edge to hide it)"
          title="Drag to resize · double-click to hide"
          onPointerDown={startResize}
          onDoubleClick={hideSidebar}
        />
      </aside>
      <div className="scrim" onClick={() => setSidebarOpen(false)} />

      <main className={`main${empty ? " main--empty" : ""}`}>
        <header className="topbar">
          <button className="link menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            ☰
          </button>
          {side.collapsed && (
            <button
              className="sidebar__toggle sidebar__toggle--open"
              onClick={() => setSide((p) => ({ ...p, collapsed: false }))}
              aria-label="Show sidebar"
              title="Show sidebar"
            >
              ›
            </button>
          )}
          <h1 className="topbar__title" title={detail?.chat.title}>
            {detail?.chat.title ?? "New chat"}
          </h1>
        </header>

        {empty ? (
          <div className="hero">
            <h1>
              Ask anything. <span className="accent">We&rsquo;ll check the answer.</span>
            </h1>
            <p className="muted">
              A second model pulls the claims out of every reply, checks them against web sources, and marks what it
              finds in the margin.
            </p>
            <button className="hero__models" onClick={() => setShowSettings(true)} title="Change models">
              {modelLabel(settings.mainModel)} <span className="sep">→</span> checked by {modelLabel(settings.checkerModel)}
            </button>
          </div>
        ) : (
          <div className="thread">
            <TurnRail messages={messages} onJump={() => (followRef.current = false)} />
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                claims={claimsByMessage.get(m.id) ?? []}
                streaming={m.id === streamingId}
                analysing={analysingIds.has(m.id)}
                extracting={extractingIds.has(m.id)}
                showSupported={settings.showSupported}
                minImportance={settings.minImportance}
                queueCorrections={settings.queueCorrections}
                onToggleQueue={(on) => {
                  const s = { ...settings, queueCorrections: on };
                  setSettings(s);
                  saveSettings(s);
                }}
                activeClaimId={activeClaimId}
                onSelect={setActiveClaimId}
                onRecheck={recheck}
                onRetryCheck={() => retryCheck(m.id)}
                onSendCorrections={() => send("", true)}
              />
            ))}
          </div>
        )}

        <div className="composer-wrap">
          {error && (
            <div className="error" onClick={() => setError(null)}>
              {error}
            </div>
          )}
          {keysLoaded && !hasKeys && (
            <div className="notice">
              <button className="link" onClick={() => setShowSettings(true)}>
                {Object.keys(keys).length ? `Add or switch on a ${PROVIDERS[missing].label} key` : "Add an API key"}
              </button>{" "}
              {Object.keys(keys).length ? `for ${modelLabel(missingModel)}, or pick another model.` : "to start."}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={empty ? "Ask a question…" : "Follow up…"}
              rows={1}
              autoFocus
            />
            <select
              className="composer__model"
              value={settings.mainModel}
              onChange={(e) => {
                const s = { ...settings, mainModel: e.target.value };
                setSettings(s);
                saveSettings(s);
              }}
              aria-label="Chat model"
              title="Model for the next answer (switch any time; earlier answers keep theirs)"
            >
              {PROVIDER_IDS.map((p) => {
                const ids = [
                  ...MODELS.filter((m) => m.provider === p && m.main).map((m) => m.id),
                  ...(p === "openrouter" ? settings.openrouterModels.map((slug) => `${OPENROUTER_PREFIX}${slug}`) : []),
                ];
                // Only models with a key in use, plus the current one so the menu never goes blank.
                const shown = ids.filter((id) => usableKeys[p] || id === settings.mainModel);
                if (!shown.length) return null;
                return (
                  <optgroup key={p} label={PROVIDERS[p].label}>
                    {shown.map((id) => (
                      <option key={id} value={id}>
                        {p === "openrouter" ? openRouterSlug(id) : modelLabel(id)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <button
              className="send"
              type="submit"
              disabled={busy || !draft.trim() || !hasKeys}
              aria-label="Send"
              title={hasKeys ? undefined : "Add an API key in Settings first"}
            >
              ↑
            </button>
          </form>
          {!empty && (
            <UsageMeter messages={messages} claims={[...claims.values()]} onClick={() => setShowSettings(true)} />
          )}
        </div>
      </main>

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showBugReport && <BugReportDialog onClose={() => setShowBugReport(false)} />}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          keys={keys}
          keyFailures={keyFailures}
          onClose={() => setShowSettings(false)}
          onSave={(s, k) => {
            // A replaced key hasn't been tried yet, so it's no longer marked as failed.
            for (const p of Object.keys(keyFailures) as Provider[]) if (k[p] !== keys[p]) noteKey({ provider: p, ok: true });
            setSettings(s);
            saveSettings(s);
            setKeys(k);
            saveKeys(k);
          }}
        />
      )}
    </div>
  );
}
