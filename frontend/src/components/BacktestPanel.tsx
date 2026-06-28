import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
// Local shape mirror (documented in v2 contract / bloomberg gap spec). The
// wiring agent owns the canonical types in api/types and the api.backtest*
// client methods; these interfaces keep the panel self-consistent and bind
// defensively to the exact backend keys.
// ─────────────────────────────────────────────────────────────────────────────
type Num = number | null;

interface StrategyParam {
  name: string;
  label: string;
  type: string; // "int" | "float"
  default: number;
  min: number;
  max: number;
  step: number;
}

interface StrategyDef {
  key: string;
  name: string;
  description: string;
  params: StrategyParam[];
}

interface CurvePoint {
  date: string;
  value: number;
}

interface Trade {
  date: string;
  action: string;
  from_position: number;
  to_position: number;
  price: number;
}

interface HeatmapCell {
  year: number;
  month: number;
  return_pct: number;
}

interface BacktestMetrics {
  total_return_pct?: Num;
  cagr_pct?: Num;
  ann_volatility_pct?: Num;
  sharpe?: Num;
  sortino?: Num;
  calmar?: Num;
  max_drawdown_pct?: Num;
  win_rate_pct?: Num;
  exposure_pct?: Num;
  turnover?: Num;
  benchmark_total_return_pct?: Num;
  excess_return_pct?: Num;
  [key: string]: Num | undefined;
}

interface BacktestResult {
  symbol: string;
  strategy_name: string;
  equity_curve: CurvePoint[];
  benchmark_curve: CurvePoint[];
  trades: Trade[];
  metrics: BacktestMetrics;
  monthly_returns_heatmap: HeatmapCell[];
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STRATEGY_COLOR = "#00ff88";
const BENCHMARK_COLOR = "#60a5fa";

export function BacktestPanel() {
  const [symbol, setSymbol] = useState("SPY");
  const [strategies, setStrategies] = useState<StrategyDef[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [params, setParams] = useState<Record<string, number>>({});
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loadingStrategies, setLoadingStrategies] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = useMemo(
    () => strategies?.find((s) => s.key === selectedKey) ?? null,
    [strategies, selectedKey],
  );

  // Seed params from a strategy's schema defaults.
  const seedParams = (def: StrategyDef | null): Record<string, number> => {
    const next: Record<string, number> = {};
    (def?.params ?? []).forEach((p) => {
      next[p.name] = p.default;
    });
    return next;
  };

  // Run a backtest with the given strategy key + params.
  const runBacktest = (sym: string, key: string, p: Record<string, number>) => {
    const cleanSym = sym.trim().toUpperCase();
    if (!cleanSym) {
      setErr("Enter a symbol.");
      return;
    }
    if (!key) return;
    setRunning(true);
    setErr(null);
    (api.backtestRun({ symbol: cleanSym, strategy: key, params: p }) as Promise<BacktestResult>)
      .then((res) => {
        setResult(res);
        setRunning(false);
      })
      .catch((e) => {
        setErr(String(e));
        setRunning(false);
      });
  };

  // Initial load: fetch strategy catalog, pick the first, seed params, run once.
  useEffect(() => {
    setLoadingStrategies(true);
    (api.backtestStrategies() as Promise<StrategyDef[]>)
      .then((defs) => {
        setStrategies(defs);
        const first = defs[0] ?? null;
        const firstKey = first?.key ?? "";
        const seeded = seedParams(first);
        setSelectedKey(firstKey);
        setParams(seeded);
        setLoadingStrategies(false);
        if (firstKey) runBacktest("SPY", firstKey, seeded);
      })
      .catch((e) => {
        setErr(String(e));
        setLoadingStrategies(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelectStrategy = (key: string) => {
    setSelectedKey(key);
    const def = strategies?.find((s) => s.key === key) ?? null;
    setParams(seedParams(def));
  };

  const onParamChange = (name: string, raw: string, p: StrategyParam) => {
    const parsed = p.type === "int" ? parseInt(raw, 10) : parseFloat(raw);
    setParams((prev) => ({ ...prev, [name]: Number.isNaN(parsed) ? prev[name] : parsed }));
  };

  const onRun = () => runBacktest(symbol, selectedKey, params);

  const m = result?.metrics ?? null;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">Strategy Backtester</span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex flex-col">
              <span className="text-2xs text-terminal-dim uppercase mb-0.5">Symbol</span>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRun();
                }}
                placeholder="SPY"
                className="w-28 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg focus:outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col">
              <span className="text-2xs text-terminal-dim uppercase mb-0.5">Strategy</span>
              <select
                value={selectedKey}
                onChange={(e) => onSelectStrategy(e.target.value)}
                disabled={loadingStrategies || !strategies}
                className="min-w-[12rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg focus:outline-none focus:border-accent disabled:opacity-40"
              >
                {!strategies && <option>Loading...</option>}
                {(strategies ?? []).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1" />

            <button
              type="button"
              onClick={onRun}
              disabled={running || loadingStrategies || !selectedKey}
              className="pill text-2xs bg-accent text-black font-semibold disabled:opacity-40 self-end"
            >
              {running ? "Running..." : "Run Backtest"}
            </button>
          </div>

          {selected?.description && (
            <div className="text-2xs text-terminal-dim">{selected.description}</div>
          )}

          {/* Dynamic param inputs */}
          {selected && selected.params.length > 0 && (
            <div className="flex items-end gap-3 flex-wrap pt-1 border-t border-terminal-border/30">
              {selected.params.map((p) => (
                <div key={p.name} className="flex flex-col">
                  <label className="text-2xs text-terminal-dim uppercase mb-0.5" htmlFor={`bt-${p.name}`}>
                    {p.label}
                  </label>
                  <input
                    id={`bt-${p.name}`}
                    type="number"
                    value={params[p.name] ?? p.default}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    onChange={(e) => onParamChange(p.name, e.target.value, p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onRun();
                    }}
                    className="w-24 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg tabular-nums focus:outline-none focus:border-accent"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {err && <div className="text-red-400 text-xs py-2">{err}</div>}
        {(loadingStrategies || (running && !result)) && (
          <div className="text-terminal-dim text-xs py-4 text-center">Running backtest...</div>
        )}

        {result && (
          <>
            {/* Hero metrics */}
            {m && (
              <div className="grid grid-cols-3 gap-2">
                <HeroStat label="CAGR" value={fmtPct(m.cagr_pct)} pos={m.cagr_pct} />
                <HeroStat label="Sharpe" value={fmtRatio(m.sharpe)} pos={m.sharpe} />
                <HeroStat label="Max Drawdown" value={fmtDrawdown(m.max_drawdown_pct)} neg />
              </div>
            )}

            {/* Equity curve overlay */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="flex items-center justify-between mb-2">
                <div className="text-2xs text-terminal-muted uppercase tracking-wider">
                  Equity vs Buy and Hold
                </div>
                <div className="flex items-center gap-4">
                  <LegendItem color={STRATEGY_COLOR} label={result.strategy_name || "Strategy"} />
                  <LegendItem color={BENCHMARK_COLOR} label={`${result.symbol} Buy and Hold`} />
                </div>
              </div>
              <EquityOverlayChart strategy={result.equity_curve} benchmark={result.benchmark_curve} />
            </div>

            {/* Full metrics grid */}
            {m && (
              <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
                <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Metrics</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  <MetricCell label="Total Return" value={fmtPct(m.total_return_pct)} pos={m.total_return_pct} />
                  <MetricCell label="Benchmark Ret" value={fmtPct(m.benchmark_total_return_pct)} pos={m.benchmark_total_return_pct} />
                  <MetricCell label="Excess Return" value={fmtPct(m.excess_return_pct)} pos={m.excess_return_pct} />
                  <MetricCell label="Ann Volatility" value={fmtPctPlain(m.ann_volatility_pct)} />
                  <MetricCell label="Sortino" value={fmtRatio(m.sortino)} pos={m.sortino} />
                  <MetricCell label="Calmar" value={fmtRatio(m.calmar)} pos={m.calmar} />
                  <MetricCell label="Win Rate" value={fmtPctPlain(m.win_rate_pct)} pos={m.win_rate_pct != null ? m.win_rate_pct - 50 : null} />
                  <MetricCell label="Exposure" value={fmtPctPlain(m.exposure_pct)} />
                  <MetricCell label="Turnover" value={fmtRatio(m.turnover)} />
                </div>
              </div>
            )}

            {/* Monthly returns heatmap */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Monthly Returns</div>
              <MonthlyHeatmap cells={result.monthly_returns_heatmap ?? []} />
            </div>

            {/* Trades table */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Trades ({result.trades?.length ?? 0})
              </div>
              <TradesTable trades={result.trades ?? []} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Equity overlay chart ──────────────────────────────────────────────────────

function EquityOverlayChart({
  strategy,
  benchmark,
}: {
  strategy: CurvePoint[];
  benchmark: CurvePoint[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 300,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      timeScale: { borderColor: "#374151" },
      rightPriceScale: { borderColor: "#374151" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const toData = (pts: CurvePoint[]) =>
      (pts ?? [])
        .filter((p) => p && p.date != null && p.value != null)
        .map((p) => ({
          time: Math.floor(new Date(p.date).getTime() / 1000) as UTCTimestamp,
          value: p.value,
        }));

    const benchData = toData(benchmark);
    if (benchData.length) {
      const benchLine = chart.addSeries(LineSeries, {
        color: BENCHMARK_COLOR,
        lineWidth: 1,
        lineStyle: 2, // dashed
        title: "Buy & Hold",
      });
      benchLine.setData(benchData);
    }

    const stratData = toData(strategy);
    if (stratData.length) {
      const stratLine = chart.addSeries(LineSeries, {
        color: STRATEGY_COLOR,
        lineWidth: 2,
        title: "Strategy",
      });
      stratLine.setData(stratData);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [strategy, benchmark]);

  return <div ref={ref} />;
}

// ── Monthly returns heatmap ───────────────────────────────────────────────────

function MonthlyHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const years = useMemo(() => {
    const byYear = new Map<number, (number | null)[]>();
    cells.forEach((c) => {
      const mi = c.month - 1;
      if (mi < 0 || mi > 11) return;
      if (!byYear.has(c.year)) byYear.set(c.year, Array(12).fill(null));
      byYear.get(c.year)![mi] = c.return_pct;
    });
    return [...byYear.entries()].sort((a, b) => a[0] - b[0]);
  }, [cells]);

  if (years.length === 0) {
    return <div className="text-2xs text-terminal-dim">No monthly data.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-2xs border-collapse">
        <thead>
          <tr>
            <th className="text-left pr-2 text-terminal-dim font-normal">Year</th>
            {MONTH_LABELS.map((mo) => (
              <th key={mo} className="text-center px-1 text-terminal-dim font-normal w-9">
                {mo}
              </th>
            ))}
            <th className="text-center pl-2 text-terminal-dim font-normal w-12">FY</th>
          </tr>
        </thead>
        <tbody>
          {years.map(([y, vals]) => {
            // Compound the year to a full-year figure.
            const present = vals.filter((v): v is number => v != null);
            const fy =
              present.length > 0
                ? (present.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100
                : null;
            return (
              <tr key={y}>
                <td className="pr-2 text-terminal-muted tabular-nums">{y}</td>
                {vals.map((v, i) => (
                  <td
                    key={i}
                    className="text-center px-1 py-0.5 tabular-nums border border-terminal-bg"
                    style={{ background: heatColor(v), color: v == null ? "#4b5563" : "#0a0a0a" }}
                    title={v == null ? "" : `${y}-${String(i + 1).padStart(2, "0")}: ${v.toFixed(2)}%`}
                  >
                    {v == null ? "" : v.toFixed(1)}
                  </td>
                ))}
                <td className={`text-center pl-2 tabular-nums font-semibold ${colorPct(fy)}`}>
                  {fy == null ? "" : `${fy >= 0 ? "+" : ""}${fy.toFixed(1)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Trades table ──────────────────────────────────────────────────────────────

function TradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return <div className="text-2xs text-terminal-dim">No trades generated for this run.</div>;
  }
  return (
    <div className="overflow-x-auto max-h-72 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-terminal-bg">
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Date</th>
            <th className="text-left py-1 px-2">Action</th>
            <th className="text-right py-1 px-2">From</th>
            <th className="text-right py-1 px-2">To</th>
            <th className="text-right py-1 px-2">Price</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.date}-${i}`} className="border-t border-terminal-border/20">
              <td className="py-1.5 px-2 text-terminal-muted tabular-nums">{t.date}</td>
              <td className={`py-1.5 px-2 font-semibold ${actionColor(t.action)}`}>
                {(t.action ?? "").toUpperCase()}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-dim">
                {fmtPos(t.from_position)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">
                {fmtPos(t.to_position)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">
                {t.price != null ? `$${t.price.toFixed(2)}` : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function HeroStat({
  label,
  value,
  pos,
  neg,
}: {
  label: string;
  value: string;
  pos?: Num;
  neg?: boolean;
}) {
  let color = "text-terminal-fg";
  if (neg) color = "text-accent-red";
  else if (pos != null) color = pos >= 0 ? "text-accent-green" : "text-accent-red";
  return (
    <div className="bg-terminal-panel border border-terminal-border/30 rounded p-3">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-3xl mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  pos,
  neg,
}: {
  label: string;
  value: string;
  pos?: Num;
  neg?: boolean;
}) {
  let color = "text-terminal-fg";
  if (neg) color = "text-red-400";
  else if (pos != null) color = pos >= 0 ? "text-green-400" : "text-red-400";
  return (
    <div className="bg-terminal-panel border border-terminal-border/30 rounded p-2">
      <div className="text-2xs text-terminal-dim uppercase truncate">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span className="w-4 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function heatColor(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  if (v > 5) return "rgba(22, 163, 74, 0.95)";
  if (v >= 1) return "rgba(34, 197, 94, 0.55)";
  if (v > -1) return "rgba(120, 120, 120, 0.45)";
  if (v >= -5) return "rgba(239, 68, 68, 0.5)";
  return "rgba(185, 28, 28, 0.95)";
}

function actionColor(action: string | null | undefined): string {
  const a = (action ?? "").toLowerCase();
  if (a.includes("buy") || a.includes("long")) return "text-green-400";
  if (a.includes("sell") || a.includes("short") || a.includes("exit")) return "text-red-400";
  return "text-terminal-fg";
}

function colorPct(v: Num | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-green-400" : "text-red-400";
}

function fmtPct(v: Num | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPctPlain(v: Num | undefined): string {
  if (v == null) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtDrawdown(v: Num | undefined): string {
  if (v == null) return "--";
  return `-${Math.abs(v).toFixed(2)}%`;
}

function fmtRatio(v: Num | undefined): string {
  if (v == null) return "--";
  return v.toFixed(2);
}

function fmtPos(v: number | null | undefined): string {
  if (v == null) return "--";
  return v.toFixed(2);
}
