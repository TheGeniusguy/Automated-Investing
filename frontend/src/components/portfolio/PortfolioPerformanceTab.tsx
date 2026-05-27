import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { portfolioApi } from "../../api/client";

// ── Types ────────────────────────────────────────────────────────────────────

interface RollingReturn {
  window: string;
  portfolio_pct: number | null;
  spy_pct: number | null;
  qqq_pct: number | null;
  vs_spy_pct: number | null;
}

interface PerformanceMetrics {
  ann_return_pct: number | null;
  ann_volatility_pct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  treynor: number | null;
  information_ratio: number | null;
  tracking_error_pct: number | null;
  alpha_pct: number | null;
  beta: number | null;
  r_squared: number | null;
  max_drawdown_pct: number | null;
  max_drawdown_start: string | null;
  max_drawdown_end: string | null;
  win_rate_pct: number | null;
  twr_pct: number | null;
  mwr_pct: number | null;
  rolling_returns: RollingReturn[];
}

interface PerformanceCurve {
  dates: string[];
  portfolio: number[];
  portfolio_raw: number[];
  benchmarks: {
    SPY: number[];
    QQQ: number[];
  };
}

interface PerformanceResponse {
  curve: PerformanceCurve;
  metrics: PerformanceMetrics;
}

// ── Time range options ───────────────────────────────────────────────────────

const TIME_RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "3Y", days: 1095 },
  { label: "All", days: 3650 },
];

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  portfolioId: number;
}

export function PortfolioPerformanceTab({ portfolioId }: Props) {
  const [days, setDays] = useState(365);
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSpy, setShowSpy] = useState(true);
  const [showQqq, setShowQqq] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    (portfolioApi.performance(portfolioId, days) as unknown as Promise<PerformanceResponse>)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId, days]);

  useEffect(() => { load(); }, [load]);

  const metrics = data?.metrics ?? null;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Time range selector */}
      <div className="flex items-center gap-1 flex-wrap">
        {TIME_RANGES.map(({ label, days: d }) => (
          <button
            key={label}
            type="button"
            onClick={() => setDays(d)}
            className={`pill text-2xs ${days === d ? "bg-accent text-black" : "text-terminal-dim hover:text-terminal-fg"}`}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        {/* Benchmark toggles */}
        <button
          type="button"
          onClick={() => setShowSpy((v) => !v)}
          className={`pill text-2xs ${showSpy ? "bg-blue-600/40 text-blue-300" : "text-terminal-dim"}`}
        >
          SPY
        </button>
        <button
          type="button"
          onClick={() => setShowQqq((v) => !v)}
          className={`pill text-2xs ${showQqq ? "bg-purple-600/40 text-purple-300" : "text-terminal-dim"}`}
        >
          QQQ
        </button>
      </div>

      {loading && <div className="text-terminal-dim text-xs py-4 text-center">Loading performance data...</div>}
      {err && <div className="text-red-400 text-xs py-2">{err}</div>}

      {data && !loading && (
        <>
          {/* Equity Curve */}
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
            <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Equity Curve (Normalized to 100)</div>
            <EquityCurveChart
              curve={data.curve}
              showSpy={showSpy}
              showQqq={showQqq}
            />
            {/* Legend */}
            <div className="flex gap-4 mt-2 px-1">
              <LegendItem color="#26a69a" label="Portfolio" />
              {showSpy && <LegendItem color="#3b82f6" label="SPY" />}
              {showQqq && <LegendItem color="#a855f7" label="QQQ" />}
            </div>
          </div>

          {/* Rolling Returns Table */}
          {metrics?.rolling_returns && metrics.rolling_returns.length > 0 && (
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Rolling Returns</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
                    <th className="text-left py-1 px-2">Window</th>
                    <th className="text-right py-1 px-2">Portfolio</th>
                    <th className="text-right py-1 px-2">SPY</th>
                    <th className="text-right py-1 px-2">QQQ</th>
                    <th className="text-right py-1 px-2">vs SPY</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.rolling_returns.map((r) => (
                    <tr key={r.window} className="border-t border-terminal-border/20">
                      <td className="py-1.5 px-2 text-terminal-muted">{r.window}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums font-semibold ${colorPct(r.portfolio_pct)}`}>
                        {fmtPct(r.portfolio_pct)}
                      </td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${colorPct(r.spy_pct)}`}>
                        {fmtPct(r.spy_pct)}
                      </td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${colorPct(r.qqq_pct)}`}>
                        {fmtPct(r.qqq_pct)}
                      </td>
                      <td
                        className={`py-1.5 px-2 text-right tabular-nums font-semibold ${colorPct(r.vs_spy_pct)}`}
                        title="Portfolio return vs SPY"
                      >
                        {fmtPct(r.vs_spy_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Risk-Adjusted Metrics Grid */}
          {metrics && (
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Risk-Adjusted Metrics</div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                <MetricCell label="Ann Return" value={fmtPct(metrics.ann_return_pct)} pos={metrics.ann_return_pct} />
                <MetricCell label="Ann Volatility" value={metrics.ann_volatility_pct != null ? `${metrics.ann_volatility_pct.toFixed(2)}%` : "--"} />
                <MetricCell label="Sharpe" value={fmtRatio(metrics.sharpe)} pos={metrics.sharpe} />
                <MetricCell label="Sortino" value={fmtRatio(metrics.sortino)} pos={metrics.sortino} />
                <MetricCell label="Calmar" value={fmtRatio(metrics.calmar)} pos={metrics.calmar} />
                <MetricCell label="Treynor" value={fmtRatio(metrics.treynor)} pos={metrics.treynor} />
                <MetricCell label="Info Ratio" value={fmtRatio(metrics.information_ratio)} pos={metrics.information_ratio} />
                <MetricCell label="Tracking Err" value={metrics.tracking_error_pct != null ? `${metrics.tracking_error_pct.toFixed(2)}%` : "--"} />
                <MetricCell label="Alpha" value={fmtPct(metrics.alpha_pct)} pos={metrics.alpha_pct} />
                <MetricCell label="Beta" value={metrics.beta != null ? metrics.beta.toFixed(2) : "--"} />
                <MetricCell label="R²" value={metrics.r_squared != null ? metrics.r_squared.toFixed(3) : "--"} />
                <MetricCell
                  label="Max Drawdown"
                  value={metrics.max_drawdown_pct != null ? `-${Math.abs(metrics.max_drawdown_pct).toFixed(2)}%` : "--"}
                  neg
                  title={
                    metrics.max_drawdown_start && metrics.max_drawdown_end
                      ? `${metrics.max_drawdown_start} → ${metrics.max_drawdown_end}`
                      : undefined
                  }
                />
                <MetricCell label="Win Rate" value={metrics.win_rate_pct != null ? `${metrics.win_rate_pct.toFixed(1)}%` : "--"} pos={metrics.win_rate_pct != null ? metrics.win_rate_pct - 50 : null} />
                <MetricCell label="TWR" value={fmtPct(metrics.twr_pct)} pos={metrics.twr_pct} />
                <MetricCell label="MWR" value={fmtPct(metrics.mwr_pct)} pos={metrics.mwr_pct} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Equity Curve Chart ───────────────────────────────────────────────────────

function EquityCurveChart({
  curve,
  showSpy,
  showQqq,
}: {
  curve: PerformanceCurve;
  showSpy: boolean;
  showQqq: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

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

    // Portfolio line
    if (curve.dates.length > 0 && curve.portfolio.length > 0) {
      const portLine = chart.addSeries(LineSeries, {
        color: "#26a69a",
        lineWidth: 2,
        title: "Portfolio",
      });
      portLine.setData(
        curve.dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: curve.portfolio[i],
        })),
      );
    }

    // SPY benchmark
    if (showSpy && curve.benchmarks.SPY?.length > 0) {
      const spyLine = chart.addSeries(LineSeries, {
        color: "#3b82f6",
        lineWidth: 1,
        lineStyle: 2, // dashed
        title: "SPY",
      });
      spyLine.setData(
        curve.dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: curve.benchmarks.SPY[i],
        })),
      );
    }

    // QQQ benchmark
    if (showQqq && curve.benchmarks.QQQ?.length > 0) {
      const qqqLine = chart.addSeries(LineSeries, {
        color: "#a855f7",
        lineWidth: 1,
        lineStyle: 2,
        title: "QQQ",
      });
      qqqLine.setData(
        curve.dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: curve.benchmarks.QQQ[i],
        })),
      );
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [curve, showSpy, showQqq]);

  return <div ref={ref} />;
}

// ── Small sub-components ─────────────────────────────────────────────────────

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span className="w-4 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}

function MetricCell({
  label,
  value,
  pos,
  neg,
  title,
}: {
  label: string;
  value: string;
  pos?: number | null;
  neg?: boolean;
  title?: string;
}) {
  let color = "text-terminal-fg";
  if (neg) {
    color = "text-red-400";
  } else if (pos != null) {
    color = pos >= 0 ? "text-green-400" : "text-red-400";
  }

  return (
    <div
      className="bg-terminal-panel border border-terminal-border/30 rounded p-2"
      title={title}
    >
      <div className="text-2xs text-terminal-dim uppercase truncate">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtRatio(v: number | null | undefined): string {
  if (v == null) return "--";
  return v.toFixed(2);
}

function colorPct(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-green-400" : "text-red-400";
}
