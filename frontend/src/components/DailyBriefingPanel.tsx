import { useEffect, useRef, useState } from "react";

import { api, streamSSE } from "../api/client";
import type { DailyBriefingCached, DailyBriefingContext } from "../api/types";

/**
 * Panel 10 — Daily Briefing.
 *
 * A morning-coffee synthesis. Left: streaming Claude briefing (3 short
 * paragraphs: setup / what changed / what to watch). Right: a structured
 * "what's in the prompt" sidebar so the user always sees the context that
 * produced the prose. Persisted to DuckDB by date.
 */
export function DailyBriefingPanel() {
  const [cached, setCached] = useState<DailyBriefingCached | null>(null);
  const [context, setContext] = useState<DailyBriefingContext | null>(null);
  const [text, setText] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Initial load: check if today's briefing is already cached
  useEffect(() => {
    api.dailyBriefingCached().then((c) => {
      setCached(c);
      if (c?.summary) {
        setText(c.summary);
        setContext(c.context);
        setStatus("done");
      }
    }).catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [text]);

  const generate = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setText("");
    setErr(null);
    setStatus("streaming");
    try {
      await streamSSE(
        "/api/briefing/daily/stream",
        { method: "POST" },
        ctrl.signal,
        (event, data) => {
          if (event === "context" && typeof data === "object" && data !== null) {
            setContext(data as DailyBriefingContext);
          } else if (event === "token") {
            const t = typeof data === "string" ? data : ((data as { text?: string }).text ?? "");
            setText((prev) => prev + t);
          } else if (event === "done") {
            setStatus("done");
            // Refresh cached entry
            api.dailyBriefingCached().then(setCached).catch(() => {});
          }
        },
      );
      setStatus((s) => (s === "error" ? s : "done"));
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErr(String(e));
      setStatus("error");
    }
  };

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-3">
        <div className="panel h-full">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <span>Daily Briefing</span>
              {cached?.date && (
                <span className="normal-case tracking-normal text-terminal-dim">
                  {cached.date}
                </span>
              )}
              {context?.regime?.label && <RegimeBadge label={context.regime.label} />}
            </div>
            <button
              onClick={generate}
              disabled={status === "streaming"}
              className={
                "text-2xs uppercase tracking-wider transition normal-case tracking-normal " +
                (status === "streaming"
                  ? "text-accent-amber opacity-60 cursor-wait"
                  : "text-terminal-muted hover:text-accent-amber")
              }
            >
              {status === "streaming"
                ? "streaming…"
                : cached?.summary
                  ? "regenerate"
                  : "generate briefing"}
            </button>
          </div>
          <div ref={bodyRef} className="panel-body whitespace-pre-wrap leading-relaxed">
            {err && <div className="text-accent-red mb-2">⚠ {err}</div>}
            {!err && !text && status === "idle" && (
              <div className="text-terminal-dim">
                Click "generate briefing" to synthesize the day's signal:
                regime, correlations, vol structure, upcoming earnings, recent
                material filings — all into one 3-paragraph briefing.
              </div>
            )}
            <span>{text}</span>
            {status === "streaming" && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-accent-amber animate-pulse align-middle" />
            )}
          </div>
        </div>
      </div>

      <div className="col-span-2">
        <ContextSidebar context={context} />
      </div>
    </div>
  );
}

function RegimeBadge({ label }: { label: string }) {
  const map: Record<string, string> = {
    risk_on:    "bg-regime-on/15 text-regime-on border-regime-on/40",
    risk_off:   "bg-regime-off/15 text-regime-off border-regime-off/40",
    transition: "bg-regime-trans/15 text-regime-trans border-regime-trans/40",
  };
  const cls = map[label] ?? "border-terminal-divider text-terminal-muted";
  return (
    <span className={`pill border ${cls}`}>
      {label.replace("_", "-")}
    </span>
  );
}

function ContextSidebar({ context }: { context: DailyBriefingContext | null }) {
  if (!context) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Context</span></div>
        <div className="panel-body text-xs text-terminal-dim">
          Run the briefing to populate the structured context fed to Claude.
        </div>
      </div>
    );
  }
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>What Claude saw</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {context.as_of?.slice(0, 16) ?? ""}
        </span>
      </div>
      <div className="panel-body p-0 overflow-auto text-xs">
        <Section title="VIX term structure">
          {context.vix_term && (
            <div className="space-y-0.5">
              <Row k="structure" v={context.vix_term.structure ?? "—"} />
              <Row k="slope (6m-30d)" v={context.vix_term.slope !== null ? (context.vix_term.slope ?? 0).toFixed(2) : "—"} />
              {context.vix_term.tenors?.map((t) => (
                <Row key={t.ticker} k={t.label ?? t.ticker} v={t.value !== null ? (t.value ?? 0).toFixed(2) : "—"} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Top correlation breakdowns">
          <ul className="space-y-0.5">
            {context.top_breakdowns?.slice(0, 6).map((b, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-terminal-muted">
                  {b.a} <span className="text-terminal-dim">↔</span> {b.b}
                  {b.flipped && <span className="ml-1 text-accent-red">FLIP</span>}
                </span>
                <span className="text-accent-amber tabular-nums">
                  {b.delta !== null ? (b.delta >= 0 ? "+" : "") + (b.delta ?? 0).toFixed(2) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Upcoming earnings (≤14d)">
          {context.upcoming_earnings?.length ? (
            <ul className="space-y-0.5">
              {context.upcoming_earnings.map((e) => (
                <li key={e.symbol} className="flex justify-between">
                  <span className="text-accent-amber">{e.symbol}</span>
                  <span className="text-terminal-muted tabular-nums">{e.date} ({e.in_days}d)</span>
                </li>
              ))}
            </ul>
          ) : <span className="text-terminal-dim">None.</span>}
        </Section>

        <Section title="Recent 8-K filings (3d)">
          {context.recent_8k?.length ? (
            <ul className="space-y-0.5">
              {context.recent_8k.slice(0, 6).map((f, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="text-accent-amber whitespace-nowrap">{f.ticker}</span>
                  <span className="text-terminal-muted tabular-nums whitespace-nowrap">{f.filing_date}</span>
                  <a
                    href={f.url} target="_blank" rel="noreferrer"
                    className="text-terminal-text truncate hover:text-accent-amber"
                    title={f.items}
                  >
                    {f.items || "—"}
                  </a>
                </li>
              ))}
            </ul>
          ) : <span className="text-terminal-dim">None.</span>}
        </Section>

        <Section title="Top news">
          {context.top_news?.length ? (
            <ul className="space-y-0.5">
              {context.top_news.slice(0, 5).map((n, i) => (
                <li key={i} className="truncate text-terminal-text" title={n.title}>
                  <span className="text-terminal-muted text-2xs">{n.publisher}: </span>
                  {n.title}
                </li>
              ))}
            </ul>
          ) : <span className="text-terminal-dim">None.</span>}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 border-b border-terminal-divider">
      <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-terminal-muted">{k}</span>
      <span className="text-terminal-text tabular-nums">{v}</span>
    </div>
  );
}
