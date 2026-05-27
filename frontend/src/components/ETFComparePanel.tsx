import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { etfApi } from "../api/client";
import type { ETFCompareResponse, ETFMetrics } from "../api/types";

// ── Shared color palette ──────────────────────────────────────────────────────
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

const PRESETS: { label: string; symbols: string[] }[] = [
  { label: "US Equity", symbols: ["SPY", "QQQ", "IWM", "DIA"] },
  { label: "Fixed Income", symbols: ["TLT", "IEF", "BND", "HYG"] },
  { label: "Factors", symbols: ["VTV", "VUG", "MTUM", "QUAL", "VLUE"] },
  { label: "Commodities", symbols: ["GLD", "SLV", "USO", "DBA"] },
  { label: "Sectors", symbols: ["XLK", "XLF", "XLE", "XLV", "XLU", "XLB", "XLRE"] },
];

const TIME_RANGES = [
  { label: "1M", days: 21 },
  { label: "3M", days: 63 },
  { label: "6M", days: 126 },
  { label: "1Y", days: 252 },
  { label: "3Y", days: 756 },
  { label: "5Y", days: 1260 },
  { label: "Max", days: 3650 },
];

const BENCHMARKS = ["SPY", "QQQ", "IWM", "None"];

const ROLLING_WINDOWS: { key: string; label: string }[] = [
  { key: "1M", label: "1 Month" },
  { key: "3M", label: "3 Month" },
  { key: "6M", label: "6 Month" },
  { key: "1Y", label: "1 Year" },
  { key: "YTD", label: "YTD" },
  { key: "ALL", label: "All Period" },
];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ETFComparePanel() {
  const [input, setInput] = useState("SPY,QQQ,IWM");
  const [symbols, setSymbols] = useState<string[]>(["SPY", "QQQ", "IWM"]);
  const [days, setDays] = useState(252);
  const [benchmark, setBenchmark] = useState("SPY");
  const [data, setData] = useState<ETFCompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runCompare = (syms: string[], d: number, bench: string) => {
    const clean = syms.map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (clean.length === 0) {
      setErr("Enter at least one symbol.");
      return;
    }
    setLoading(true);
    setErr(null);
    etfApi
      .compare(clean, d, bench === "None" ? "SPY" : bench)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  // Initial load.
  useEffect(() => {
    runCompare(["SPY", "QQQ", "IWM"], 252, "SPY");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitInput = () => {
    const parsed = input
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    setSymbols(parsed);
    runCompare(parsed, days, benchmark);
  };

  const applyPreset = (preset: string[]) => {
    setInput(preset.join(","));
    setSymbols(preset);
    runCompare(preset, days, benchmark);
  };

  const changeRange = (d: number) => {
    setDays(d);
    if (symbols.length) runCompare(symbols, d, benchmark);
  };

  const changeBenchmark = (b: string) => {
    setBenchmark(b);
    if (symbols.length) runCompare(symbols, days, b);
  };

  const colorBySymbol = useMemo(() => {
    const m = new Map<string, string>();
    (data?.symbols ?? []).forEach((s, i) => m.set(s, PALETTE[i % PALETTE.length]));
    return m;
  }, [data]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">
          ETF &amp; Ticker Comparison
        </span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Header / Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitInput();
              }}
              placeholder="SPY, QQQ, IWM"
              className="flex-1 min-w-[12rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={submitInput}
              disabled={loading}
              className="pill text-2xs bg-accent text-black disabled:opacity-40"
            >
              {loading ? "Loading..." : "Compare"}
            </button>
          </div>

          {/* Presets */}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-2xs text-terminal-dim uppercase mr-1">Presets:</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p.symbols)}
                className="pill text-2xs text-terminal-dim hover:text-terminal-fg"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Range + benchmark */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-terminal-dim uppercase mr-1">Range:</span>
            {TIME_RANGES.map(({ label, days: d }) => (
              <button
                key={label}
                type="button"
                onClick={() => changeRange(d)}
                className={`pill text-2xs ${
                  days === d ? "bg-accent text-black" : "text-terminal-dim hover:text-terminal-fg"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="flex-1" />
            <span className="text-2xs text-terminal-dim uppercase mr-1">Benchmark:</span>
            {BENCHMARKS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => changeBenchmark(b)}
                className={`pill text-2xs ${
                  benchmark === b ? "bg-blue-600/40 text-blue-300" : "text-terminal-dim hover:text-terminal-fg"
                }`}
              >
                {b}
              </button>
            ))}
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
            {/* Section 1 — Performance chart */}
            <Section title="Performance (Normalized to 100)">
              <ETFCurveChart data={data} colorBySymbol={colorBySymbol} />
              <div className="flex flex-wrap gap-4 mt-2 px-1">
                {data.symbols.map((s) => (
                  <div
                    key={s}
                    className="flex items-center gap-1.5 text-2xs text-terminal-dim"
                  >
                    <span
                      className="w-4 h-0.5 rounded inline-block"
                      style={{ backgroundColor: colorBySymbol.get(s) ?? "#fff" }}
                    />
                    {s}
                    <span className={colorPct(data.metrics[s]?.total_return_pct)}>
                      {fmtPct(data.metrics[s]?.total_return_pct)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            {/* Section 2 — Info cards */}
            <Section title="ETF Info">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {data.symbols.map((s) => {
                  const info = data.info[s];
                  return (
                    <div
                      key={s}
                      className="min-w-[12rem] flex-shrink-0 bg-terminal-panel border border-terminal-border/40 rounded p-2"
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span
                          className="w-2 h-2 rounded-sm inline-block"
                          style={{ backgroundColor: colorBySymbol.get(s) ?? "#fff" }}
                        />
                        <span className="text-xs font-semibold text-terminal-fg">{s}</span>
                      </div>
                      <div className="text-2xs text-terminal-dim truncate mb-1" title={info?.name ?? ""}>
                        {info?.name ?? "—"}
                      </div>
                      <InfoRow label="Category" value={info?.category ?? "—"} />
                      <InfoRow label="Expense" value={info?.expense_ratio != null ? `${info.expense_ratio.toFixed(2)}%` : "—"} />
                      <InfoRow label="AUM" value={fmtAum(info?.aum)} />
                      <InfoRow label="Beta" value={info?.beta != null ? info.beta.toFixed(2) : "—"} />
                      <InfoRow label="Inception" value={info?.inception_date ?? "—"} />
                      <InfoRow label="P/E" value={info?.pe_ratio != null ? info.pe_ratio.toFixed(1) : "—"} />
                      <InfoRow label="Div Yield" value={info?.dividend_yield != null ? `${info.dividend_yield.toFixed(2)}%` : "—"} />
                    </div>
                  );
                })}
              </div>
            </Section>

            {/* Section 3 — Metrics table */}
            <Section title="Metrics">
              <ETFMetricsTable data={data} colorBySymbol={colorBySymbol} />
            </Section>

            {/* Section 4 — Rolling returns */}
            <Section title="Rolling Returns">
              <RollingReturnsTable data={data} colorBySymbol={colorBySymbol} />
            </Section>

            {/* Section 5 — Monthly returns heatmap */}
            <Section title="Monthly Returns">
              <div className="flex flex-col gap-3">
                {data.symbols.map((s) => (
                  <MonthlyHeatmap key={s} symbol={s} months={data.monthly_returns[s] ?? {}} />
                ))}
              </div>
            </Section>

            {/* Section 6 — Correlation + factor exposures */}
            <Section title="Correlation &amp; Factor Exposures">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <div className="text-2xs text-terminal-dim uppercase mb-1">Correlation</div>
                  <CorrHeatmap labels={data.correlation_labels} matrix={data.correlation_matrix} />
                </div>
                <div>
                  <div className="text-2xs text-terminal-dim uppercase mb-1">Factor Exposures (beta)</div>
                  <FactorExposures data={data} colorBySymbol={colorBySymbol} />
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div
        className="text-2xs text-terminal-muted uppercase tracking-wider mb-2"
        // title may contain an HTML entity; render text directly.
      >
        {title.replace("&amp;", "&")}
      </div>
      {children}
    </div>
  );
}

// ── Performance chart ─────────────────────────────────────────────────────────

function ETFCurveChart({
  data,
  colorBySymbol,
}: {
  data: ETFCompareResponse;
  colorBySymbol: Map<string, string>;
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

    const { dates, series } = data.curves;
    data.symbols.forEach((sym) => {
      const vals = series[sym];
      if (!dates?.length || !vals?.length) return;
      const line = chart.addSeries(LineSeries, {
        color: colorBySymbol.get(sym) ?? "#fff",
        lineWidth: 2,
        title: sym,
      });
      line.setData(
        dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: vals[i],
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
  }, [data, colorBySymbol]);

  return <div ref={ref} />;
}

// ── Metrics table ─────────────────────────────────────────────────────────────

type RowDir = "higher" | "lower";

interface ETFMetricRow {
  label: string;
  pick: (m: ETFMetrics) => number | null;
  fmt: (v: number | null) => string;
  dir: RowDir;
}

const METRIC_ROWS: ETFMetricRow[] = [
  { label: "Total Return", pick: (m) => m.total_return_pct, fmt: fmtPct, dir: "higher" },
  { label: "Ann. Return", pick: (m) => m.ann_return_pct, fmt: fmtPct, dir: "higher" },
  { label: "YTD Return", pick: (m) => m.ytd_return_pct, fmt: fmtPct, dir: "higher" },
  { label: "Ann. Volatility", pick: (m) => m.ann_volatility_pct, fmt: fmtPctPlain, dir: "lower" },
  { label: "Sharpe Ratio", pick: (m) => m.sharpe, fmt: fmtRatio, dir: "higher" },
  { label: "Sortino Ratio", pick: (m) => m.sortino, fmt: fmtRatio, dir: "higher" },
  { label: "Calmar Ratio", pick: (m) => m.calmar, fmt: fmtRatio, dir: "higher" },
  { label: "Max Drawdown", pick: (m) => m.max_drawdown_pct, fmt: fmtDrawdown, dir: "higher" },
  { label: "VaR 95% (daily)", pick: (m) => m.var_95_daily_pct, fmt: fmtPctPlain, dir: "lower" },
  { label: "CVaR 95%", pick: (m) => m.cvar_95_daily_pct, fmt: fmtPctPlain, dir: "lower" },
  { label: "Beta vs Benchmark", pick: (m) => m.beta_vs_benchmark, fmt: fmtRatio, dir: "lower" },
  { label: "Alpha vs Benchmark", pick: (m) => m.alpha_vs_benchmark_pct, fmt: fmtPct, dir: "higher" },
  { label: "R²", pick: (m) => m.r_squared, fmt: fmtRatio, dir: "higher" },
  { label: "Win Rate vs Benchmark", pick: (m) => m.win_rate_vs_benchmark_pct, fmt: fmtPctPlain, dir: "higher" },
  { label: "Up Capture", pick: (m) => m.up_capture, fmt: fmtRatio, dir: "higher" },
  { label: "Down Capture", pick: (m) => m.down_capture, fmt: fmtRatio, dir: "lower" },
];

function ETFMetricsTable({
  data,
  colorBySymbol,
}: {
  data: ETFCompareResponse;
  colorBySymbol: Map<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Metric</th>
            {data.symbols.map((s) => (
              <th key={s} className="text-right py-1 px-2">
                <span className="inline-flex items-center gap-1 justify-end">
                  <span
                    className="w-2 h-2 rounded-sm inline-block"
                    style={{ backgroundColor: colorBySymbol.get(s) ?? "#fff" }}
                  />
                  {s}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => {
            const values = data.symbols.map((s) =>
              data.metrics[s] ? row.pick(data.metrics[s]) : null,
            );
            const { bestIdx, worstIdx } = bestWorst(values, row.dir);
            return (
              <tr key={row.label} className="border-t border-terminal-border/20">
                <td className="py-1.5 px-2 text-terminal-muted">{row.label}</td>
                {values.map((v, i) => {
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

// ── Rolling returns ───────────────────────────────────────────────────────────

function RollingReturnsTable({
  data,
  colorBySymbol,
}: {
  data: ETFCompareResponse;
  colorBySymbol: Map<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Window</th>
            {data.symbols.map((s) => (
              <th key={s} className="text-right py-1 px-2">
                <span className="inline-flex items-center gap-1 justify-end">
                  <span
                    className="w-2 h-2 rounded-sm inline-block"
                    style={{ backgroundColor: colorBySymbol.get(s) ?? "#fff" }}
                  />
                  {s}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLLING_WINDOWS.map((win) => (
            <tr key={win.key} className="border-t border-terminal-border/20">
              <td className="py-1.5 px-2 text-terminal-muted">{win.label}</td>
              {data.symbols.map((s) => {
                const v = data.rolling_returns[s]?.[win.key] ?? null;
                return (
                  <td key={s} className={`py-1.5 px-2 text-right tabular-nums ${colorPct(v)}`}>
                    {fmtPct(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Monthly returns heatmap ───────────────────────────────────────────────────

function MonthlyHeatmap({
  symbol,
  months,
}: {
  symbol: string;
  months: Record<string, number>;
}) {
  // Build year -> [12 monthly values].
  const years = useMemo(() => {
    const byYear = new Map<string, (number | null)[]>();
    Object.entries(months).forEach(([ym, val]) => {
      const [y, m] = ym.split("-");
      const mi = parseInt(m, 10) - 1;
      if (Number.isNaN(mi) || mi < 0 || mi > 11) return;
      if (!byYear.has(y)) byYear.set(y, Array(12).fill(null));
      byYear.get(y)![mi] = val;
    });
    return [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [months]);

  if (years.length === 0) {
    return <div className="text-2xs text-terminal-dim">{symbol}: no monthly data</div>;
  }

  return (
    <div>
      <div className="text-2xs text-terminal-fg font-semibold mb-1">{symbol}</div>
      <div className="overflow-x-auto">
        <table className="text-2xs border-collapse">
          <thead>
            <tr>
              <th className="text-left pr-2 text-terminal-dim font-normal">Year</th>
              {MONTH_LABELS.map((m) => (
                <th key={m} className="text-center px-1 text-terminal-dim font-normal w-9">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map(([y, vals]) => (
              <tr key={y}>
                <td className="pr-2 text-terminal-muted tabular-nums">{y}</td>
                {vals.map((v, i) => (
                  <td
                    key={i}
                    className="text-center px-1 py-0.5 tabular-nums border border-terminal-bg"
                    style={{ background: monthlyColor(v), color: v == null ? "#4b5563" : "#0a0a0a" }}
                    title={v == null ? "" : `${y}-${String(i + 1).padStart(2, "0")}: ${v.toFixed(2)}%`}
                  >
                    {v == null ? "" : v.toFixed(1)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Correlation heatmap ───────────────────────────────────────────────────────

function CorrHeatmap({
  labels,
  matrix,
}: {
  labels: string[];
  matrix: Array<Array<number | null>>;
}) {
  if (labels.length < 2) {
    return <div className="text-2xs text-terminal-dim">Add 2+ symbols for correlation.</div>;
  }
  return (
    <div className="overflow-auto">
      <div
        className="inline-grid text-2xs"
        style={{ gridTemplateColumns: `auto repeat(${labels.length}, 2.4rem)` }}
      >
        <div />
        {labels.map((t) => (
          <div key={`h-${t}`} className="h-10 text-terminal-muted text-center align-bottom pb-1" title={t}>
            <span className="inline-block origin-bottom-left rotate-[-60deg] translate-x-[2px] whitespace-nowrap">
              {t}
            </span>
          </div>
        ))}
        {labels.map((row, i) => (
          <div key={`r-${row}`} className="contents">
            <div className="pr-2 text-right text-terminal-muted tabular-nums" title={row}>
              {row}
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

// ── Factor exposures bar chart ────────────────────────────────────────────────

function FactorExposures({
  data,
  colorBySymbol,
}: {
  data: ETFCompareResponse;
  colorBySymbol: Map<string, string>;
}) {
  // Collect the union of factors, grouped: one group per factor, bars per symbol.
  const factors = useMemo(() => {
    const set = new Set<string>();
    Object.values(data.factor_exposures).forEach((arr) =>
      arr.forEach((f) => set.add(f.factor)),
    );
    return [...set];
  }, [data]);

  // Lookup: symbol -> factor -> beta.
  const lookup = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    Object.entries(data.factor_exposures).forEach(([sym, arr]) => {
      const inner = new Map<string, number>();
      arr.forEach((f) => inner.set(f.factor, f.beta));
      m.set(sym, inner);
    });
    return m;
  }, [data]);

  if (factors.length === 0) {
    return <div className="text-2xs text-terminal-dim">No factor exposure data.</div>;
  }

  // Max magnitude for scaling the bar widths.
  let maxMag = 0.1;
  factors.forEach((f) =>
    data.symbols.forEach((s) => {
      const b = lookup.get(s)?.get(f);
      if (b != null) maxMag = Math.max(maxMag, Math.abs(b));
    }),
  );

  return (
    <div className="flex flex-col gap-2">
      {factors.map((f) => (
        <div key={f}>
          <div className="text-2xs text-terminal-muted mb-0.5">{f}</div>
          <div className="flex flex-col gap-0.5">
            {data.symbols.map((s) => {
              const b = lookup.get(s)?.get(f);
              const pct = b == null ? 0 : (Math.abs(b) / maxMag) * 100;
              return (
                <div key={s} className="flex items-center gap-1">
                  <span className="text-2xs text-terminal-dim w-10 truncate">{s}</span>
                  <div className="flex-1 h-3 bg-terminal-panel rounded-sm overflow-hidden relative">
                    <div
                      className="h-full rounded-sm"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: colorBySymbol.get(s) ?? "#fff",
                        opacity: b != null && b < 0 ? 0.45 : 0.85,
                      }}
                    />
                  </div>
                  <span className="text-2xs tabular-nums text-terminal-fg w-10 text-right">
                    {b == null ? "—" : b.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-2xs">
      <span className="text-terminal-dim">{label}</span>
      <span className="text-terminal-fg tabular-nums truncate ml-2">{value}</span>
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

function monthlyColor(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  if (v > 5) return "rgba(22, 163, 74, 0.95)"; // deep green
  if (v >= 1) return "rgba(34, 197, 94, 0.55)"; // light green
  if (v > -1) return "rgba(120, 120, 120, 0.45)"; // gray (near zero)
  if (v >= -5) return "rgba(239, 68, 68, 0.5)"; // light red
  return "rgba(185, 28, 28, 0.95)"; // deep red
}

function corrColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  const a = Math.min(1, Math.abs(v));
  const alpha = (0.1 + 0.7 * a).toFixed(2);
  return v >= 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
}

function colorPct(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-green-400" : "text-red-400";
}

function fmtPct(v: number | null | undefined): string {
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

function fmtAum(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toLocaleString()}`;
}
