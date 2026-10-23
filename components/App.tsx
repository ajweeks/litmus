"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  authHeaders,
  loadApiKey,
  loadOpenRouterKey,
  loadSettings,
  saveApiKey,
  saveOpenRouterKey,
  saveSettings,
  streamChat,
} from "@/lib/client";
import type { ChatDetail, ChatMessage, ChatSummary, Claim, Settings, StreamEvent } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { MessageView } from "./MessageView";
import { UsageMeter } from "./UsageMeter";
import { SettingsDialog } from "./SettingsDialog";
import { isPending } from "./status";

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [serverKey, setServerKey] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [claims, setClaims] = useState<Map<string, Claim>>(new Map());
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Answers whose claim extraction/checking stream is still open (so "no claims" isn't premature). */
  const [analysingIds, setAnalysingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const openStreams = useRef(0);
  /** ID of the send that currently owns the busy/streaming state. */
  const currentSend = useRef<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  /** Whether the view follows new content. Any upward scroll gesture detaches it; reaching the bottom re-attaches. */
  const followRef = useRef(true);

  // ---------- loading ----------

  const refreshChats = useCallback(async () => {
    const res = await fetch("/api/chats");
    if (res.ok) setChats(await res.json());
  }, []);

  const loadChat = useCallback(async (id: string, quiet = false) => {
    const res = await fetch(`/api/chats/${id}`);
    if (!res.ok) {
      if (!quiet) setError("Chat not found.");
      return;
    }
    const d: ChatDetail = await res.json();
    if (chatIdRef.current !== id && quiet) return;
    setChatId(id);
    setMessages(d.messages);
    setClaims(new Map(d.claims.map((c) => [c.id, c])));
  }, []);

  useEffect(() => {
    setSettings(loadSettings());
    setApiKey(loadApiKey());
    refreshChats();
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setServerKey(c.serverKey));
    const id = new URLSearchParams(location.search).get("c");
    if (id) loadChat(id);
  }, [refreshChats, loadChat]);

  const selectChat = (id: string | null) => {
    setSidebarOpen(false);
    setActiveClaimId(null);
    setError(null);
    // A reply still streaming elsewhere keeps going on the server; don't block this chat on it.
    currentSend.current = null;
    setBusy(false);
    setStreamingId(null);
    history.replaceState(null, "", id ? `/?c=${id}` : "/");
    if (id) loadChat(id);
    else {
      setChatId(null);
      setMessages([]);
      setClaims(new Map());
    }
  };

  // If a reload or a dropped connection left claims mid-check, poll until the server finishes them.
  const anyPending = useMemo(() => [...claims.values()].some((c) => isPending(c.status)), [claims]);
  useEffect(() => {
    if (!anyPending || !chatId) return;
    const t = setInterval(() => {
      if (openStreams.current === 0) loadChat(chatId, true);
    }, 4000);
    return () => clearInterval(t);
  }, [anyPending, chatId, loadChat]);

  // ---------- sending ----------

  const upsertClaim = (c: Claim) => setClaims((prev) => new Map(prev).set(c.id, c));

  const send = async (content: string, correctionRequest = false) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    followRef.current = true;
    const tempId = `tmp_${Date.now()}`;
    if (!correctionRequest)
      setMessages((m) => [
        ...m,
        {
          id: tempId,
          chatId: chatId ?? "",
          role: "user",
          content,
          kind: "normal",
          model: null,
          checkSummary: null,
          createdAt: Date.now(),
        },
      ]);
    const startedIn = chatId;
    currentSend.current = tempId;
    openStreams.current++;

    let streamChatId = startedIn;
    let assistantId: string | null = null;

    const onEvent = (e: StreamEvent) => {
      // Ignore events for a chat the user has navigated away from (the server keeps saving them).
      if (e.type === "meta") {
        if (chatIdRef.current !== startedIn) return;
        streamChatId = e.chatId;
      } else if (chatIdRef.current !== streamChatId) return;

      switch (e.type) {
        case "meta": {
          if (!startedIn) {
            history.replaceState(null, "", `/?c=${e.chatId}`);
            chatIdRef.current = e.chatId;
            setChatId(e.chatId);
            refreshChats();
          }
          const placeholder: ChatMessage = {
            id: e.assistantMessageId,
            chatId: e.chatId,
            role: "assistant",
            content: "",
            kind: "normal",
            model: settings.mainModel,
            checkSummary: null,
            createdAt: Date.now(),
          };
          setMessages((m) => [
            ...m.filter((x) => x.id !== tempId),
            e.userMessage,
            ...(e.systemMessage ? [e.systemMessage] : []),
            placeholder,
          ]);
          setStreamingId(e.assistantMessageId);
          assistantId = e.assistantMessageId;
          setAnalysingIds((prev) => new Set(prev).add(e.assistantMessageId));
          if (e.fedBackClaimIds.length)
            setClaims((prev) => {
              const next = new Map(prev);
              for (const id of e.fedBackClaimIds) {
                const c = next.get(id);
                if (c) next.set(id, { ...c, fedBackIn: e.systemMessage!.id });
              }
              return next;
            });
          break;
        }
        case "text":
          setMessages((m) => {
            const last = m[m.length - 1];
            if (!last || last.role !== "assistant") return m;
            return [...m.slice(0, -1), { ...last, content: last.content + e.delta }];
          });
          break;
        case "message_done":
          setMessages((m) => m.map((x) => (x.id === e.message.id ? e.message : x)));
          if (currentSend.current === tempId) {
            setStreamingId(null);
            setBusy(false);
          }
          break;
        case "claim":
          upsertClaim(e.claim);
          break;
        case "summary":
          setMessages((m) =>
            m.map((x) => (x.id === e.message.id ? { ...x, checkSummary: e.message.checkSummary, usage: e.message.usage } : x)),
          );
          break;
        case "error":
          setError(e.message);
          break;
      }
    };

    try {
      await streamChat({ chatId: chatId ?? undefined, content, correctionRequest, settings }, onEvent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages((m) => m.filter((x) => x.id !== tempId));
      if (!correctionRequest) setDraft(content);
    } finally {
      openStreams.current--;
      if (assistantId) {
        const id = assistantId;
        setAnalysingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      if (currentSend.current === tempId) {
        currentSend.current = null;
        setStreamingId(null);
        setBusy(false);
      }
      refreshChats();
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    send(text);
  };

  const recheck = async (id: string) => {
    const c = claims.get(id);
    if (!c) return;
    upsertClaim({ ...c, status: "verifying" });
    const res = await fetch(`/api/claims/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ model: settings.checkerModel, minImportance: settings.minImportance }),
    });
    if (res.ok) {
      const { claim, message } = (await res.json()) as { claim: Claim; message: ChatMessage | null };
      upsertClaim(claim);
      if (message)
        setMessages((m) =>
          m.map((x) => (x.id === message.id ? { ...x, checkSummary: message.checkSummary, usage: message.usage } : x)),
        );
    } else {
      upsertClaim(c);
      setError((await res.json().catch(() => ({}))).error ?? "Re-check failed.");
    }
  };

  const deleteChat = async (id: string) => {
    if (!confirm("Delete this chat and its claims?")) return;
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (id === chatId) selectChat(null);
    refreshChats();
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

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            ✓
          </span>
          <span className="brand__name">
            fact<b>/</b>check
          </span>
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
          <Link href="/claims">Claims database</Link>
          <button className="link" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setSidebarOpen(false)} />

      <main className={`main${empty ? " main--empty" : ""}`}>
        <header className="topbar">
          <button className="link menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            ☰
          </button>
          <button className="topbar__mode" onClick={() => setShowSettings(true)}>
            <span>{settings.mainModel}</span>
            <span className="sep">→</span>
            <span>checked by {settings.checkerModel}</span>
            <span className="pill pill--mode">
              {{ facts: "facts", judgments: "facts + judgments", critique: "full critique" }[settings.strictness]}
            </span>
          </button>
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
          </div>
        ) : (
          <div className="thread">
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                claims={claimsByMessage.get(m.id) ?? []}
                streaming={m.id === streamingId}
                analysing={analysingIds.has(m.id)}
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
          {!apiKey && !serverKey && (
            <div className="notice">
              <button className="link" onClick={() => setShowSettings(true)}>
                Add your Anthropic API key
              </button>{" "}
              to start.
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
            <button className="send" type="submit" disabled={busy || !draft.trim()} aria-label="Send">
              ↑
            </button>
          </form>
          {!empty && <UsageMeter messages={messages} claims={[...claims.values()]} />}
        </div>
      </main>

      {showSettings && (
        <SettingsDialog
          settings={settings}
          apiKey={apiKey}
          openrouterKey={loadOpenRouterKey()}
          onClose={() => setShowSettings(false)}
          onSave={(s, k, orKey) => {
            saveOpenRouterKey(orKey);
            setSettings(s);
            saveSettings(s);
            setApiKey(k.trim());
            saveApiKey(k);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}
