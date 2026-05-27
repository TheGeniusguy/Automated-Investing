import { useEffect, useState } from "react";

import { fixedIncomeApi } from "../api/client";
import type { FixedIncomeOverviewResponse } from "../api/types";

/**
 * Fixed Income panel — US Treasury yields across maturities (with daily change
 * in bps) + curve shape (2s10s spread, classification), and a bond-ETF tracking
 * table with price, yield proxy, and 1M / YTD price change.
 */
export function FixedIncomePanel() {
  const [data, setData] = useState<FixedIncomeOverviewResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fixedIncomeApi
      .overview()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const shape = data?.treasuries?.shape;

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <span className="text-accent-amber font-semibold tracking-wider">FIXED INCOME</span>
        {shape && (
          <span className="text-2xs text-terminal-dim">
            2s10s{" "}
            <span className={pnlBps(shape.spread_2_10_bps)}>{fmtBps(shape.spread_2_10_bps)}</span>
            <span className="ml-2 uppercase tracking-wide">{shape.classification}</span>
          </span>
        )}
      </header>

      <div className="panel-body flex-1 overflow-auto p-2 space-y-4">
        {loading && <div className="text-terminal-dim text-xs">Loading fixed income…</div>}
        {err && <div className="text-accent-red text-xs">Error: {err}</div>}

        {/* Treasury yield curve */}
        {data && data.treasuries.maturities.length > 0 && (
          <div>
            <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1">
              US Treasury Yields{data.treasuries.date ? ` · ${data.treasuries.date}` : ""}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-terminal-dim uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-1 px-2">Maturity</th>
                    <th className="text-right py-1 px-2">Yield</th>
                    <th className="text-right py-1 px-2">Δ Day (bps)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.treasuries.maturities.map((m) => (
                    <tr key={m.maturity} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                      <td className="py-1 px-2 font-mono">{m.maturity}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{fmtPct(m.yield_pct)}</td>
                      <td className={`text-right py-1 px-2 tabular-nums ${pnlBps(m.change_bps)}`}>{fmtBps(m.change_bps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shape && (
              <div className="flex gap-4 text-2xs text-terminal-dim pt-1">
                <span>2s10s {fmtBps(shape.spread_2_10_bps)}</span>
                <span>3m10y {fmtBps(shape.spread_3m_10y_bps)}</span>
                <span>10s30s {fmtBps(shape.spread_10_30_bps)}</span>
              </div>
            )}
          </div>
        )}

        {/* Bond ETFs */}
        {data && data.bond_etfs.length > 0 && (
          <div>
            <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1">Bond ETFs</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-terminal-dim uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-1 px-2">Symbol</th>
                    <th className="text-left py-1 px-2">Tracks</th>
                    <th className="text-right py-1 px-2">Price</th>
                    <th className="text-right py-1 px-2">Yield</th>
                    <th className="text-right py-1 px-2">1M</th>
                    <th className="text-right py-1 px-2">YTD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bond_etfs.map((e) => (
                    <tr key={e.symbol} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                      <td className="py-1 px-2 font-mono">{e.symbol}</td>
                      <td className="py-1 px-2 text-terminal-dim truncate max-w-[160px]">{e.tracks}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{fmtNum(e.price)}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{fmtPct(e.yield_pct)}</td>
                      <td className={`text-right py-1 px-2 tabular-nums ${pnl(e.change_1m_pct)}`}>{fmtPct(e.change_1m_pct)}</td>
                      <td className={`text-right py-1 px-2 tabular-nums ${pnl(e.change_ytd_pct)}`}>{fmtPct(e.change_ytd_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {data &&
          data.treasuries.maturities.length === 0 &&
          data.bond_etfs.length === 0 &&
          !loading && (
            <div className="text-terminal-dim text-xs italic">
              No fixed-income data available (Treasury yields require a FRED key).
            </div>
          )}
      </div>
    </section>
  );
}

function pnl(v: number | null): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function pnlBps(v: number | null): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtBps(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

function fmtNum(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
