import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { CorrelationBreakdown, CorrelationsResponse } from "../api/types";
import { CorrelationMatrix } from "./CorrelationMatrix";

type Mode = "recent" | "baseline" | "delta";

const RECENT_WINDOWS = [
  { label: "10d", days: 10 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

/**
 * Panel 3 — Cross-Asset Correlation Breakdown Detector.
 *
 * Left: heatmap of pairwise correlations across the watchlist, toggleable
 * between recent / baseline / delta views.
 * Right: ranked list of "most decoupled" pairs — sign flips first, then
 * by absolute change in correlation.
 */
export function CorrelationsPanel() {
  const [recentDays, setRecentDays] = useState<number>(30);
  const [mode, setMode] = useState<Mode>("delta");
  const [data, setData] = useState<CorrelationsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.correlations(recentDays, 365)
      .then((d) => {
        if (!alive) return;
        setData(d);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [recentDays]);

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-3">
        <div className="panel h-full">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <span>Correlation Matrix</span>
              <span className="normal-case tracking-normal text-terminal-dim">
                {data?.dates.first ? `${data.dates.first} → ${data.dates.last}` : "—"}
              </span>
            </div>
            <ModeToggle mode={mode} setMode={setMode} />
          </div>
          <div className="panel-body flex flex-col">
            <RecentWindowBar recentDays={recentDays} setRecentDays={setRecentDays} />
            {err && <div className="text-accent-red text-xs mb-2">⚠ {err}</div>}
            {!err && loading && !data && (
              <div className="text-terminal-dim text-xs">Computing correlations…</div>
            )}
            {data && (
              <CorrelationMatrix
                tickers={data.tickers}
                groups={data.groups}
                matrix={data.matrix}
                mode={mode}
              />
            )}
            <Legend mode={mode} />
          </div>
        </div>
      </div>

      <div className="col-span-2">
        <BreakdownList
          breakdowns={data?.breakdowns ?? []}
          recentDays={data?.recent_days ?? recentDays}
          baselineDays={data?.baseline_days ?? 365}
          loading={loading}
        />
      </div>
    </div>
  );
}

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const items: { value: Mode; label: string }[] = [
    { value: "recent",   label: "recent" },
    { value: "baseline", label: "baseline" },
    { value: "delta",    label: "Δ" },
  ];
  return (
    <span className="flex items-center gap-1 normal-case tracking-normal">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => setMode(it.value)}
          className={
            "px-1.5 py-0.5 transition border " +
            (mode === it.value
              ? "border-accent-amber/60 text-accent-amber"
              : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
          }
        >
          {it.label}
        </button>
      ))}
    </span>
  );
}

function RecentWindowBar({
  recentDays,
  setRecentDays,
}: {
  recentDays: number;
  setRecentDays: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-2xs uppercase tracking-wider text-terminal-muted">
      <span>recent</span>
      {RECENT_WINDOWS.map((w) => (
        <button
          key={w.days}
          onClick={() => setRecentDays(w.days)}
          className={
            "px-2 py-0.5 border transition " +
            (w.days === recentDays
              ? "border-accent-amber/60 text-accent-amber"
              : "border-terminal-divider hover:border-terminal-muted hover:text-terminal-text")
          }
        >
          {w.label}
        </button>
      ))}
      <span className="ml-2 text-terminal-dim normal-case">
        vs 1y baseline
      </span>
    </div>
  );
}

function Legend({ mode }: { mode: Mode }) {
  if (mode === "delta") {
    return (
      <div className="mt-3 flex items-center gap-3 text-2xs text-terminal-muted">
        <Swatch color="rgba(59,130,246,0.7)" label="decoupling (Δ < 0)" />
        <Swatch color="rgba(255,184,0,0.7)" label="coupling-up (Δ > 0)" />
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-3 text-2xs text-terminal-muted">
      <Swatch color="rgba(239,68,68,0.7)"  label="negative" />
      <Swatch color="rgba(34,197,94,0.7)"  label="positive" />
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-3 h-3 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function BreakdownList({
  breakdowns,
  recentDays,
  baselineDays,
  loading,
}: {
  breakdowns: CorrelationBreakdown[];
  recentDays: number;
  baselineDays: number;
  loading: boolean;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Most Decoupled Pairs</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {recentDays}d vs {Math.round(baselineDays / 365)}y
        </span>
      </div>
      <div className="panel-body p-0 overflow-auto">
        {loading && breakdowns.length === 0 ? (
          <div className="p-3 text-terminal-dim text-xs">Scanning watchlist…</div>
        ) : breakdowns.length === 0 ? (
          <div className="p-3 text-terminal-dim text-xs">
            No correlation breakdowns detected. Either the watchlist is too small or current
            correlations match their baseline.
          </div>
        ) : (
          <ul className="divide-y divide-terminal-divider text-xs">
            {breakdowns.map((b) => (
              <li key={`${b.a}-${b.b}`} className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-accent-amber">
                    {short(b.a)} <span className="text-terminal-dim">↔</span> {short(b.b)}
                  </span>
                  {b.flipped && (
                    <span className="pill bg-accent-red/15 text-accent-red border border-accent-red/40">
                      FLIPPED
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 tabular-nums text-terminal-muted">
                  <span>
                    <span className="text-terminal-dim">base </span>
                    <Corr v={b.baseline} />
                  </span>
                  <span className="text-terminal-dim">→</span>
                  <span>
                    <span className="text-terminal-dim">recent </span>
                    <Corr v={b.recent} />
                  </span>
                  <span className="ml-auto">
                    Δ <Delta v={b.delta} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Corr({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  const cls = v > 0 ? "text-accent-green" : v < 0 ? "text-accent-red" : "text-terminal-muted";
  return <span className={cls}>{v >= 0 ? "+" : ""}{v.toFixed(2)}</span>;
}

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  const cls = v > 0 ? "text-accent-amber" : v < 0 ? "text-accent-blue" : "text-terminal-muted";
  return <span className={cls}>{v >= 0 ? "+" : ""}{v.toFixed(2)}</span>;
}

function short(t: string): string {
  return t.replace(/^\^/, "").replace(/-USD$/, "").replace(/\.NYB$/, "");
}
