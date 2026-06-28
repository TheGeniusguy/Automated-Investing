import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { ETFTrackingResponse, ETFTrackEntry } from "../api/types";

// Distinct line colors, one per ETF.
const PALETTE = [
  "#c9785c", // clay
  "#6e92c4", // steel blue
  "#5bb97f", // sage green
  "#e5564b", // red
  "#d8a657", // amber
  "#a78bfa", // violet
  "#34d399", // teal
  "#fb923c", // orange
];

const PERF_WINDOWS: { key: string; label: string }[] = [
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "6M", label: "6M" },
  { key: "1Y", label: "1Y" },
  { key: "YTD", label: "YTD" },
];

const RANGES = [
  { label: "6M", days: 126 },
  { label: "1Y", days: 252 },
  { label: "3Y", days: 756 },
];

const DEFAULT_INPUT = "SPY,QQQ,IWM,DIA";

export function ETFTrackingPanel() {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [days, setDays] = useState(252);
  const [data, setData] = useState<ETFTrackingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (raw: string, d: number) => {
    const clean = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (clean.length === 0) {
      setErr("Enter at least one symbol.");
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .etfTrack(clean, d)
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
    run(DEFAULT_INPUT, 252);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => run(input, days);
  const changeRange = (d: number) => {
    setDays(d);
    run(input, d);
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
          ETF Tracking
        </span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="SPY, QQQ, IWM, DIA"
              className="flex-1 min-w-[12rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text font-mono focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={submit}
              disabled={loading}
              className="pill text-2xs bg-accent text-black disabled:opacity-40"
            >
              {loading ? "Loading..." : "Track"}
            </button>
            <div className="flex items-center gap-1">
              {RANGES.map(({ label, days: d }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => changeRange(d)}
                  className={`pill text-2xs ${
                    days === d
                      ? "bg-accent text-black"
                      : "text-terminal-dim hover:text-terminal-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {data?.benchmark && (
            <div className="text-2xs text-terminal-dim">
              Tracking error and beta vs benchmark {data.benchmark}
            </div>
          )}
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading ETF data...
          </div>
        )}

        {data && (
          <>
            {/* Normalized growth chart */}
            <Section title="Normalized Growth (base 100)">
              <GrowthChart data={data} colorBySymbol={colorBySymbol} />
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
                    <span className={colorPct(data.etfs[s]?.perf?.["1Y"])}>
                      {fmtPct(data.etfs[s]?.perf?.["1Y"])}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            {/* Metrics table */}
            <Section title="Metrics">
              <MetricsTable data={data} colorBySymbol={colorBySymbol} />
            </Section>

            {/* Sector exposure */}
            <Section title="Sector Exposure">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {data.symbols.map((s) => (
                  <SectorBars
                    key={s}
                    symbol={s}
                    etf={data.etfs[s]}
                    color={colorBySymbol.get(s) ?? "#c9785c"}
                  />
                ))}
              </div>
            </Section>

            {/* Holdings overlap heatmap */}
            <Section title="Holdings Overlap (%)">
              <OverlapHeatmap matrix={data.overlap_matrix} />
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

// ── Normalized growth chart ───────────────────────────────────────────────────

function GrowthChart({
  data,
  colorBySymbol,
}: {
  data: ETFTrackingResponse;
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
      layout: { background: { color: "transparent" }, textColor: "#a39a8c" },
      grid: { vertLines: { color: "#2e2a24" }, horzLines: { color: "#2e2a24" } },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
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

function MetricsTable({
  data,
  colorBySymbol,
}: {
  data: ETFTrackingResponse;
  colorBySymbol: Map<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">ETF</th>
            <th className="text-left py-1 px-2">Name</th>
            {PERF_WINDOWS.map((w) => (
              <th key={w.key} className="text-right py-1 px-2">
                {w.label}
              </th>
            ))}
            <th className="text-right py-1 px-2">Expense</th>
            <th className="text-right py-1 px-2">AUM</th>
            <th className="text-right py-1 px-2">Yield</th>
            <th className="text-right py-1 px-2">Track Err</th>
            <th className="text-right py-1 px-2">Beta</th>
          </tr>
        </thead>
        <tbody>
          {data.symbols.map((s) => {
            const e = data.etfs[s];
            if (!e) return null;
            return (
              <tr key={s} className="border-t border-terminal-border/20">
                <td className="py-1.5 px-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-sm inline-block"
                      style={{ backgroundColor: colorBySymbol.get(s) ?? "#fff" }}
                    />
                    <span className="text-terminal-text font-semibold">{s}</span>
                  </span>
                </td>
                <td
                  className="py-1.5 px-2 text-terminal-muted max-w-[14rem] truncate"
                  title={e.name}
                >
                  {e.name ?? "--"}
                </td>
                {PERF_WINDOWS.map((w) => {
                  const v = e.perf?.[w.key];
                  return (
                    <td
                      key={w.key}
                      className={`py-1.5 px-2 text-right tabular-nums font-mono ${colorPct(v)}`}
                    >
                      {fmtPct(v)}
                    </td>
                  );
                })}
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-terminal-text">
                  {fmtPctPlain(e.expense_ratio_pct)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-terminal-text">
                  {e.aum_display ?? "--"}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-terminal-text">
                  {fmtPctPlain(e.yield_pct)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-terminal-text">
                  {fmtPctPlain(e.tracking_error)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-terminal-text">
                  {e.beta != null ? e.beta.toFixed(2) : "--"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Sector exposure bars ──────────────────────────────────────────────────────

function SectorBars({
  symbol,
  etf,
  color,
}: {
  symbol: string;
  etf: ETFTrackEntry | undefined;
  color: string;
}) {
  const sectors = etf?.sectors ?? [];
  const maxWeight = useMemo(
    () => Math.max(0.01, ...sectors.map((s) => s.weight ?? 0)),
    [sectors],
  );

  return (
    <div className="border border-terminal-border/40 rounded p-2 bg-terminal-panel/30">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-2 h-2 rounded-sm inline-block"
          style={{ backgroundColor: color }}
        />
        <span className="text-2xs text-terminal-text font-semibold">{symbol}</span>
      </div>
      {sectors.length === 0 ? (
        <div className="text-2xs text-terminal-dim">No sector data.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {sectors.map((sec) => (
            <div key={sec.sector} className="flex items-center gap-2">
              <span
                className="text-2xs text-terminal-muted w-28 truncate"
                title={sec.sector}
              >
                {sec.sector}
              </span>
              <div className="flex-1 h-3 bg-terminal-panel rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${((sec.weight ?? 0) / maxWeight) * 100}%`,
                    backgroundColor: color,
                    opacity: 0.85,
                  }}
                />
              </div>
              <span className="text-2xs tabular-nums font-mono text-terminal-text w-12 text-right">
                {fmtPctPlain(sec.weight)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Holdings overlap heatmap ──────────────────────────────────────────────────

function OverlapHeatmap({
  matrix,
}: {
  matrix: ETFTrackingResponse["overlap_matrix"];
}) {
  const labels = matrix?.labels ?? [];
  const grid = matrix?.matrix ?? [];
  if (labels.length < 2) {
    return (
      <div className="text-2xs text-terminal-dim">
        Add 2 or more ETFs for overlap.
      </div>
    );
  }
  return (
    <div className="overflow-auto">
      <div
        className="inline-grid text-2xs"
        style={{ gridTemplateColumns: `auto repeat(${labels.length}, 2.8rem)` }}
      >
        <div />
        {labels.map((t) => (
          <div
            key={`h-${t}`}
            className="h-10 text-terminal-muted text-center align-bottom pb-1"
            title={t}
          >
            <span className="inline-block origin-bottom-left rotate-[-60deg] translate-x-[2px] whitespace-nowrap">
              {t}
            </span>
          </div>
        ))}
        {labels.map((row, i) => (
          <div key={`r-${row}`} className="contents">
            <div
              className="pr-2 text-right text-terminal-muted tabular-nums font-mono"
              title={row}
            >
              {row}
            </div>
            {labels.map((col, j) => {
              const v = grid[i]?.[j];
              const isDiag = i === j;
              const val = isDiag ? 100 : v;
              return (
                <div
                  key={`c-${i}-${j}`}
                  title={`${row} / ${col}: ${val == null ? "--" : val.toFixed(0)}%`}
                  className="h-7 border border-terminal-bg flex items-center justify-center tabular-nums font-mono"
                  style={{
                    background: overlapColor(val),
                    color: clayTextColor(val),
                  }}
                >
                  {val == null ? "" : val.toFixed(0)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Clay intensity scaled by overlap value (0-100).
function overlapColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  const a = Math.min(1, Math.max(0, v / 100));
  const alpha = (0.08 + 0.85 * a).toFixed(2);
  // clay: rgb(201, 120, 92)
  return `rgba(201, 120, 92, ${alpha})`;
}

function clayTextColor(v: number | null | undefined): string {
  if (v == null) return "#6e665a";
  return v >= 45 ? "#181613" : "#ece7df";
}

function colorPct(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPctPlain(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(2)}%`;
}
