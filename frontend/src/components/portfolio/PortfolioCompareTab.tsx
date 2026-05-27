import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { portfolioApi } from "../../api/client";
import type { PortfolioCompareResponse as CompareResponse, ComparePortfolio, Portfolio } from "../../api/types";

// ── Color palette (shared with ETF comparison) ───────────────────────────────
const PALETTE = [
  "#00ff88",
  "#60a5fa",
  "#f59e0b",
  "#f87171",
  "#a78bfa",
  "#34d399",
  "#fb923c",
  "#e879f9",
];

const TIME_RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "All", days: 3650 },
];

interface Props {
  allPortfolios: Portfolio[];
  currentPortfolioId: number | null;
}

export function PortfolioCompareTab({ allPortfolios, currentPortfolioId }: Props) {
  const [selectedIds, setSelectedIds] = useState<number[]>(() =>
    allPortfolios.map((p) => p.id),
  );
  const [days, setDays] = useState(365);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep selection in sync if the portfolio list changes (e.g. created/deleted).
  useEffect(() => {
    setSelectedIds((prev) => {
      const valid = new Set(allPortfolios.map((p) => p.id));
      const filtered = prev.filter((id) => valid.has(id));
      return filtered.length > 0 ? filtered : allPortfolios.map((p) => p.id);
    });
  }, [allPortfolios]);

  const runCompare = (ids: number[], d: number) => {
    if (ids.length === 0) {
      setData(null);
      setErr("Select at least one portfolio to compare.");
      return;
    }
    setLoading(true);
    setErr(null);
    portfolioApi
      .compare(ids, d)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  const toggleId = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleRangeChange = (d: number) => {
    setDays(d);
    if (data) runCompare(selectedIds, d);
  };

  // Map portfolio id -> color (stable across renders, by selection order).
  const colorById = useMemo(() => {
    const m = new Map<number, string>();
    data?.portfolios.forEach((p, i) => m.set(p.id, PALETTE[i % PALETTE.length]));
    return m;
  }, [data]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Portfolio selector */}
      <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
          Portfolios to compare ({selectedIds.length} selected)
        </div>
        <div className="flex flex-wrap gap-2">
          {allPortfolios.map((p) => {
            const checked = selectedIds.includes(p.id);
            return (
              <label
                key={p.id}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer border ${
                  checked
                    ? "border-accent/60 bg-accent/10 text-terminal-fg"
                    : "border-terminal-border/40 text-terminal-dim hover:text-terminal-fg"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={checked}
                  onChange={() => toggleId(p.id)}
                />
                <span className="truncate max-w-[10rem]">{p.name}</span>
                {p.id === currentPortfolioId && (
                  <span className="text-2xs text-accent-amber">(current)</span>
                )}
              </label>
            );
          })}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => runCompare(selectedIds, days)}
            disabled={selectedIds.length === 0 || loading}
            className="pill text-2xs bg-accent text-black disabled:opacity-40"
          >
            {loading ? "Comparing..." : "Compare"}
          </button>
        </div>
      </div>

      {err && <div className="text-red-400 text-xs py-2">{err}</div>}
      {loading && (
        <div className="text-terminal-dim text-xs py-4 text-center">
          Loading comparison data...
        </div>
      )}

      {data && !loading && (
        <>
          {/* Overlaid equity curves */}
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
            <div className="flex items-center gap-1 flex-wrap mb-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mr-2">
                Equity Curves (Normalized to 100)
              </div>
              <div className="flex-1" />
              {TIME_RANGES.map(({ label, days: d }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => handleRangeChange(d)}
                  className={`pill text-2xs ${
                    days === d ? "bg-accent text-black" : "text-terminal-dim hover:text-terminal-fg"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <CompareCurveChart portfolios={data.portfolios} colorById={colorById} />
            <div className="flex flex-wrap gap-4 mt-2 px-1">
              {data.portfolios.map((p) => (
                <LegendItem
                  key={p.id}
                  color={colorById.get(p.id) ?? "#fff"}
                  label={p.name}
                />
              ))}
            </div>
          </div>

          {/* Side-by-side metrics table */}
          <CompareMetricsTable portfolios={data.portfolios} colorById={colorById} />

          {/* Correlation matrix */}
          {data.portfolios.length >= 2 &&
            data.correlation_labels.length >= 2 && (
              <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
                <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                  Pairwise Correlation
                </div>
                <PortfolioCorrelationHeatmap
                  labels={data.correlation_labels}
                  matrix={data.correlation_matrix}
                />
              </div>
            )}
        </>
      )}
    </div>
  );
}

// ── Equity curve chart ────────────────────────────────────────────────────────

function CompareCurveChart({
  portfolios,
  colorById,
}: {
  portfolios: ComparePortfolio[];
  colorById: Map<number, string>;
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

    portfolios.forEach((p) => {
      if (!p.curve?.dates?.length || !p.curve?.portfolio?.length) return;
      const line = chart.addSeries(LineSeries, {
        color: colorById.get(p.id) ?? "#fff",
        lineWidth: 2,
        title: p.name,
      });
      line.setData(
        p.curve.dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: p.curve.portfolio[i],
        })),
      );
    });

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
  }, [portfolios, colorById]);

  return <div ref={ref} />;
}

// ── Metrics table ─────────────────────────────────────────────────────────────

type RowDir = "higher" | "lower"; // higher = bigger is better

interface MetricRow {
  label: string;
  values: (number | null)[];
  fmt: (v: number | null) => string;
  dir: RowDir;
}

function CompareMetricsTable({
  portfolios,
  colorById,
}: {
  portfolios: ComparePortfolio[];
  colorById: Map<number, string>;
}) {
  const rows: MetricRow[] = [
    { label: "Total Value", values: portfolios.map((p) => p.summary.total_value), fmt: fmtMoney, dir: "higher" },
    { label: "Total P&L", values: portfolios.map((p) => p.summary.total_pl), fmt: fmtMoneySigned, dir: "higher" },
    { label: "Total P&L %", values: portfolios.map((p) => p.summary.total_pl_pct), fmt: fmtPct, dir: "higher" },
    { label: "Ann. Return", values: portfolios.map((p) => p.metrics.ann_return_pct), fmt: fmtPct, dir: "higher" },
    { label: "Volatility", values: portfolios.map((p) => p.metrics.ann_volatility_pct), fmt: fmtPctPlain, dir: "lower" },
    { label: "Sharpe", values: portfolios.map((p) => p.metrics.sharpe), fmt: fmtRatio, dir: "higher" },
    { label: "Sortino", values: portfolios.map((p) => p.metrics.sortino), fmt: fmtRatio, dir: "higher" },
    { label: "Calmar", values: portfolios.map((p) => p.metrics.calmar), fmt: fmtRatio, dir: "higher" },
    { label: "Max Drawdown", values: portfolios.map((p) => p.metrics.max_drawdown_pct), fmt: fmtDrawdown, dir: "higher" },
    { label: "Beta vs SPY", values: portfolios.map((p) => p.metrics.beta), fmt: fmtRatio, dir: "lower" },
    { label: "Alpha", values: portfolios.map((p) => p.metrics.alpha_pct), fmt: fmtPct, dir: "higher" },
    { label: "VaR 95%", values: portfolios.map((p) => p.risk.var_95_daily_pct), fmt: fmtPctPlain, dir: "lower" },
  ];

  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 overflow-x-auto">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        Side-by-Side Metrics
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Metric</th>
            {portfolios.map((p) => (
              <th key={p.id} className="text-right py-1 px-2">
                <span className="inline-flex items-center gap-1 justify-end">
                  <span
                    className="w-2 h-2 rounded-sm inline-block"
                    style={{ backgroundColor: colorById.get(p.id) ?? "#fff" }}
                  />
                  <span className="truncate max-w-[8rem]">{p.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { bestIdx, worstIdx } = bestWorst(row.values, row.dir);
            return (
              <tr key={row.label} className="border-t border-terminal-border/20">
                <td className="py-1.5 px-2 text-terminal-muted">{row.label}</td>
                {row.values.map((v, i) => {
                  let cls = "text-terminal-fg";
                  if (i === bestIdx && bestIdx !== worstIdx) cls = "text-green-400 font-semibold";
                  else if (i === worstIdx && bestIdx !== worstIdx) cls = "text-red-400";
                  return (
                    <td key={i} className={`py-1.5 px-2 text-right tabular-nums ${cls}`}>
                      {row.fmt(v)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Correlation heatmap (same CSS approach as CorrelationMatrix.tsx) ──────────

function PortfolioCorrelationHeatmap({
  labels,
  matrix,
}: {
  labels: string[];
  matrix: Array<Array<number | null>>;
}) {
  return (
    <div className="overflow-auto">
      <div
        className="inline-grid text-2xs"
        style={{ gridTemplateColumns: `auto repeat(${labels.length}, 2.4rem)` }}
      >
        <div />
        {labels.map((t) => (
          <div
            key={`h-${t}`}
            className="h-12 text-terminal-muted text-center align-bottom pb-1"
            title={t}
          >
            <span className="inline-block origin-bottom-left rotate-[-60deg] translate-x-[2px] whitespace-nowrap">
              {clip(t)}
            </span>
          </div>
        ))}
        {labels.map((row, i) => (
          <div key={`r-${row}`} className="contents">
            <div className="pr-2 text-right text-terminal-muted tabular-nums" title={row}>
              {clip(row)}
            </div>
            {labels.map((col, j) => {
              const v = matrix[i]?.[j];
              const isDiag = i === j;
              return (
                <div
                  key={`c-${i}-${j}`}
                  title={`${row} ↔ ${col}\n${v == null ? "—" : v.toFixed(2)}`}
                  className={`h-6 border border-terminal-bg flex items-center justify-center tabular-nums ${
                    isDiag ? "bg-terminal-divider" : ""
                  }`}
                  style={isDiag ? undefined : { background: corrColor(v) }}
                >
                  {!isDiag && v != null ? v.toFixed(2) : ""}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span className="w-4 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bestWorst(values: (number | null)[], dir: RowDir): { bestIdx: number; worstIdx: number } {
  let bestIdx = -1;
  let worstIdx = -1;
  let bestVal = -Infinity;
  let worstVal = Infinity;
  values.forEach((v, i) => {
    if (v == null || Number.isNaN(v)) return;
    // For "lower is better", compare on the negated value so "best" stays max.
    const score = dir === "higher" ? v : -v;
    if (score > bestVal) {
      bestVal = score;
      bestIdx = i;
    }
    if (score < worstVal) {
      worstVal = score;
      worstIdx = i;
    }
  });
  return { bestIdx, worstIdx };
}

function corrColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  const a = Math.min(1, Math.abs(v));
  const alpha = (0.1 + 0.7 * a).toFixed(2);
  return v >= 0
    ? `rgba(34, 197, 94, ${alpha})`
    : `rgba(239, 68, 68, ${alpha})`;
}

function clip(s: string): string {
  return s.length > 10 ? `${s.slice(0, 9)}…` : s;
}

function fmtPct(v: number | null): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPctPlain(v: number | null): string {
  if (v == null) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtDrawdown(v: number | null): string {
  if (v == null) return "--";
  return `-${Math.abs(v).toFixed(2)}%`;
}

function fmtRatio(v: number | null): string {
  if (v == null) return "--";
  return v.toFixed(2);
}

function fmtMoney(v: number | null): string {
  if (v == null) return "--";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtMoneySigned(v: number | null): string {
  if (v == null) return "--";
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
