import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { SectorDetailResponse, SectorKpisResponse } from "../api/types";
import { TechnicalIndicatorsPanel } from "./TechnicalIndicatorsPanel";

interface SectorDetailPanelProps {
  sectorId: string;
  onBack: () => void;
}

export function SectorDetailPanel({ sectorId, onBack }: SectorDetailPanelProps) {
  const [data, setData] = useState<SectorDetailResponse | null>(null);
  const [kpis, setKpis] = useState<SectorKpisResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRelative, setShowRelative] = useState(false);
  const [sortKey, setSortKey] = useState<string>("market_cap");
  const [sortAsc, setSortAsc] = useState(false);
  const [activeChart, setActiveChart] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    setData(null);
    setKpis(null);
    api
      .sectorDetail(sectorId)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
    // KPIs load independently so they don't block the main table
    api.sectorKpis(sectorId).then(setKpis).catch(() => {});
  }, [sectorId]);

  const sortedStocks = data
    ? [...data.stocks].sort((a, b) => {
        let av: number | null = null;
        let bv: number | null = null;
        if (sortKey === "market_cap") {
          av = a.market_cap;
          bv = b.market_cap;
        } else if (sortKey === "pe_ratio") {
          av = a.pe_ratio;
          bv = b.pe_ratio;
        } else if (sortKey === "dividend_yield") {
          av = a.dividend_yield;
          bv = b.dividend_yield;
        } else if (sortKey === "last_close") {
          av = a.last_close;
          bv = b.last_close;
        } else if (sortKey.match(/^(1d|1w|1m|3m|6m|1y)$/)) {
          const ar = a.returns[sortKey];
          const br = b.returns[sortKey];
          av = showRelative ? ar?.rel ?? null : ar?.abs ?? null;
          bv = showRelative ? br?.rel ?? null : br?.abs ?? null;
        }
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return sortAsc ? av - bv : bv - av;
      })
    : [];

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const sortArrow = (key: string) =>
    sortKey === key ? (sortAsc ? " \u25B2" : " \u25BC") : "";

  return (
    <div className="h-full flex flex-col bg-terminal-bg text-terminal-fg overflow-auto">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-terminal-panel border-b border-terminal-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="pill text-xs hover:bg-terminal-border/50"
          >
            &larr; Back
          </button>
          <div>
            <h2 className="text-accent font-semibold text-sm">
              {data?.name ?? sectorId.toUpperCase()}
            </h2>
            <p className="text-terminal-dim text-2xs">{data?.description}</p>
          </div>
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

      {loading && (
        <div className="flex-1 flex items-center justify-center text-terminal-dim text-sm">
          Loading sector data...
        </div>
      )}
      {err && (
        <div className="p-4 text-rose-400 text-xs">Error: {err}</div>
      )}

      {/* Inline TA chart for selected stock */}
      {activeChart && (
        <div className="border-b border-terminal-border">
          <div className="flex items-center justify-between px-4 py-2 bg-terminal-panel/60">
            <span className="text-xs text-accent font-semibold">
              Technical Analysis: {activeChart}
            </span>
            <button
              type="button"
              onClick={() => setActiveChart(null)}
              className="pill text-xs hover:bg-terminal-border/50"
            >
              Close Chart
            </button>
          </div>
          <div style={{ height: 600 }}>
            <TechnicalIndicatorsPanel initialSymbol={activeChart} />
          </div>
        </div>
      )}

      {data && !loading && (
        <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
          {/* ETF summary bar */}
          <div className="panel p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-accent font-semibold text-sm">{data.etf.ticker}</span>
                <span className="text-terminal-dim text-xs ml-2">{data.etf.name}</span>
              </div>
              <span className="tabular-nums text-sm">
                {data.etf.last_close != null ? `$${data.etf.last_close.toFixed(2)}` : "--"}
              </span>
            </div>
            <div className="flex gap-3 flex-wrap">
              {data.windows.map((w) => {
                const r = data.etf.returns[w.key];
                const v = showRelative ? r?.rel : r?.abs;
                return (
                  <div key={w.key} className="text-center">
                    <div className="text-terminal-dim text-2xs uppercase">{w.label}</div>
                    <div
                      className="tabular-nums text-xs font-medium"
                      style={{ color: pctColor(v) }}
                    >
                      {fmtPct(v)}
                    </div>
                  </div>
                );
              })}
              {data.etf.market_cap != null && (
                <div className="text-center ml-auto">
                  <div className="text-terminal-dim text-2xs uppercase">Mkt Cap</div>
                  <div className="text-xs">{fmtCap(data.etf.market_cap)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Sector KPI cards */}
          {kpis ? (
            <div className="grid grid-cols-5 gap-2">
              {kpis.kpi_defs.map((def) => {
                const v = kpis.sector_medians[def.key];
                return (
                  <div
                    key={def.key}
                    className="panel p-2 flex flex-col gap-0.5"
                    title={def.desc}
                  >
                    <span className="text-terminal-dim text-2xs uppercase tracking-wider truncate">
                      {def.label}
                    </span>
                    <span className="tabular-nums text-sm font-semibold text-accent">
                      {v == null
                        ? "--"
                        : def.unit === "x"
                          ? `${v.toFixed(1)}x`
                          : def.unit === "days"
                            ? `${v.toFixed(0)}d`
                            : `${v.toFixed(1)}%`}
                    </span>
                    <span className="text-terminal-dim text-2xs">
                      median · {def.unit}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="panel p-2 h-14 animate-pulse bg-terminal-panel/60" />
              ))}
            </div>
          )}

          {/* Sub-industries */}
          <div className="flex gap-2 flex-wrap">
            {data.sub_industries.map((si) => (
              <span key={si} className="pill text-2xs bg-terminal-border/40">
                {si}
              </span>
            ))}
          </div>

          {/* Benchmark row */}
          <div className="text-xs text-terminal-dim flex gap-3 px-1">
            <span>Benchmark: {data.benchmark.ticker}</span>
            {data.windows.map((w) => (
              <span key={w.key} className="tabular-nums">
                {w.label} {fmtPct(data.benchmark.returns[w.key])}
              </span>
            ))}
          </div>

          {/* Key Stocks table */}
          <section>
            <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-2">
              Key Stocks ({data.stocks.length})
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-terminal-dim uppercase tracking-wide">
                  <tr>
                    <th className="py-1 px-2 text-left w-8"></th>
                    <Th label="Symbol" sortKey="symbol" current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <Th label="Name" sortKey="name" current={sortKey} onClick={handleSort} arrow={sortArrow} className="text-left" />
                    <Th label="Last" sortKey="last_close" current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <Th label="Mkt Cap" sortKey="market_cap" current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <Th label="P/E" sortKey="pe_ratio" current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    <Th label="Div %" sortKey="dividend_yield" current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    {data.windows.map((w) => (
                      <Th key={w.key} label={w.label} sortKey={w.key} current={sortKey} onClick={handleSort} arrow={sortArrow} />
                    ))}
                    <th className="text-right py-1 px-2">Industry</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStocks.map((s) => (
                    <tr key={s.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                      <td className="py-1.5 px-1">
                        <button
                          type="button"
                          onClick={() => setActiveChart(activeChart === s.symbol ? null : s.symbol)}
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            activeChart === s.symbol
                              ? "bg-accent text-black"
                              : "text-terminal-dim hover:text-accent hover:bg-terminal-border/30"
                          }`}
                          title={`Chart ${s.symbol}`}
                        >
                          TA
                        </button>
                      </td>
                      <td className="py-1.5 px-2 font-mono">
                        <button
                          type="button"
                          onClick={() => setActiveChart(s.symbol)}
                          className="text-accent hover:underline"
                        >
                          {s.symbol}
                        </button>
                      </td>
                      <td className="py-1.5 px-2 truncate max-w-[160px]">{s.name}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums">
                        {s.last_close != null ? s.last_close.toFixed(2) : "--"}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums">{fmtCap(s.market_cap)}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums">
                        {s.pe_ratio != null ? s.pe_ratio.toFixed(1) : "--"}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums">
                        {s.dividend_yield != null ? `${(s.dividend_yield * 100).toFixed(2)}%` : "--"}
                      </td>
                      {data.windows.map((w) => {
                        const r = s.returns[w.key];
                        const v = showRelative ? r?.rel : r?.abs;
                        return (
                          <td
                            key={w.key}
                            className="text-right py-1.5 px-2 tabular-nums"
                            style={{ color: pctColor(v) }}
                          >
                            {fmtPct(v)}
                          </td>
                        );
                      })}
                      <td className="text-right py-1.5 px-2 text-terminal-dim truncate max-w-[140px]">
                        {s.industry ?? "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Per-stock KPI breakdown */}
          {kpis && kpis.stocks.length > 0 && (
            <section>
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-2">
                KPI Breakdown — Top Stocks
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-terminal-dim uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1 px-2">Symbol</th>
                      {kpis.kpi_defs.map((def) => (
                        <th
                          key={def.key}
                          className="text-right py-1 px-2"
                          title={def.desc}
                        >
                          {def.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Sector median row */}
                    <tr className="border-b-2 border-terminal-border bg-terminal-panel/40">
                      <td className="py-1.5 px-2 text-accent-amber font-semibold">Median</td>
                      {kpis.kpi_defs.map((def) => {
                        const v = kpis.sector_medians[def.key] as number | null;
                        return (
                          <td key={def.key} className="text-right py-1.5 px-2 tabular-nums text-accent-amber font-semibold">
                            {fmtKpiValue(v, def.unit)}
                          </td>
                        );
                      })}
                    </tr>
                    {kpis.stocks.map((row) => (
                      <tr key={String(row.symbol)} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                        <td className="py-1.5 px-2 font-mono text-accent">{String(row.symbol)}</td>
                        {kpis.kpi_defs.map((def) => {
                          const v = row[def.key] as number | null;
                          return (
                            <td key={def.key} className="text-right py-1.5 px-2 tabular-nums">
                              {fmtKpiValue(v, def.unit)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Related ETFs */}
          {data.related_etfs.length > 0 && (
            <section>
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-2">
                Related ETFs
              </h3>
              <table className="w-full text-xs">
                <thead className="text-terminal-dim uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-1 px-2">Ticker</th>
                    <th className="text-right py-1 px-2">Last</th>
                    {data.windows.map((w) => (
                      <th key={w.key} className="text-right py-1 px-2">{w.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.related_etfs.map((etf) => (
                    <tr key={etf.ticker} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                      <td className="py-1.5 px-2 font-mono text-accent">{etf.ticker}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums">
                        {etf.last_close != null ? etf.last_close.toFixed(2) : "--"}
                      </td>
                      {data.windows.map((w) => {
                        const r = etf.returns[w.key];
                        const v = showRelative ? r?.rel : r?.abs;
                        return (
                          <td
                            key={w.key}
                            className="text-right py-1.5 px-2 tabular-nums"
                            style={{ color: pctColor(v) }}
                          >
                            {fmtPct(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function Th({
  label,
  sortKey,
  current: _current,
  onClick,
  arrow,
  className,
}: {
  label: string;
  sortKey: string;
  current: string;
  onClick: (k: string) => void;
  arrow: (k: string) => string;
  className?: string;
}) {
  return (
    <th className={`py-1 px-2 cursor-pointer select-none hover:text-accent ${className ?? "text-right"}`}>
      <button type="button" onClick={() => onClick(sortKey)} className="w-full text-inherit">
        {label}
        {arrow(sortKey)}
      </button>
    </th>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtCap(v: number | null | undefined): string {
  if (v === null || v === undefined) return "--";
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(v);
}

function fmtKpiValue(v: number | null | undefined, unit: string): string {
  if (v == null) return "--";
  if (unit === "x") return `${v.toFixed(1)}x`;
  if (unit === "days") return `${v.toFixed(0)}d`;
  // % values
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function pctColor(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const clamped = Math.max(-10, Math.min(10, v));
  const intensity = Math.min(1, Math.abs(clamped) / 10);
  if (v >= 0) return `rgb(${110 - intensity * 60},${220 - intensity * 40},${130 - intensity * 50})`;
  return `rgb(${230 - intensity * 30},${110 - intensity * 50},${120 - intensity * 50})`;
}
