import { useState } from "react";

import type { SectorSubIndustriesResponse, SubIndustryRow } from "../api/types";

interface Props {
  data: SectorSubIndustriesResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Sub-Industries panel.
 *
 * Drills the sector into editorial sub-groups (e.g. Tech -> Software / Hardware
 * / AI-GPU / Services). For the selected window shows a horizontal bar chart
 * of cap-weighted returns sorted descending, with weight % of sector as the
 * x-position label. Each row expands to show its constituent stocks.
 */
export function SectorSubIndustriesPanel({ data, expanded, onToggle }: Props) {
  const [window, setWindow] = useState<string>("1m");
  const [openSub, setOpenSub] = useState<string | null>(null);

  return (
    <section className="panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
      >
        <span className="text-terminal-muted uppercase tracking-wider font-semibold">
          Sub-industries
          {data?.available && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              {data.sub_industries.length} groups · which slice is leading
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading sub-industries...</div>
          ) : !data.available ? (
            <div className="text-terminal-dim text-xs py-2 italic">{data.reason}</div>
          ) : (
            <>
              <div className="flex gap-1 flex-wrap">
                {data.windows.map((w) => (
                  <button
                    key={w.key}
                    type="button"
                    onClick={() => setWindow(w.key)}
                    className={`px-2 py-0.5 text-2xs rounded uppercase tracking-wider ${
                      window === w.key
                        ? "bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40"
                        : "bg-terminal-panel/40 text-terminal-dim border border-terminal-border/40 hover:border-terminal-border"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <SubIndustriesBars
                rows={data.sub_industries}
                window={window}
                openSub={openSub}
                onToggleSub={(name) => setOpenSub((s) => (s === name ? null : name))}
              />

              <div className="text-2xs text-terminal-dim italic">{data.notes}</div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Bars + drilldown rows ─────────────────────────────────────────────────

function SubIndustriesBars({
  rows,
  window,
  openSub,
  onToggleSub,
}: {
  rows: SubIndustryRow[];
  window: string;
  openSub: string | null;
  onToggleSub: (name: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => {
    const ar = a.returns_pct[window] ?? -Infinity;
    const br = b.returns_pct[window] ?? -Infinity;
    return br - ar;
  });
  const maxAbs = Math.max(
    ...sorted.map((r) => Math.abs(r.returns_pct[window] ?? 0)),
    0.5,
  );

  return (
    <div className="space-y-1">
      {sorted.map((r) => {
        const ret = r.returns_pct[window];
        const top = r.top_per_window[window];
        const barPct = ret !== null && ret !== undefined ? (Math.abs(ret) / maxAbs) * 100 : 0;
        const color = ret === null || ret === undefined
          ? "bg-terminal-dim/30"
          : ret > 0
            ? "bg-green-500/40"
            : "bg-rose-500/40";
        const isOpen = openSub === r.name;
        return (
          <div key={r.name} className="border border-terminal-border/30 rounded">
            <button
              type="button"
              onClick={() => onToggleSub(r.name)}
              className="w-full flex items-center gap-2 text-xs px-2 py-1 hover:bg-terminal-border/20"
            >
              <span className="w-44 text-left font-semibold truncate" title={r.name}>
                {r.name}
              </span>
              <span className="w-12 text-right text-2xs text-terminal-dim font-mono">
                {r.weight_pct_of_sector?.toFixed(1)}%
              </span>
              <span className="w-8 text-right text-2xs text-terminal-dim font-mono">
                n={r.stock_count}
              </span>
              <div className="flex-1 relative h-4 bg-terminal-panel/30 rounded">
                <div
                  className={`absolute top-0 h-full ${color} rounded`}
                  style={{
                    width: `${barPct / 2}%`,
                    left: ret !== null && ret !== undefined && ret > 0 ? "50%" : `${50 - barPct / 2}%`,
                  }}
                />
                <div className="absolute inset-0 border-l border-terminal-border/50" style={{ left: "50%" }} />
              </div>
              <span
                className={`w-16 text-right font-mono tabular-nums text-2xs ${
                  ret === null || ret === undefined
                    ? "text-terminal-dim"
                    : ret > 0
                      ? "text-green-400"
                      : "text-rose-400"
                }`}
              >
                {ret === null || ret === undefined ? "--" : `${ret > 0 ? "+" : ""}${ret.toFixed(2)}%`}
              </span>
              <span className="w-32 text-right text-2xs text-terminal-dim truncate">
                {top ? (
                  <>
                    top: <span className="font-mono text-terminal-muted">{top.symbol}</span>{" "}
                    <span className={top.return_pct > 0 ? "text-green-400" : "text-rose-400"}>
                      {top.return_pct > 0 ? "+" : ""}{top.return_pct.toFixed(1)}%
                    </span>
                  </>
                ) : (
                  <span className="text-terminal-dim">--</span>
                )}
              </span>
              <span className="text-terminal-dim w-3">{isOpen ? "−" : "+"}</span>
            </button>

            {isOpen && <SubIndustryDrilldown row={r} window={window} />}
          </div>
        );
      })}
    </div>
  );
}

function SubIndustryDrilldown({ row, window }: { row: SubIndustryRow; window: string }) {
  const totalCap = row.total_market_cap ?? 0;
  return (
    <div className="bg-terminal-panel/30 px-2 py-1.5 border-t border-terminal-border/30">
      <table className="w-full text-2xs">
        <thead className="text-terminal-dim uppercase tracking-wider">
          <tr>
            <th className="text-left py-0.5">Ticker</th>
            <th className="text-right py-0.5">Mkt cap</th>
            <th className="text-right py-0.5">% of sub-industry</th>
            <th className="text-right py-0.5">{window} return</th>
            <th className="text-right py-0.5">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {row.members.map((m) => {
            const weight = m.market_cap && totalCap > 0 ? m.market_cap / totalCap : null;
            const ret = m.returns_pct[window];
            const contribution = weight !== null && ret !== null && ret !== undefined ? weight * ret : null;
            return (
              <tr key={m.symbol} className="border-t border-terminal-border/20">
                <td className="py-0.5 font-mono font-semibold">{m.symbol}</td>
                <td className="py-0.5 text-right text-terminal-dim font-mono tabular-nums">
                  {m.market_cap ? `$${(m.market_cap / 1e9).toFixed(0)}B` : "--"}
                </td>
                <td className="py-0.5 text-right text-terminal-dim font-mono tabular-nums">
                  {weight === null ? "--" : `${(weight * 100).toFixed(1)}%`}
                </td>
                <td
                  className={`py-0.5 text-right font-mono tabular-nums ${
                    ret === null || ret === undefined
                      ? "text-terminal-dim"
                      : ret > 0
                        ? "text-green-400"
                        : "text-rose-400"
                  }`}
                >
                  {ret === null || ret === undefined ? "--" : `${ret > 0 ? "+" : ""}${ret.toFixed(2)}%`}
                </td>
                <td
                  className={`py-0.5 text-right font-mono tabular-nums ${
                    contribution === null
                      ? "text-terminal-dim"
                      : contribution > 0
                        ? "text-green-400"
                        : "text-rose-400"
                  }`}
                >
                  {contribution === null ? "--" : `${contribution > 0 ? "+" : ""}${contribution.toFixed(2)}pp`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
