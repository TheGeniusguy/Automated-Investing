import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { WeightedAnalysis } from "../api/types";

// ── Colors for the two-line growth chart ──────────────────────────────────────
const BOOK_COLOR = "#c9785c"; // clay (the model book)
const BENCH_COLOR = "#6e92c4"; // steel blue (benchmark)

interface HoldingRow {
  symbol: string;
  target_weight: number; // stored as a percent (e.g. 12.5), edited in the table
}

export function WeightedPortfolioPanel() {
  const [rows, setRows] = useState<HoldingRow[]>([]);
  const [benchmark, setBenchmark] = useState("SPY");
  const [notional, setNotional] = useState(100000);
  const [days, setDays] = useState(365);
  const [data, setData] = useState<WeightedAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the table from a payload's holdings (percent form).
  const seedRows = (d: WeightedAnalysis) => {
    setRows(
      (d.holdings ?? []).map((h) => ({
        symbol: h.symbol,
        target_weight: round2((h.target_weight ?? 0) * 100),
      })),
    );
  };

  // Initial load: always-populated sample model book.
  useEffect(() => {
    setLoading(true);
    setErr(null);
    api
      .weightedSample(365)
      .then((res) => {
        setData(res);
        seedRows(res);
        if (res.benchmark) setBenchmark(res.benchmark);
        if (res.notional) setNotional(res.notional);
        if (res.days) setDays(res.days);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyze = () => {
    const holdings = rows
      .map((r) => ({
        symbol: r.symbol.trim().toUpperCase(),
        target_weight: (Number(r.target_weight) || 0) / 100,
      }))
      .filter((h) => h.symbol && h.target_weight > 0);

    if (holdings.length === 0) {
      setErr("Add at least one holding with a target weight.");
      return;
    }

    setLoading(true);
    setErr(null);
    api
      .weightedAnalyze({
        holdings,
        days,
        benchmark: benchmark.trim().toUpperCase() || "SPY",
        notional: Number(notional) || 100000,
      })
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  const updateRow = (i: number, patch: Partial<HoldingRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { symbol: "", target_weight: 0 }]);
  };

  const weightTotal = rows.reduce((s, r) => s + (Number(r.target_weight) || 0), 0);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Weighted / Model Portfolio</span>
        {data && (
          <span className="text-terminal-dim normal-case tracking-normal">
            {data.holdings?.length ?? 0} holdings vs {data.benchmark}
          </span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3">
        {/* ── Editable holdings + controls ──────────────────────────────── */}
        <Section title="Model Holdings">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-right py-1 px-2">Target Weight %</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-terminal-border/20">
                    <td className="py-1 px-2">
                      <input
                        type="text"
                        value={r.symbol}
                        onChange={(e) => updateRow(i, { symbol: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") analyze();
                        }}
                        placeholder="AAPL"
                        className="w-24 bg-terminal-bg border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text uppercase focus:outline-none focus:border-accent"
                      />
                    </td>
                    <td className="py-1 px-2 text-right">
                      <input
                        type="number"
                        step="0.5"
                        value={r.target_weight}
                        onChange={(e) =>
                          updateRow(i, { target_weight: Number(e.target.value) })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") analyze();
                        }}
                        className="w-20 bg-terminal-bg border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text text-right tabular-nums focus:outline-none focus:border-accent"
                      />
                    </td>
                    <td className="py-1 px-1 text-center">
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="text-terminal-dim hover:text-accent-red text-sm leading-none"
                        title="Remove holding"
                      >
                        &times;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-terminal-divider">
                  <td className="py-1.5 px-2 text-terminal-muted text-2xs uppercase tracking-wide">
                    Total
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                      Math.abs(weightTotal - 100) < 0.5
                        ? "text-accent-green"
                        : "text-accent-amber"
                    }`}
                  >
                    {weightTotal.toFixed(1)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-2">
            <button
              type="button"
              onClick={addRow}
              className="pill text-2xs text-terminal-dim hover:text-terminal-text border border-terminal-border/60"
            >
              + Add holding
            </button>
            <div className="flex-1" />
            <label className="flex items-center gap-1.5 text-2xs text-terminal-dim uppercase">
              Benchmark
              <input
                type="text"
                value={benchmark}
                onChange={(e) => setBenchmark(e.target.value)}
                className="w-16 bg-terminal-bg border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text uppercase focus:outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1.5 text-2xs text-terminal-dim uppercase">
              Notional $
              <input
                type="number"
                step="1000"
                value={notional}
                onChange={(e) => setNotional(Number(e.target.value))}
                className="w-28 bg-terminal-bg border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text text-right tabular-nums focus:outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={analyze}
              disabled={loading}
              className="pill text-2xs bg-accent text-black disabled:opacity-40"
            >
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        </Section>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading model portfolio...
          </div>
        )}

        {data && (
          <>
            {/* ── Hero stats ───────────────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <HeroStat
                label="Weighted Return"
                value={fmtPctSigned(data.weighted_total_return_pct)}
                tone={signTone(data.weighted_total_return_pct)}
              />
              <HeroStat
                label={`Benchmark (${data.benchmark})`}
                value={fmtPctSigned(data.benchmark_total_return_pct)}
                tone={signTone(data.benchmark_total_return_pct)}
              />
              <HeroStat
                label="Tracking Error"
                value={fmtPctPlain(data.risk?.tracking_error_pct)}
                tone="neutral"
              />
              <HeroStat
                label="Correlation"
                value={fmtRatio(data.risk?.correlation_to_benchmark)}
                tone="neutral"
              />
            </div>

            {/* Excess return + vol context line */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-terminal-dim px-1">
              <span>
                Excess vs benchmark{" "}
                <span className={signClass(excess(data))}>{fmtPctSigned(excess(data))}</span>
              </span>
              <span>
                Weighted vol{" "}
                <span className="text-terminal-text tabular-nums">
                  {fmtPctPlain(data.risk?.weighted_vol_pct)}
                </span>
              </span>
              <span>
                Benchmark vol{" "}
                <span className="text-terminal-text tabular-nums">
                  {fmtPctPlain(data.risk?.benchmark_vol_pct)}
                </span>
              </span>
            </div>

            {/* ── Normalized growth chart ──────────────────────────────── */}
            <Section title="Normalized Growth (Base 100)">
              <GrowthChart data={data} />
              <div className="flex flex-wrap gap-4 mt-2 px-1">
                <LegendDot color={BOOK_COLOR} label="Model Book" />
                <LegendDot color={BENCH_COLOR} label={data.benchmark} />
              </div>
            </Section>

            {/* ── Contribution to return ───────────────────────────────── */}
            <Section title="Contribution to Return">
              <ContributionBars rows={data.contributions ?? []} />
            </Section>

            {/* ── Drift vs target ──────────────────────────────────────── */}
            <Section title="Drift vs Target">
              <DriftTable rows={data.drift ?? []} />
            </Section>

            {/* ── Rebalance suggestions ────────────────────────────────── */}
            <Section title={`Rebalance Plan (Notional $${fmtNum(data.notional)})`}>
              <RebalanceTable rows={data.rebalance ?? []} />
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
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Hero stat ─────────────────────────────────────────────────────────────────

type Tone = "pos" | "neg" | "neutral";

function HeroStat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const cls =
    tone === "pos"
      ? "text-accent-green"
      : tone === "neg"
        ? "text-accent-red"
        : "text-terminal-text";
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`stat-figure text-2xl ${cls}`}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span className="w-4 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}

// ── Growth chart (book vs benchmark) ──────────────────────────────────────────

function GrowthChart({ data }: { data: WeightedAnalysis }) {
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
      height: 280,
      layout: { background: { color: "transparent" }, textColor: "#a39a8c" },
      grid: { vertLines: { color: "#2e2a24" }, horzLines: { color: "#2e2a24" } },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const dates = data.curves?.dates ?? [];
    const addLine = (vals: number[] | undefined, color: string, title: string) => {
      if (!dates.length || !vals?.length) return;
      const line = chart.addSeries(LineSeries, { color, lineWidth: 2, title });
      line.setData(
        dates.map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: vals[i],
        })),
      );
    };

    addLine(data.curves?.book, BOOK_COLOR, "Model Book");
    addLine(data.curves?.benchmark, BENCH_COLOR, data.benchmark);

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
  }, [data]);

  return <div ref={ref} />;
}

// ── Contribution bars ─────────────────────────────────────────────────────────

function ContributionBars({
  rows,
}: {
  rows: WeightedAnalysis["contributions"];
}) {
  if (!rows.length) {
    return <div className="text-2xs text-terminal-dim">No contribution data.</div>;
  }
  const maxMag = Math.max(0.01, ...rows.map((r) => Math.abs(r.contribution_pct ?? 0)));
  const sorted = [...rows].sort(
    (a, b) => (b.contribution_pct ?? 0) - (a.contribution_pct ?? 0),
  );

  return (
    <div className="flex flex-col gap-1">
      {sorted.map((r) => {
        const c = r.contribution_pct ?? 0;
        const pos = c >= 0;
        const widthPct = (Math.abs(c) / maxMag) * 50; // half-width each side of center
        return (
          <div key={r.symbol} className="flex items-center gap-2 text-xs">
            <span className="w-14 truncate text-terminal-muted">{r.symbol}</span>
            <div className="flex-1 h-4 relative flex items-center">
              {/* center line */}
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-terminal-border" />
              <div
                className="absolute h-3 rounded-sm"
                style={{
                  width: `${widthPct}%`,
                  left: pos ? "50%" : `${50 - widthPct}%`,
                  backgroundColor: pos ? "#5bb97f" : "#e5564b",
                  opacity: 0.85,
                }}
              />
            </div>
            <span
              className={`w-16 text-right tabular-nums ${pos ? "text-accent-green" : "text-accent-red"}`}
            >
              {fmtPctSigned(c)}
            </span>
            <span className="w-20 text-right tabular-nums text-terminal-dim text-2xs">
              {fmtPctPlain((r.target_weight ?? 0) * 100)} wt
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Drift table ───────────────────────────────────────────────────────────────

function DriftTable({ rows }: { rows: WeightedAnalysis["drift"] }) {
  if (!rows.length) {
    return <div className="text-2xs text-terminal-dim">No drift data.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Symbol</th>
            <th className="text-right py-1 px-2">Target</th>
            <th className="text-right py-1 px-2">Current</th>
            <th className="text-right py-1 px-2">Drift</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const drift = r.drift_pct ?? 0;
            return (
              <tr key={r.symbol} className="border-t border-terminal-border/20">
                <td className="py-1.5 px-2 text-terminal-text">{r.symbol}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-muted">
                  {fmtPctPlain((r.target_weight ?? 0) * 100)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-muted">
                  {fmtPctPlain((r.current_weight ?? 0) * 100)}
                </td>
                <td
                  className={`py-1.5 px-2 text-right tabular-nums ${signClass(drift)}`}
                >
                  {fmtPctSigned(drift)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Rebalance table ───────────────────────────────────────────────────────────

function RebalanceTable({ rows }: { rows: WeightedAnalysis["rebalance"] }) {
  if (!rows.length) {
    return <div className="text-2xs text-terminal-dim">No rebalance suggestions.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Symbol</th>
            <th className="text-left py-1 px-2">Action</th>
            <th className="text-right py-1 px-2">Target</th>
            <th className="text-right py-1 px-2">Current</th>
            <th className="text-right py-1 px-2">Delta</th>
            <th className="text-right py-1 px-2">Suggested $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-t border-terminal-border/20">
              <td className="py-1.5 px-2 text-terminal-text">{r.symbol}</td>
              <td className="py-1.5 px-2">
                <span className={`pill text-2xs ${actionClass(r.action)}`}>
                  {(r.action ?? "hold").toUpperCase()}
                </span>
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-muted">
                {fmtPctPlain((r.target_weight ?? 0) * 100)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-muted">
                {fmtPctPlain((r.current_weight ?? 0) * 100)}
              </td>
              <td className={`py-1.5 px-2 text-right tabular-nums ${signClass(r.delta_pct)}`}>
                {fmtPctSigned(r.delta_pct)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-text">
                {fmtDollarsSigned(r.suggested_dollars)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function excess(d: WeightedAnalysis): number | null {
  if (d.weighted_total_return_pct == null || d.benchmark_total_return_pct == null) return null;
  return d.weighted_total_return_pct - d.benchmark_total_return_pct;
}

function signTone(v: number | null | undefined): Tone {
  if (v == null) return "neutral";
  return v >= 0 ? "pos" : "neg";
}

function signClass(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function actionClass(action: string | undefined): string {
  switch ((action ?? "").toLowerCase()) {
    case "buy":
      return "bg-accent-green/20 text-accent-green";
    case "trim":
    case "sell":
      return "bg-accent-red/20 text-accent-red";
    default:
      return "bg-terminal-border/40 text-terminal-muted";
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fmtPctSigned(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPctPlain(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtRatio(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toFixed(2);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return Math.round(v).toLocaleString();
}

function fmtDollarsSigned(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}
