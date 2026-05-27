import { useCallback, useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";
import type { RegimeStressResponse } from "../../api/types";

interface Props {
  portfolioId: number;
}

const REGIME_META: { key: "risk_on" | "risk_off" | "transition"; label: string; hint: string }[] = [
  { key: "risk_on", label: "Risk-On", hint: "Calm markets, rising appetite for stocks" },
  { key: "risk_off", label: "Risk-Off", hint: "Fear / flight to safety, falling stocks" },
  { key: "transition", label: "Transition", hint: "In-between / unsettled regime" },
];

const DAY_OPTIONS = [
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1825 },
  { label: "10Y", days: 3650 },
];

// Raw return decimal → percent string. 0.15 → "+15.0%"
function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function retColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "text-terminal-dim";
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-dim";
}

export function PortfolioRegimeStressTab({ portfolioId }: Props) {
  const [data, setData] = useState<RegimeStressResponse | null>(null);
  const [days, setDays] = useState(1825);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    portfolioApi
      .regimeStress(portfolioId, days)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3 p-3 overflow-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-2xs text-terminal-dim flex-1 min-w-[200px]">
          How each holding has performed inside each market regime over the lookback window. Returns are
          compounded across every stretch of that regime — a quick read on what would hurt or help if the
          market mood shifts.
        </p>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.days}
              type="button"
              onClick={() => setDays(o.days)}
              className={`pill text-2xs ${days === o.days ? "bg-accent/20 text-accent" : "text-terminal-dim hover:text-terminal-fg border border-terminal-border"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="p-4 text-terminal-dim text-xs text-center">Loading regime stress data...</div>}
      {err && <div className="p-3 text-accent-red text-xs">{err}</div>}

      {!loading && !err && data && (
        <>
          {/* Aggregate-by-regime cards */}
          <div>
            <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
              Whole-Portfolio Return by Regime
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {REGIME_META.map((rm) => {
                const v = data.aggregate_by_regime[rm.key];
                return (
                  <div key={rm.key} className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
                    <div className="text-2xs text-terminal-dim uppercase leading-tight">{rm.label}</div>
                    <div className={`text-base font-semibold tabular-nums mt-0.5 ${retColor(v)}`}>{fmtPct(v)}</div>
                    <div className="text-2xs text-terminal-muted mt-0.5 leading-tight">{rm.hint}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Segments */}
          {data.segments.length > 0 && (
            <div>
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">
                Regime Segments ({data.segments.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {data.segments.map((s, i) => (
                  <span
                    key={`${s.label}-${s.start}-${i}`}
                    className={`pill text-2xs ${
                      s.label === "risk_on" ? "bg-green-900/30 text-green-300"
                      : s.label === "risk_off" ? "bg-red-900/30 text-red-300"
                      : "bg-amber-900/30 text-amber-300"
                    }`}
                    title={`${s.start} → ${s.end} (${s.days}d)`}
                  >
                    {s.label.replace("_", "-")} · {s.start} → {s.end} · {s.days}d
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Per-holding table */}
          <div>
            <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">Per-Holding Returns by Regime</div>
            <div className="overflow-auto border border-terminal-border/50 rounded">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
                  <tr>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left">Ticker</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Weight</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Risk-On</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Risk-Off</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Transition</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Total</th>
                    <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Data Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p) => (
                    <tr key={p.ticker} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                      <td className="px-2 py-1.5 font-mono text-accent font-semibold">{p.ticker}</td>
                      <td className="px-2 py-1.5 font-mono text-right text-terminal-dim">{(p.weight * 100).toFixed(1)}%</td>
                      <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${retColor(p.regime_returns.risk_on)}`}>{fmtPct(p.regime_returns.risk_on)}</td>
                      <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${retColor(p.regime_returns.risk_off)}`}>{fmtPct(p.regime_returns.risk_off)}</td>
                      <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${retColor(p.regime_returns.transition)}`}>{fmtPct(p.regime_returns.transition)}</td>
                      <td className={`px-2 py-1.5 font-mono text-right tabular-nums font-semibold ${retColor(p.total_return)}`}>{fmtPct(p.total_return)}</td>
                      <td className="px-2 py-1.5 font-mono text-right text-terminal-dim">{p.data_points}</td>
                    </tr>
                  ))}
                  {data.positions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-terminal-dim text-xs">
                        No holdings to analyze. Add buy transactions first.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
