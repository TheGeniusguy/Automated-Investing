import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  EarningsCalendar,
  NewsItem,
  SectorBreadthResponse,
  SectorDetailResponse,
  SectorEarningsResponse,
  SectorKpisResponse,
  SectorMacroDriversResponse,
  SectorNewsResponse,
  SectorRegimePlaybookResponse,
  SectorRsResponse,
  SectorSupplyChainResponse,
} from "../api/types";
import { SectorRsChart } from "./SectorRsChart";
import { SectorSupplyChainMap } from "./SectorSupplyChainMap";
import { TechnicalIndicatorsPanel } from "./TechnicalIndicatorsPanel";

interface SectorDetailPanelProps {
  sectorId: string;
  onBack: () => void;
  onSelectSector?: (id: string) => void;
}

export function SectorDetailPanel({ sectorId, onBack, onSelectSector }: SectorDetailPanelProps) {
  const [data, setData] = useState<SectorDetailResponse | null>(null);
  const [kpis, setKpis] = useState<SectorKpisResponse | null>(null);
  const [macroDrivers, setMacroDrivers] = useState<SectorMacroDriversResponse | null>(null);
  const [showMacroDrivers, setShowMacroDrivers] = useState(false);
  const [supplyChain, setSupplyChain] = useState<SectorSupplyChainResponse | null>(null);
  const [sectorRs, setSectorRs] = useState<SectorRsResponse | null>(null);
  const [sectorNews, setSectorNews] = useState<SectorNewsResponse | null>(null);
  const [showNews, setShowNews] = useState(false);
  const [sectorEarnings, setSectorEarnings] = useState<SectorEarningsResponse | null>(null);
  const [showEarnings, setShowEarnings] = useState(false);
  const [breadth, setBreadth] = useState<SectorBreadthResponse | null>(null);
  const [regimePlaybook, setRegimePlaybook] = useState<SectorRegimePlaybookResponse | null>(null);
  const [showRegimePlaybook, setShowRegimePlaybook] = useState(false);
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
    setMacroDrivers(null);
    setShowMacroDrivers(false);
    setSupplyChain(null);
    setSectorRs(null);
    setSectorNews(null);
    setShowNews(false);
    setSectorEarnings(null);
    setShowEarnings(false);
    setBreadth(null);
    setRegimePlaybook(null);
    setShowRegimePlaybook(false);
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
    // All secondary data loads independently — main table never blocks
    api.sectorKpis(sectorId).then(setKpis).catch(() => {});
    api.sectorMacroDrivers(sectorId).then(setMacroDrivers).catch(() => {});
    api.sectorSupplyChain(sectorId).then(setSupplyChain).catch(() => {});
    api.sectorRelativeStrength(sectorId).then(setSectorRs).catch(() => {});
    api.sectorNews(sectorId).then(setSectorNews).catch(() => {});
    api.sectorEarnings(sectorId).then(setSectorEarnings).catch(() => {});
    api.sectorBreadth(sectorId).then(setBreadth).catch(() => {});
    api.sectorRegimePlaybook(sectorId).then(setRegimePlaybook).catch(() => {});
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

          {/* Relative Strength Chart */}
          <div className="panel p-3">
            {sectorRs && !sectorRs.error ? (
              <SectorRsChart data={sectorRs} />
            ) : (
              <div className="flex items-center justify-between h-10">
                <span className="text-terminal-dim text-xs uppercase tracking-wider">
                  Relative Strength vs SPY
                </span>
                <span className="text-terminal-dim text-2xs">
                  {sectorRs?.error ?? "Loading..."}
                </span>
              </div>
            )}
          </div>

          {/* Breadth Indicators strip */}
          {breadth?.summary && (
            <div className="panel p-3 space-y-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider font-semibold mb-1">
                Breadth Indicators
                <span className="ml-2 normal-case font-normal text-terminal-dim">
                  {breadth.stock_count} stocks
                </span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                <BreadthStat
                  label="Above 50MA"
                  count={breadth.summary.above_50ma_count}
                  total={breadth.stock_count}
                  pct={breadth.summary.above_50ma_pct}
                />
                <BreadthStat
                  label="Above 200MA"
                  count={breadth.summary.above_200ma_count}
                  total={breadth.stock_count}
                  pct={breadth.summary.above_200ma_pct}
                />
                <BreadthStat
                  label="At 52w High"
                  count={breadth.summary.at_52w_high_count}
                  total={breadth.stock_count}
                  pct={breadth.summary.at_52w_high_pct}
                  highlight={breadth.summary.at_52w_high_pct >= 50}
                />
                <BreadthStat
                  label="At 52w Low"
                  count={breadth.summary.at_52w_low_count}
                  total={breadth.stock_count}
                  pct={breadth.summary.at_52w_low_pct}
                  bearish
                  highlight={breadth.summary.at_52w_low_pct >= 25}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-terminal-dim text-2xs uppercase">Avg vs 52w High</span>
                  <span
                    className="tabular-nums text-sm font-semibold"
                    style={{
                      color:
                        (breadth.summary.avg_dist_from_52w_high_pct ?? 0) >= -5
                          ? "#22c55e"
                          : (breadth.summary.avg_dist_from_52w_high_pct ?? 0) >= -15
                            ? "#f59e0b"
                            : "#ef4444",
                    }}
                  >
                    {breadth.summary.avg_dist_from_52w_high_pct != null
                      ? `${breadth.summary.avg_dist_from_52w_high_pct.toFixed(1)}%`
                      : "--"}
                  </span>
                  <span className="text-terminal-dim text-2xs">drawdown</span>
                </div>
              </div>
            </div>
          )}

          {/* Macro Drivers card */}
          <section className="panel">
            <button
              type="button"
              onClick={() => setShowMacroDrivers((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
            >
              <span className="text-terminal-muted uppercase tracking-wider font-semibold">
                Macro Drivers
                {macroDrivers && (
                  <span className="ml-2 text-terminal-dim normal-case font-normal">
                    90d rolling correlation · {macroDrivers.etf}
                    {!macroDrivers.fred_available && " · FRED key needed for full view"}
                  </span>
                )}
              </span>
              <span className="text-terminal-dim">{showMacroDrivers ? "−" : "+"}</span>
            </button>
            {showMacroDrivers && (
              <div className="px-3 pb-3">
                {!macroDrivers ? (
                  <div className="text-terminal-dim text-xs py-2">Loading macro drivers...</div>
                ) : (
                  <table className="w-full text-xs mt-1">
                    <thead className="text-terminal-dim uppercase tracking-wide">
                      <tr>
                        <th className="text-left py-1 px-2">Driver</th>
                        <th className="text-left py-1 px-2">Source</th>
                        <th className="text-left py-1 px-2">Expected</th>
                        <th className="text-right py-1 px-2">Correlation</th>
                        <th className="text-right py-1 px-2">Obs</th>
                        <th className="text-left py-1 px-2 max-w-[200px]">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {macroDrivers.drivers.map((d) => (
                        <tr key={d.id} className="border-b border-terminal-border/30 hover:bg-terminal-panel/40">
                          <td className="py-1.5 px-2 font-semibold">{d.label}</td>
                          <td className="py-1.5 px-2 text-terminal-dim font-mono text-2xs">{d.id}</td>
                          <td className="py-1.5 px-2">
                            <span className={d.direction === "+" ? "text-green-400" : "text-rose-400"}>
                              {d.direction === "+" ? "↑ bullish" : "↓ bearish"}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold">
                            {!d.available ? (
                              <span className="text-terminal-dim">no key</span>
                            ) : d.correlation === null ? (
                              <span className="text-terminal-dim">--</span>
                            ) : (
                              <span style={{ color: corrColor(d.correlation) }}>
                                {d.correlation > 0 ? "+" : ""}{d.correlation.toFixed(2)}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right text-terminal-dim">
                            {d.n_obs ?? "--"}
                          </td>
                          <td className="py-1.5 px-2 text-terminal-dim truncate max-w-[200px]" title={d.desc}>
                            {d.desc}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>

          {/* Regime Playbook */}
          <section className="panel">
            <button
              type="button"
              onClick={() => setShowRegimePlaybook((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
            >
              <span className="text-terminal-muted uppercase tracking-wider font-semibold">
                Regime Playbook
                {regimePlaybook && !regimePlaybook.error && (
                  <span className="ml-2 text-terminal-dim normal-case font-normal">
                    {regimePlaybook.etf} performance by macro regime · {regimePlaybook.total_days ?? "?"} days
                  </span>
                )}
              </span>
              <span className="text-terminal-dim">{showRegimePlaybook ? "−" : "+"}</span>
            </button>
            {showRegimePlaybook && (
              <div className="px-3 pb-3">
                {!regimePlaybook ? (
                  <div className="text-terminal-dim text-xs py-2">Loading regime playbook...</div>
                ) : regimePlaybook.error ? (
                  <div className="text-terminal-dim text-xs py-2 italic">{regimePlaybook.error}</div>
                ) : regimePlaybook.regimes.length === 0 ? (
                  <div className="text-terminal-dim text-xs py-2 italic">No regime data available.</div>
                ) : (
                  <table className="w-full text-xs mt-1">
                    <thead className="text-terminal-dim uppercase tracking-wide">
                      <tr>
                        <th className="text-left py-1 px-2">Regime</th>
                        <th className="text-right py-1 px-2">Days</th>
                        <th className="text-right py-1 px-2">{regimePlaybook.etf} Ann.</th>
                        <th className="text-right py-1 px-2">SPY Ann.</th>
                        <th className="text-right py-1 px-2">Excess Ann.</th>
                        <th className="text-right py-1 px-2">Beat Rate</th>
                        <th className="text-right py-1 px-2">Best Day</th>
                        <th className="text-right py-1 px-2">Worst Day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {regimePlaybook.regimes.map((r) => (
                        <tr
                          key={r.regime}
                          className={`border-b border-terminal-border/30 ${r.is_current ? "bg-accent/10" : "hover:bg-terminal-panel/40"}`}
                        >
                          <td className="py-1.5 px-2 font-semibold">
                            {r.is_current && (
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-1.5 align-middle" />
                            )}
                            {r.label}
                          </td>
                          <td className="py-1.5 px-2 text-right text-terminal-dim tabular-nums">{r.days}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold" style={{ color: pctColor(r.etf_annualized_pct) }}>
                            {r.etf_annualized_pct > 0 ? "+" : ""}{r.etf_annualized_pct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums" style={{ color: pctColor(r.spy_annualized_pct) }}>
                            {r.spy_annualized_pct > 0 ? "+" : ""}{r.spy_annualized_pct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold" style={{ color: pctColor(r.avg_excess_annualized_pct) }}>
                            {r.avg_excess_annualized_pct > 0 ? "+" : ""}{r.avg_excess_annualized_pct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span style={{ color: r.beat_rate_pct >= 50 ? "#22c55e" : "#ef4444" }}>
                              {r.beat_rate_pct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-green-400">
                            +{r.best_day_pct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-rose-400">
                            {r.worst_day_pct.toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>

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

          {/* Supply Chain Map */}
          {supplyChain && (
            <section className="panel p-4">
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-3">
                Supply Chain Map
              </h3>
              <SectorSupplyChainMap
                data={supplyChain}
                sectorName={data.name}
                sectorEtf={data.etf.ticker}
                onSelectSector={onSelectSector}
              />
            </section>
          )}

          {/* Upcoming Earnings */}
          <section className="panel">
            <button
              type="button"
              onClick={() => setShowEarnings((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
            >
              <span className="text-terminal-muted uppercase tracking-wider font-semibold">
                Upcoming Earnings
                {sectorEarnings && (
                  <span className="ml-2 text-terminal-dim normal-case font-normal">
                    {sectorEarnings.calendars.filter((c) => c.next_earnings && c.next_earnings >= sectorEarnings.today).length} stocks with dates
                  </span>
                )}
              </span>
              <span className="text-terminal-dim">{showEarnings ? "−" : "+"}</span>
            </button>
            {showEarnings && (
              <div className="px-3 pb-3">
                {!sectorEarnings ? (
                  <div className="text-terminal-dim text-xs py-2">Loading earnings calendar...</div>
                ) : (
                  <table className="w-full text-xs mt-1">
                    <thead className="text-terminal-dim uppercase tracking-wide">
                      <tr>
                        <th className="text-left py-1 px-2">Symbol</th>
                        <th className="text-left py-1 px-2">Next Earnings</th>
                        <th className="text-right py-1 px-2">EPS Est.</th>
                        <th className="text-right py-1 px-2">Rev Est.</th>
                        <th className="text-left py-1 px-2">Days Away</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectorEarnings.calendars.map((c) => (
                        <EarningsRow key={c.symbol} cal={c} today={sectorEarnings.today} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>

          {/* Sector News */}
          <section className="panel">
            <button
              type="button"
              onClick={() => setShowNews((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
            >
              <span className="text-terminal-muted uppercase tracking-wider font-semibold">
                Sector News
                {sectorNews && (
                  <span className="ml-2 text-terminal-dim normal-case font-normal">
                    {sectorNews.items.length} stories
                  </span>
                )}
              </span>
              <span className="text-terminal-dim">{showNews ? "−" : "+"}</span>
            </button>
            {showNews && (
              <div className="px-3 pb-3 space-y-2 mt-1">
                {!sectorNews ? (
                  <div className="text-terminal-dim text-xs py-2">Loading news...</div>
                ) : sectorNews.items.length === 0 ? (
                  <div className="text-terminal-dim text-xs py-2">No news found.</div>
                ) : (
                  sectorNews.items.map((item, i) => (
                    <NewsRow key={item.url + i} item={item} />
                  ))
                )}
              </div>
            )}
          </section>

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

function EarningsRow({ cal, today }: { cal: EarningsCalendar; today: string }) {
  const hasDate = cal.next_earnings != null;
  const isUpcoming = hasDate && cal.next_earnings! >= today;
  const daysAway = hasDate
    ? Math.round(
        (new Date(cal.next_earnings!).getTime() - new Date(today).getTime()) /
          86400000,
      )
    : null;

  return (
    <tr className="border-b border-terminal-border/30 hover:bg-terminal-panel/40">
      <td className="py-1.5 px-2 font-mono text-accent">{cal.symbol}</td>
      <td className="py-1.5 px-2 tabular-nums">
        {cal.next_earnings ?? <span className="text-terminal-dim">--</span>}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {cal.eps_estimate != null ? cal.eps_estimate.toFixed(2) : "--"}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {cal.revenue_estimate != null ? fmtCap(cal.revenue_estimate) : "--"}
      </td>
      <td className="py-1.5 px-2">
        {daysAway == null ? (
          <span className="text-terminal-dim">--</span>
        ) : isUpcoming ? (
          <span className={daysAway <= 7 ? "text-accent-amber font-semibold" : "text-terminal-fg"}>
            {daysAway === 0 ? "Today" : `${daysAway}d`}
          </span>
        ) : (
          <span className="text-terminal-dim">{Math.abs(daysAway)}d ago</span>
        )}
      </td>
    </tr>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  const age = item.published
    ? (() => {
        const diff = Date.now() - new Date(item.published).getTime();
        const h = Math.floor(diff / 3600000);
        if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
      })()
    : null;

  return (
    <div className="border-b border-terminal-border/20 pb-2">
      <div className="flex items-start justify-between gap-2">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-terminal-fg hover:text-accent leading-snug"
        >
          {item.title}
        </a>
        {age && <span className="text-terminal-dim text-2xs shrink-0">{age}</span>}
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-terminal-dim text-2xs">{item.publisher}</span>
        <div className="flex gap-1 flex-wrap">
          {item.tickers.slice(0, 4).map((t) => (
            <span key={t} className="pill text-2xs bg-terminal-border/30 py-0">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtKpiValue(v: number | null | undefined, unit: string): string {
  if (v == null) return "--";
  if (unit === "x") return `${v.toFixed(1)}x`;
  if (unit === "days") return `${v.toFixed(0)}d`;
  // % values
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function corrColor(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 0.5) return v > 0 ? "#4ade80" : "#f87171";
  if (abs >= 0.25) return v > 0 ? "#86efac" : "#fca5a5";
  return "#6b7280"; // neutral
}

function pctColor(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const clamped = Math.max(-10, Math.min(10, v));
  const intensity = Math.min(1, Math.abs(clamped) / 10);
  if (v >= 0) return `rgb(${110 - intensity * 60},${220 - intensity * 40},${130 - intensity * 50})`;
  return `rgb(${230 - intensity * 30},${110 - intensity * 50},${120 - intensity * 50})`;
}

function BreadthStat({
  label,
  count,
  total,
  pct,
  bearish = false,
  highlight = false,
}: {
  label: string;
  count: number;
  total: number;
  pct: number;
  bearish?: boolean;
  highlight?: boolean;
}) {
  const color = highlight
    ? bearish
      ? "#ef4444"
      : "#22c55e"
    : pct >= 70
      ? "#22c55e"
      : pct >= 40
        ? "#f59e0b"
        : "#ef4444";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-terminal-dim text-2xs uppercase">{label}</span>
      <span className="tabular-nums text-sm font-semibold" style={{ color }}>
        {pct}%
      </span>
      <span className="text-terminal-dim text-2xs">
        {count}/{total}
      </span>
    </div>
  );
}
