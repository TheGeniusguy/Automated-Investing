import { useEffect, useRef, useState } from "react";

import { streamSSE } from "../api/client";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const STARTER_PROMPTS = [
  "What regime are we in and what should I be watching?",
  "Which correlation breakdown is the most actionable right now?",
  "Walk me through the VIX term structure — what's it pricing in?",
  "What earnings event in the next 14 days has the highest implied move?",
  "Summarize the most material 8-K filings this week.",
];

/**
 * Panel 11 — Ask the Terminal.
 *
 * Conversational surface over every other panel. Each turn re-injects the
 * full terminal snapshot (regime + correlations + VIX + earnings + filings
 * + news) so Claude reasons against fresh state. Conversation history is
 * kept in component state and passed back each turn for coherence.
 */
export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [streaming, setStreaming] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [snapshotTime, setSnapshotTime] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");
    setErr(null);

    const userMsg: ChatMessage = { role: "user", content, timestamp: Date.now() };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);

    // Add an empty assistant message we'll stream into
    setMessages([...newHistory, { role: "assistant", content: "", timestamp: Date.now() }]);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);

    try {
      await streamSSE(
        "/api/chat/stream",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: newHistory.map((m) => ({ role: m.role, content: m.content })),
          }),
        },
        ctrl.signal,
        (event, data) => {
          if (event === "snapshot" && typeof data === "object" && data !== null) {
            const s = data as { as_of?: string };
            setSnapshotTime(s.as_of ?? null);
          } else if (event === "token") {
            const t = typeof data === "string" ? data : ((data as { text?: string }).text ?? "");
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, content: last.content + t };
              }
              return copy;
            });
          }
        },
      );
    } catch (e) {
      if (!ctrl.signal.aborted) setErr(String(e));
    } finally {
      setStreaming(false);
    }
  };

  const clear = () => {
    abortRef.current?.abort();
    setMessages([]);
    setSnapshotTime(null);
    setErr(null);
  };

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span>Ask the Terminal</span>
          {snapshotTime && (
            <span className="normal-case tracking-normal text-terminal-dim">
              snapshot {snapshotTime.slice(11, 16)}Z
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 normal-case tracking-normal">
          {messages.length > 0 && (
            <button
              onClick={clear}
              className="text-terminal-muted hover:text-accent-red transition"
            >
              clear
            </button>
          )}
        </div>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-auto p-3 space-y-3 text-xs">
        {messages.length === 0 && !err && (
          <div className="space-y-2">
            <div className="text-terminal-dim">
              Ask anything about the markets. Claude has access to every other panel's
              live data: regime, correlations, VIX, earnings, filings, news.
            </div>
            <div className="grid grid-cols-1 gap-1 mt-2">
              {STARTER_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => send(p)}
                  className="text-left border border-terminal-divider px-2 py-1.5
                             text-terminal-muted hover:text-accent-amber hover:border-accent-amber/40 transition"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} m={m} streaming={streaming && i === messages.length - 1 && m.role === "assistant"} />
        ))}
        {err && <div className="text-accent-red">⚠ {err}</div>}
      </div>

      <div className="px-3 py-2 border-t border-terminal-border flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder={streaming ? "streaming…" : "ask a question"}
          disabled={streaming}
          spellCheck={false}
          className="flex-1 bg-black/40 border border-terminal-divider
                     text-terminal-text font-mono text-xs px-2 py-1.5 outline-none
                     focus:border-accent-amber/60 disabled:opacity-60"
        />
        <button
          onClick={() => send()}
          disabled={streaming || input.trim().length === 0}
          className={
            "px-3 py-1.5 border text-2xs uppercase tracking-wider transition " +
            (streaming || input.trim().length === 0
              ? "border-terminal-divider text-terminal-dim cursor-not-allowed"
              : "border-accent-amber/60 text-accent-amber hover:bg-accent-amber/10")
          }
        >
          send
        </button>
      </div>
    </div>
  );
}

function Message({ m, streaming }: { m: ChatMessage; streaming: boolean }) {
  const isUser = m.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          "max-w-[85%] px-3 py-2 border whitespace-pre-wrap leading-relaxed " +
          (isUser
            ? "border-accent-amber/40 bg-accent-amber/5 text-terminal-text"
            : "border-terminal-divider bg-black/20 text-terminal-text")
        }
      >
        <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">
          {isUser ? "you" : "terminal"}
        </div>
        {m.content || (streaming ? <span className="text-terminal-dim">thinking…</span> : null)}
        {streaming && (
          <span className="inline-block w-2 h-4 ml-0.5 bg-accent-amber animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
}
