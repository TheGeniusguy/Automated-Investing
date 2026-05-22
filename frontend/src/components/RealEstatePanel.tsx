import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { ReOverview, ReSubsectorDetail } from "../api/types";
import { TechnicalIndicatorsPanel } from "./TechnicalIndicatorsPanel";

type View = "overview" | "subsector";

export function RealEstatePanel() {
  const [view, setView] = useState<View>("overview");
  const [overview, setOverview] = useState<ReOverview | null>(null);
  const [subsector, setSubsector] = useState<ReSubsectorDetail | null>(null);
  const [activeSubsectorId, setActiveSubsectorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showRelative, setShowRelative] = useState(false);
  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState("market_cap");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    api.realEstateOverview()
      .then((d) => { setOverview(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, []);

  const openSubsector = (id: string) => {
    setActiveSubsectorId(id);
    setView("subsector");
    setLoading(true);
    setErr(null);
    setActiveChart(null);
    api.realEstateSubsector(id)
      .then((d) => { setSubsector(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  };

  const handleSort = (key: string) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };
  const sortArrow = (key: string) => sortKey === key ? (sortAsc ? " \u25B2" : " \u25BC") : "";

  const sortedStocks = subsector
    ? [...subsector.stocks].sort((a, b) => {
        let av: number | null = null;
        let bv: number | null = null;
        if (sortKey === "market_cap") { av = a.market_cap; bv = b.market_cap; }
        else if (sortKey === "pe_ratio") { av = a.pe_ratio; bv = b.pe_ratio; }
        else if (sortKey === "dividend_yield") { av = a.dividend_yield; bv = b.dividend_yield; }
        else if (sortKey === "price_to_book") { av = a.price_to_book; bv = b.price_to_book; }
        else if (sortKey === "payout_ratio") { av = a.payout_ratio; bv = b.payout_ratio; }
        else if (sortKey === "debt_to_equity") { av = a.debt_to_equity; bv = b.debt_to_equity; }
        else if (sortKey === "last_close") { av = a.last_close; bv = b.last_close; }
        else if (sortKey.match(/^(1d|1w|1m|3m|6m|1y)$/)) {
          const ar = a.returns[sortKey];
          const br = b.returns[sortKey];
          av = showRelative ? ar?.rel ?? null : ar?.abs ?? null;
          bv = showRelative ? br?.rel ?? null : br?.abs ?? null;
        }
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return sortAsc ? av - bv : bv - av;
      })
    : [];

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          {view === "subsector" && (
            <button type="button" onClick={() => { setView("overview"); setActiveChart(null); }} className="pill text-xs hover:bg-terminal-border/50">&larr;</button>
          )}
          <span className="text-accent font-semibold">REAL ESTATE</span>
          <span className="text-xs text-terminal-dim">
            {view === "overview" ? "Sub-sector Overview" : subsector?.name ?? ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowRelative(false)} className={`pill text-xs ${!showRelative ? "bg-accent text-black" : ""}`}>Absolute</button>
          <button type="button" onClick={() => setShowRelative(true)} className={`pill text-xs ${showRelative ? "bg-accent text-black" : ""}`}>vs Benchmark</button>
        </div>
      </header>

      <div className="panel-body flex-1 overflow-auto">
        {err && <div className="text-rose-400 text-xs p-2">Error: {err}</div>}

        {/* ── Overview ── */}
        {view === "overview" && !loading && overview && (
          <>
            {/* Benchmark ETFs */}
            <div className="p-2">
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-1">RE Benchmarks</h3>
              <div className="grid grid-cols-5 gap-2">
                {overview.benchmarks.map((b) => (
                  <div key={b.ticker} className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
                    <div className="text-accent text-xs font-semibold">{b.ticker}</div>
                    <div className="text-sm tabular-nums">{b.last_close != null ? `$${b.last_close.toFixed(2)}` : "--"}</div>
                    <div className="flex gap-2 mt-1">
                      {["1d", "1m", "1y"].map((w) => {
                        const r = b.returns[w];
                        const v = showRelative ? r?.rel : r?.abs;
                        return (
                          <div key={w} className="text-center">
                            <div className="text-2xs text-terminal-dim">{w.toUpperCase()}</div>
                            <div className="text-2xs tabular-nums" style={{ color: pctColor(v) }}>{fmtPct(v)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sub-sector grid */}
            <div className="p-2">
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-1">Sub-sectors ({overview.subsectors.length})</h3>
              <div className="grid grid-cols-3 gap-2">
                {overview.subsectors.map((ss) => (
                  <button
                    key={ss.id}
                    type="button"
                    onClick={() => openSubsector(ss.id)}
                    className="text-left bg-terminal-bg border border-terminal-border/50 rounded p-2 hover:border-accent/50 transition-colors"
                  >
                    <div className="text-xs text-accent font-semibold">{ss.name}</div>
                    <div className="text-2xs text-terminal-dim mt-0.5">{ss.description}</div>
                    <div className="text-2xs text-terminal-muted mt-1">
                      {ss.stock_count} stocks{ss.etfs.length > 0 ? ` | ETFs: ${ss.etfs.join(", ")}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Sub-sector detail ── */}
        {view === "subsector" && loading && (
          <div className="text-terminal-dim text-xs p-4">Loading {activeSubsectorId}...</div>
        )}

        {view === "subsector" && !loading && subsector && (
          <>
            {/* Inline TA chart */}
            {activeChart && (
              <div className="border-b border-terminal-border">
                <div className="flex items-center justify-between px-3 py-1.5 bg-terminal-panel/60">
                  <span className="text-xs text-accent font-semibold">Technical Analysis: {activeChart}</span>
                  <button type="button" onClick={() => setActiveChart(null)} className="pill text-xs hover:bg-terminal-border/50">Close</button>
                </div>
                <div style={{ height: 550 }}>
                  <TechnicalIndicatorsPanel initialSymbol={activeChart} />
                </div>
              </div>
            )}

            {/* Benchmark + ETFs */}
            <div className="p-2 flex gap-3 items-center text-xs">
              <span className="text-terminal-dim">Benchmark: {subsector.benchmark.ticker}</span>
              {subsector.etfs.map((e) => (
                <span key={e.ticker} className="font-mono text-accent">{e.ticker} ${e.last_close?.toFixed(2) ?? "--"}</span>
              ))}
            </div>

            {/* Stock table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-terminal-dim uppercase tracking-wide">
                  <tr>
                    <th className="py-1 px-1 w-8"></th>
                    <ThBtn label="Symbol" k="symbol" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="Name" k="name" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} left />
                    <ThBtn label="Last" k="last_close" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="Mkt Cap" k="market_cap" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="P/E" k="pe_ratio" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="P/B" k="price_to_book" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="Div %" k="dividend_yield" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="Payout" k="payout_ratio" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <ThBtn label="D/E" k="debt_to_equity" sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    {subsector.windows.map((w) => (
                      <ThBtn key={w.key} label={w.label} k={w.key} sortKey={sortKey} onClick={handleSort} arrow={sortArrow} />
                    ))}
                    <th className="text-right py-1 px-2">Industry</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStocks.map((s) => (
                    <tr key={s.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                      <td className="py-1 px-1">
                        <button
                          type="button"
                          onClick={() => setActiveChart(activeChart === s.symbol ? null : s.symbol)}
                          className={`text-xs px-1.5 py-0.5 rounded ${activeChart === s.symbol ? "bg-accent text-black" : "text-terminal-dim hover:text-accent hover:bg-terminal-border/30"}`}
                        >TA</button>
                      </td>
                      <td className="py-1 px-2 font-mono">
                        <button type="button" onClick={() => setActiveChart(s.symbol)} className="text-accent hover:underline">{s.symbol}</button>
                      </td>
                      <td className="py-1 px-2 truncate max-w-[140px]">{s.name}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.last_close != null ? s.last_close.toFixed(2) : "--"}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{fmtCap(s.market_cap)}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.pe_ratio != null ? s.pe_ratio.toFixed(1) : "--"}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.price_to_book != null ? s.price_to_book.toFixed(2) : "--"}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.dividend_yield != null ? `${(s.dividend_yield * 100).toFixed(2)}%` : "--"}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.payout_ratio != null ? `${(s.payout_ratio * 100).toFixed(0)}%` : "--"}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{s.debt_to_equity != null ? s.debt_to_equity.toFixed(0) : "--"}</td>
                      {subsector.windows.map((w) => {
                        const r = s.returns[w.key];
                        const v = showRelative ? r?.rel : r?.abs;
                        return (
                          <td key={w.key} className="text-right py-1 px-2 tabular-nums" style={{ color: pctColor(v) }}>{fmtPct(v)}</td>
                        );
                      })}
                      <td className="text-right py-1 px-2 text-terminal-dim truncate max-w-[120px]">{s.industry ?? "--"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {loading && view === "overview" && <div className="text-terminal-dim text-xs p-4">Loading RE overview...</div>}
      </div>
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ThBtn({ label, k, sortKey: _sortKey, onClick, arrow, left }: {
  label: string; k: string; sortKey: string;
  onClick: (k: string) => void; arrow: (k: string) => string; left?: boolean;
}) {
  return (
    <th className={`py-1 px-2 cursor-pointer select-none hover:text-accent ${left ? "text-left" : "text-right"}`}>
      <button type="button" onClick={() => onClick(k)} className="w-full text-inherit">{label}{arrow(k)}</button>
    </th>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtCap(v: number | null | undefined): string {
  if (v == null) return "--";
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(v);
}

function pctColor(v: number | null | undefined): string | undefined {
  if (v == null) return undefined;
  const clamped = Math.max(-10, Math.min(10, v));
  const intensity = Math.min(1, Math.abs(clamped) / 10);
  if (v >= 0) return `rgb(${110 - intensity * 60},${220 - intensity * 40},${130 - intensity * 50})`;
  return `rgb(${230 - intensity * 30},${110 - intensity * 50},${120 - intensity * 50})`;
}
