import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { SectorRotationResponse } from "../api/types";

/**
 * Sector Rotation panel — 11 SPDR sector ETFs over 1w / 1m / 3m / 6m / YTD / 1y.
 * Shows absolute return and relative-to-SPY return in a color-coded heatmap.
 */
export function SectorRotationPanel() {
  const [data, setData] = useState<SectorRotationResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showRelative, setShowRelative] = useState(false);

  useEffect(() => {
    api.sectorRotation().then(setData).catch((e) => setErr(String(e)));
  }, []);

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">SECTOR ROTATION</span>
          <span className="text-xs text-terminal-dim">
            11 SPDR sectors vs {data?.benchmark.ticker ?? "SPY"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRelative(false)}
            className={`pill text-xs ${!showRelative ? "bg-accent text-black" : ""}`}
          >
            Absolute
          </button>
          <button
            type="button"
            onClick={() => setShowRelative(true)}
            className={`pill text-xs ${showRelative ? "bg-accent text-black" : ""}`}
          >
            vs SPY
          </button>
        </div>
      </header>
      <div className="panel-body flex-1 overflow-auto">
        {err && <div className="text-rose-400 text-xs p-2">Error: {err}</div>}
        {!data && !err && <div className="text-terminal-dim text-xs p-2">Loading…</div>}
        {data && (
          <table className="w-full text-xs">
            <thead className="text-terminal-dim uppercase tracking-wide">
              <tr>
                <th className="text-left py-1 px-2">Sector</th>
                <th className="text-right py-1 px-2">Ticker</th>
                <th className="text-right py-1 px-2">Last</th>
                {data.windows.map((w) => (
                  <th key={w.key} className="text-right py-1 px-2">{w.label}</th>
                ))}
              </tr>
              <tr className="text-terminal-dim border-b border-terminal-border">
                <td colSpan={3} className="text-right py-1 px-2 italic">benchmark {data.benchmark.ticker}</td>
                {data.windows.map((w) => (
                  <td key={w.key} className="text-right py-1 px-2 tabular-nums">
                    {fmtPct(data.benchmark.returns[w.key])}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sectors.map((s) => (
                <tr key={s.ticker} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                  <td className="py-1 px-2">{s.name}</td>
                  <td className="text-right py-1 px-2 font-mono">{s.ticker}</td>
                  <td className="text-right py-1 px-2 tabular-nums text-terminal-dim">
                    {s.last_close != null ? s.last_close.toFixed(2) : "—"}
                  </td>
                  {data.windows.map((w) => {
                    const r = s.returns[w.key];
                    const v = showRelative ? r?.rel : r?.abs;
                    return (
                      <td key={w.key} className="text-right py-1 px-2 tabular-nums" style={{ color: pctColor(v) }}>
                        {fmtPct(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function pctColor(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  // Linear interpolate between dim and accent green/red around 0.
  const clamped = Math.max(-10, Math.min(10, v));
  const intensity = Math.min(1, Math.abs(clamped) / 10);
  if (v >= 0) return `rgb(${110 - intensity * 60},${220 - intensity * 40},${130 - intensity * 50})`;
  return `rgb(${230 - intensity * 30},${110 - intensity * 50},${120 - intensity * 50})`;
}
