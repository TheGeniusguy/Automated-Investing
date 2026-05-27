import { useEffect, useRef, useState } from "react";

import { api, streamSSE } from "../api/client";
import type { SectorBriefingCached, SectorBriefingContext } from "../api/types";

interface Props {
  sectorId: string;
}

type Status = "idle" | "streaming" | "done" | "error";

/**
 * Sector AI Briefing panel — the moat play.
 *
 * Loads any cached briefing for today on mount. The user can hit "Regenerate"
 * to stream a fresh one. Same SSE transport as the global daily briefing.
 *
 * Without ANTHROPIC_API_KEY configured, the backend streams the structured
 * context payload + a "configure key" stub so the UI still tells the user
 * what data would be fed to Claude.
 */
export function SectorBriefingPanel({ sectorId }: Props) {
  const [cached, setCached] = useState<SectorBriefingCached | null>(null);
  const [context, setContext] = useState<SectorBriefingContext | null>(null);
  const [text, setText] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [showContext, setShowContext] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Load cached briefing for this sector on mount / sector change.
  useEffect(() => {
    setCached(null);
    setContext(null);
    setText("");
    setStatus("idle");
    setErr(null);
    api
      .sectorBriefingCached(sectorId)
      .then((c) => {
        setCached(c);
        if (c?.summary) {
          setText(c.summary);
          setContext(c.context);
          setStatus("done");
        }
      })
      .catch(() => {});
    return () => abortRef.current?.abort();
  }, [sectorId]);

  const regenerate = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setText("");
    setErr(null);
    setStatus("streaming");
    try {
      await streamSSE(
        `/api/sectors/${encodeURIComponent(sectorId)}/briefing/stream`,
        { method: "POST" },
        ctrl.signal,
        (event, data) => {
          if (event === "context" && typeof data === "object" && data !== null) {
            setContext(data as SectorBriefingContext);
          } else if (event === "token") {
            const t = typeof data === "string" ? data : ((data as { text?: string }).text ?? "");
            setText((prev) => prev + t);
          } else if (event === "error") {
            const msg = typeof data === "string" ? data : ((data as { error?: string }).error ?? "unknown");
            setErr(msg);
            setStatus("error");
          } else if (event === "done") {
            setStatus((s) => (s === "error" ? s : "done"));
            api.sectorBriefingCached(sectorId).then(setCached).catch(() => {});
          }
        },
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErr(String(e));
      setStatus("error");
    }
  };

  const isStreaming = status === "streaming";

  return (
    <section className="panel border-accent-cyan/30">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-xs text-accent-cyan uppercase tracking-wider font-semibold hover:text-accent-cyan/80"
        >
          <span>★ Sector Briefing</span>
          <span className="text-terminal-dim normal-case font-normal">
            {cached?.date ? `cached · ${cached.date}` : "no briefing yet today"}
          </span>
          <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
        </button>
        <div className="flex items-center gap-2">
          {context && (
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              className="text-2xs uppercase tracking-wider text-terminal-dim hover:text-terminal-muted"
            >
              {showContext ? "hide" : "show"} context
            </button>
          )}
          <button
            type="button"
            onClick={regenerate}
            disabled={isStreaming}
            className="text-2xs uppercase tracking-wider px-2 py-1 rounded border border-accent-cyan/50 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isStreaming ? "streaming..." : text ? "regenerate" : "generate"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3">
          {showContext && context && <ContextSummary ctx={context} />}

          {err && (
            <div className="text-xs text-rose-400 border border-rose-500/40 bg-rose-500/5 rounded px-2 py-1 mb-2">
              {err}
            </div>
          )}

          {!text && status === "idle" && (
            <div className="text-terminal-dim text-xs italic py-4 text-center">
              No briefing generated today. Click <span className="text-accent-cyan">Generate</span> to
              stream a fresh AI briefing scoped to this sector.
            </div>
          )}

          {text && (
            <article className="text-sm leading-relaxed text-terminal-muted whitespace-pre-wrap">
              {text}
              {isStreaming && <span className="animate-pulse text-accent-cyan">▍</span>}
            </article>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Context summary sidebar ───────────────────────────────────────────────

function ContextSummary({ ctx }: { ctx: SectorBriefingContext }) {
  return (
    <div className="border border-terminal-border/40 bg-terminal-panel/30 rounded p-2 mb-3 text-2xs">
      <div className="text-terminal-dim uppercase tracking-wider mb-1.5">
        Context fed to Claude
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <ContextBlock label="Top contributors (1m)">
          {ctx.top_contributors_1m.map((c) => (
            <div key={c.symbol} className="font-mono">
              {c.symbol}{" "}
              <span className="text-green-400">
                +{(c.contribution_1m_pct ?? 0).toFixed(2)}pp
              </span>
              <span className="text-terminal-dim"> ({c.weight_pct.toFixed(1)}%)</span>
            </div>
          ))}
          {ctx.top_contributors_1m.length === 0 && <span className="text-terminal-dim">--</span>}
        </ContextBlock>

        <ContextBlock label="Bottom contributors (1m)">
          {ctx.bottom_contributors_1m.map((c) => (
            <div key={c.symbol} className="font-mono">
              {c.symbol}{" "}
              <span className="text-rose-400">
                {(c.contribution_1m_pct ?? 0).toFixed(2)}pp
              </span>
              <span className="text-terminal-dim"> ({c.weight_pct.toFixed(1)}%)</span>
            </div>
          ))}
          {ctx.bottom_contributors_1m.length === 0 && <span className="text-terminal-dim">--</span>}
        </ContextBlock>

        <ContextBlock label="Top macro drivers">
          {ctx.top_macro_drivers.map((d) => (
            <div key={d.id} className="font-mono">
              {d.label}{" "}
              <span className={d.correlation >= 0 ? "text-green-400" : "text-rose-400"}>
                {d.correlation >= 0 ? "+" : ""}{d.correlation.toFixed(2)}
              </span>
            </div>
          ))}
          {ctx.top_macro_drivers.length === 0 && <span className="text-terminal-dim">--</span>}
        </ContextBlock>

        {ctx.breadth && (
          <ContextBlock label="Breadth">
            <div>
              {ctx.breadth.above_50ma_pct?.toFixed(0)}% &gt;50ma ·{" "}
              {ctx.breadth.above_200ma_pct?.toFixed(0)}% &gt;200ma
            </div>
            <div>
              {ctx.breadth.at_52w_high_pct?.toFixed(0)}% @52wH ·{" "}
              {ctx.breadth.at_52w_low_pct?.toFixed(0)}% @52wL
            </div>
            {ctx.breadth.avg_dist_from_52w_high_pct !== null && (
              <div>
                avg dist from 52wH:{" "}
                <span className="font-mono">
                  {ctx.breadth.avg_dist_from_52w_high_pct.toFixed(1)}%
                </span>
              </div>
            )}
          </ContextBlock>
        )}

        {ctx.concentration && (
          <ContextBlock label="Concentration">
            <div>
              Herf <span className="font-mono">{ctx.concentration.herfindahl.toFixed(2)}</span>
            </div>
            <div>
              Top1 <span className="font-mono">{ctx.concentration.top1_weight_pct.toFixed(1)}%</span> ·
              Top3 <span className="font-mono">{ctx.concentration.top3_weight_pct.toFixed(1)}%</span>
            </div>
          </ContextBlock>
        )}

        {ctx.hidden_weakness && (
          <ContextBlock label="⚠ Hidden weakness" className="text-amber-400">
            <div>
              {ctx.hidden_weakness.window}: basket{" "}
              <span className="font-mono">+{ctx.hidden_weakness.basket_return_pct.toFixed(2)}%</span>
            </div>
            <div>
              {ctx.hidden_weakness.n_negative}/{ctx.hidden_weakness.n_constituents} negative
            </div>
            <div className="font-mono">
              {ctx.hidden_weakness.masking_names.map((m) => m.symbol).join(", ")}
            </div>
          </ContextBlock>
        )}
      </div>

      {ctx.recent_news.length > 0 && (
        <div className="mt-2">
          <div className="text-terminal-dim uppercase tracking-wider mb-1">Recent news</div>
          <ul className="space-y-0.5">
            {ctx.recent_news.slice(0, 3).map((n, i) => (
              <li key={i} className="truncate">
                <span className="text-terminal-dim">{n.publisher} · </span>
                <span className="text-terminal-muted">{n.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ContextBlock({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div>
      <div className={`text-terminal-dim uppercase tracking-wider text-2xs mb-0.5 ${className}`}>
        {label}
      </div>
      <div className="text-terminal-muted">{children}</div>
    </div>
  );
}
