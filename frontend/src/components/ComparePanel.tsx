import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { CompareResponse, PortfolioSimResponse } from "../api/types";

type Tab = "chart" | "table" | "portfolio";

const CHART_COLORS = [
  "#26a69a", "#ef5350", "#ffb800", "#8b5cf6", "#06b6d4",
  "#f472b6", "#84cc16", "#fb923c", "#a78bfa", "#14b8a6",
];

const PRESETS: Record<string, string[]> = {
  "RE Sectors": ["XLRE", "VNQ", "XHB", "ITB", "REM"],
  "RE vs Market": ["XLRE", "SPY", "QQQ", "DIA", "IWM"],
  "Homebuilders": ["DHI", "LEN", "NVR", "PHM", "TOL", "KBH"],
  "REIT Types": ["PLD", "EQIX", "SPG", "PSA", "O", "AMT"],
  "Mortgage": ["RKT", "UWMC", "NLY", "AGNC", "STWD"],
  "PropTech": ["ZG", "RDFN", "OPEN", "COMP", "CSGP"],
};

export function ComparePanel() {
  const [tab, setTab] = useState<Tab>("chart");
  const [tickerInput, setTickerInput] = useState("XLRE,VNQ,SPY,XHB,ITB");
  const [tickers, setTickers] = useState<string[]>(["XLRE", "VNQ", "SPY", "XHB", "ITB"]);
  const [days, setDays] = useState(365);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Portfolio state.
  const [positions, setPositions] = useState<{ ticker: string; weight: number }[]>([
    { ticker: "XLRE", weight: 0.3 },
    { ticker: "VNQ", weight: 0.3 },
    { ticker: "SPY", weight: 0.2 },
    { ticker: "XHB", weight: 0.2 },
  ]);
  const [portResult, setPortResult] = useState<PortfolioSimResponse | null>(null);
  const [portLoading, setPortLoading] = useState(false);

  const load = useCallback(() => {
    if (tickers.length < 2) return;
    setLoading(true);
    setErr(null);
    api.compare(tickers, days)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [tickers, days]);

  useEffect(() => { load(); }, [load]);

  const handleGo = () => {
    const syms = tickerInput.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (syms.length >= 2) {
      setTickers(syms);
    }
  };

  const handlePreset = (name: string) => {
    const syms = PRESETS[name];
    setTickers(syms);
    setTickerInput(syms.join(","));
  };

  const runPortfolio = () => {
    setPortLoading(true);
    api.portfolioSimulate(positions, days)
      .then((r) => { setPortResult(r); setPortLoading(false); })
      .catch(() => setPortLoading(false));
  };

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">COMPARE</span>
          <span className="text-xs text-terminal-dim">Performance Comparison</span>
        </div>
        <div className="flex items-center gap-1">
          {(["chart", "table", "portfolio"] as const).map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`pill text-xs ${tab === t ? "bg-accent text-black" : ""}`}>
              {t === "chart" ? "Chart" : t === "table" ? "Metrics" : "Portfolio"}
            </button>
          ))}
        </div>
      </header>

      {/* Ticker input bar */}
      <div className="px-3 py-2 border-b border-terminal-border flex items-center gap-2 flex-wrap">
        <input
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleGo()}
          className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg flex-1 min-w-[200px]"
          placeholder="XLRE,VNQ,SPY,XHB,ITB"
        />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="bg-terminal-bg border border-terminal-border rounded px-1 py-1 text-xs text-terminal-fg">
          <option value={90}>3M</option>
          <option value={180}>6M</option>
          <option value={365}>1Y</option>
          <option value={730}>2Y</option>
          <option value={1825}>5Y</option>
          <option value={3650}>10Y</option>
        </select>
        <button type="button" onClick={handleGo} className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40">Compare</button>
        <div className="flex gap-1">
          {Object.keys(PRESETS).map(name => (
            <button key={name} type="button" onClick={() => handlePreset(name)}
              className="pill text-2xs text-terminal-dim hover:text-accent">{name}</button>
          ))}
        </div>
      </div>

      <div className="panel-body flex-1 overflow-auto">
        {loading && <div className="text-terminal-dim text-xs p-4">Loading comparison...</div>}
        {err && <div className="text-rose-400 text-xs p-2">{err}</div>}

        {/* Mountain Chart */}
        {tab === "chart" && data && !loading && (
          <div className="p-2">
            <NormalizedChart data={data} colors={CHART_COLORS} />
            {/* Legend */}
            <div className="flex flex-wrap gap-3 mt-2 px-1">
              {data.tickers.map((t, i) => {
                const m = data.metrics.find(m => m.symbol === t);
                return (
                  <div key={t} className="flex items-center gap-1.5 text-xs">
                    <span className="w-3 h-0.5 rounded" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                    <span className="font-mono font-semibold" style={{ color: CHART_COLORS[i % CHART_COLORS.length] }}>{t}</span>
                    <span className="tabular-nums text-terminal-dim">
                      {m?.total_return_pct != null ? `${m.total_return_pct >= 0 ? "+" : ""}${m.total_return_pct.toFixed(1)}%` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Metrics Table */}
        {tab === "table" && data && !loading && (
          <div className="p-2 space-y-4">
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-right py-1 px-2">Total Return</th>
                  <th className="text-right py-1 px-2">Ann. Return</th>
                  <th className="text-right py-1 px-2">Volatility</th>
                  <th className="text-right py-1 px-2">Sharpe</th>
                  <th className="text-right py-1 px-2">Max Drawdown</th>
                  <th className="text-right py-1 px-2">Div Yield</th>
                  <th className="text-right py-1 px-2">Start</th>
                  <th className="text-right py-1 px-2">End</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m, i) => (
                  <tr key={m.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                    <td className="py-1.5 px-2 font-mono font-semibold" style={{ color: CHART_COLORS[i % CHART_COLORS.length] }}>{m.symbol}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums" style={{ color: retColor(m.total_return_pct) }}>
                      {fmtPct(m.total_return_pct)}
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums" style={{ color: retColor(m.annualized_return_pct) }}>
                      {fmtPct(m.annualized_return_pct)}
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums">{m.volatility_pct != null ? `${m.volatility_pct.toFixed(1)}%` : "--"}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums" style={{ color: retColor(m.sharpe_ratio != null ? m.sharpe_ratio * 10 : null) }}>
                      {m.sharpe_ratio != null ? m.sharpe_ratio.toFixed(2) : "--"}
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-rose-400">
                      {m.max_drawdown_pct != null ? `-${m.max_drawdown_pct.toFixed(1)}%` : "--"}
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums">
                      {m.dividend_yield != null ? `${(m.dividend_yield * 100).toFixed(2)}%` : "--"}
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-terminal-dim">${m.start_price?.toFixed(2) ?? "--"}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums">${m.end_price?.toFixed(2) ?? "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Correlation matrix */}
            <div>
              <h3 className="text-xs text-terminal-muted uppercase tracking-wider mb-1">Correlation Matrix</h3>
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="py-1 px-2"></th>
                    {data.correlation.symbols.map(s => (
                      <th key={s} className="py-1 px-2 text-center font-mono text-terminal-dim">{s}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.correlation.symbols.map((s, i) => (
                    <tr key={s}>
                      <td className="py-1 px-2 font-mono text-terminal-dim">{s}</td>
                      {data.correlation.matrix[i].map((v, j) => (
                        <td key={j} className="py-1 px-2 text-center tabular-nums"
                          style={{ color: corrColor(v), backgroundColor: corrBg(v) }}>
                          {v != null ? v.toFixed(2) : "--"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Portfolio Simulator */}
        {tab === "portfolio" && (
          <div className="p-3 space-y-3">
            <h3 className="text-xs text-terminal-muted uppercase tracking-wider">Allocations</h3>
            {positions.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={p.ticker} onChange={(e) => {
                  const next = [...positions];
                  next[i] = { ...next[i], ticker: e.target.value.toUpperCase() };
                  setPositions(next);
                }} className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs w-20 font-mono text-terminal-fg" />
                <input type="range" min={0} max={100} value={Math.round(p.weight * 100)}
                  onChange={(e) => {
                    const next = [...positions];
                    next[i] = { ...next[i], weight: Number(e.target.value) / 100 };
                    setPositions(next);
                  }} className="flex-1 accent-accent" />
                <span className="text-xs tabular-nums w-12 text-right">{(p.weight * 100).toFixed(0)}%</span>
                <button type="button" onClick={() => setPositions(positions.filter((_, j) => j !== i))}
                  className="text-rose-400 text-xs hover:text-rose-300">x</button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPositions([...positions, { ticker: "", weight: 0.1 }])}
                className="pill text-xs">+ Add</button>
              <span className="text-xs text-terminal-dim">
                Total: {(positions.reduce((s, p) => s + p.weight, 0) * 100).toFixed(0)}%
              </span>
              <button type="button" onClick={runPortfolio} disabled={portLoading}
                className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 ml-auto">
                {portLoading ? "Simulating..." : "Run Simulation"}
              </button>
            </div>

            {portResult && !portLoading && (
              <>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <StatCard label="Total Return" value={fmtPct(portResult.total_return_pct)} color={retColor(portResult.total_return_pct)} />
                  <StatCard label="Ann. Return" value={fmtPct(portResult.annualized_return_pct)} color={retColor(portResult.annualized_return_pct)} />
                  <StatCard label="Volatility" value={portResult.volatility_pct != null ? `${portResult.volatility_pct.toFixed(1)}%` : "--"} />
                  <StatCard label="Sharpe Ratio" value={portResult.sharpe_ratio != null ? portResult.sharpe_ratio.toFixed(2) : "--"} color={retColor(portResult.sharpe_ratio != null ? portResult.sharpe_ratio * 10 : null)} />
                  <StatCard label="Max Drawdown" value={portResult.max_drawdown_pct != null ? `-${portResult.max_drawdown_pct.toFixed(1)}%` : "--"} color="#fb7185" />
                  <StatCard label="Income Yield" value={portResult.blended_dividend_yield != null ? `${(portResult.blended_dividend_yield * 100).toFixed(2)}%` : "--"} />
                </div>
                <div className="mt-3">
                  <PortfolioChart data={portResult} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Chart components ────────────────────────────────────────────────────

function NormalizedChart({ data, colors }: { data: CompareResponse; colors: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 360,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      timeScale: { borderColor: "#374151" },
      rightPriceScale: { borderColor: "#374151" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    data.tickers.forEach((ticker, i) => {
      const series = data.normalized[ticker];
      if (!series || series.length === 0) return;
      const line = chart.addSeries(LineSeries, {
        color: colors[i % colors.length],
        lineWidth: 2,
        title: ticker,
      });
      line.setData(
        series.map((p) => ({
          time: p.date as unknown as UTCTimestamp,
          value: p.value!,
        })),
      );
    });

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [data, colors]);

  return <div ref={ref} />;
}

function PortfolioChart({ data }: { data: PortfolioSimResponse }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 240,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      timeScale: { borderColor: "#374151" },
      rightPriceScale: { borderColor: "#374151" },
    });
    chartRef.current = chart;

    const line = chart.addSeries(LineSeries, {
      color: "#26a69a",
      lineWidth: 2,
      title: "Portfolio",
    });
    line.setData(
      data.equity_curve.map((p) => ({
        time: p.date as unknown as UTCTimestamp,
        value: p.value!,
      })),
    );

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [data]);

  return <div ref={ref} />;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color?: string | null }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-dim uppercase">{label}</div>
      <div className="text-sm font-semibold tabular-nums" style={{ color: color ?? undefined }}>{value}</div>
    </div>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function retColor(v: number | null | undefined): string | undefined {
  if (v == null) return undefined;
  return v >= 0 ? "#34d399" : "#fb7185";
}

function corrColor(v: number | null): string {
  if (v == null) return "#6b7280";
  if (v > 0.7) return "#34d399";
  if (v < -0.3) return "#fb7185";
  return "#d1d5db";
}

function corrBg(v: number | null): string {
  if (v == null) return "transparent";
  const abs = Math.abs(v);
  if (v > 0) return `rgba(52,211,153,${abs * 0.15})`;
  return `rgba(251,113,133,${abs * 0.15})`;
}
