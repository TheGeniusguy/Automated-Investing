import { useEffect, useState } from "react";

import { fxApi } from "../api/client";
import type { FxMatrixResponse } from "../api/types";

/**
 * FX panel — major USD pairs + crosses with 1d / 1m % change, plus the
 * Dollar Index (DXY) level and trend. Tables only; reading the rate and the
 * color-coded change at a glance is the point.
 */
export function FXPanel() {
  const [data, setData] = useState<FxMatrixResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fxApi
      .matrix()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const dxy = data?.dxy;

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <span className="text-accent-amber font-semibold tracking-wider">FX / CURRENCIES</span>
        {dxy?.level != null && (
          <span className="text-2xs text-terminal-dim">
            DXY {dxy.level.toFixed(2)}{" "}
            <span className={pnl(dxy.change_1d_pct)}>{fmtPct(dxy.change_1d_pct)}</span>
            {dxy.trend && <span className="ml-2 uppercase tracking-wide">{dxy.trend}</span>}
          </span>
        )}
      </header>

      <div className="panel-body flex-1 overflow-auto p-2 space-y-3">
        {loading && <div className="text-terminal-dim text-xs">Loading FX…</div>}
        {err && <div className="text-accent-red text-xs">Error: {err}</div>}

        {dxy && (
          <div className="flex items-center gap-4 text-xs border border-terminal-border rounded px-3 py-2">
            <div>
              <div className="text-2xs text-terminal-dim uppercase tracking-wide">Dollar Index (DXY)</div>
              <div className="text-lg tabular-nums">{dxy.level != null ? dxy.level.toFixed(2) : "—"}</div>
            </div>
            <div className="text-right">
              <div className="text-2xs text-terminal-dim">1D</div>
              <div className={`tabular-nums ${pnl(dxy.change_1d_pct)}`}>{fmtPct(dxy.change_1d_pct)}</div>
            </div>
            <div className="text-right">
              <div className="text-2xs text-terminal-dim">1M</div>
              <div className={`tabular-nums ${pnl(dxy.change_1m_pct)}`}>{fmtPct(dxy.change_1m_pct)}</div>
            </div>
          </div>
        )}

        {data && data.pairs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Pair</th>
                  <th className="text-right py-1 px-2">Rate</th>
                  <th className="text-right py-1 px-2">1D</th>
                  <th className="text-right py-1 px-2">1M</th>
                </tr>
              </thead>
              <tbody>
                {data.pairs.map((p) => (
                  <tr key={p.symbol} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                    <td className="py-1 px-2 font-mono">{p.pair}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtRate(p.rate)}</td>
                    <td className={`text-right py-1 px-2 tabular-nums ${pnl(p.change_1d_pct)}`}>{fmtPct(p.change_1d_pct)}</td>
                    <td className={`text-right py-1 px-2 tabular-nums ${pnl(p.change_1m_pct)}`}>{fmtPct(p.change_1m_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pairs.length === 0 && !loading && (
          <div className="text-terminal-dim text-xs italic">No FX data available.</div>
        )}
      </div>
    </section>
  );
}

function pnl(v: number | null): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtRate(v: number | null): string {
  if (v == null) return "—";
  const decimals = v >= 100 ? 2 : 4;
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
