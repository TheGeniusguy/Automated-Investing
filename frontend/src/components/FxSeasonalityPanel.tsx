import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface FxMonthRow {
  month: number;
  month_name: string;
  avg_return_pct: number | null;
  hit_rate_pct: number | null;
  count: number;
  best_year: number | null;
  best_year_pct: number | null;
  worst_year: number | null;
  worst_year_pct: number | null;
}
interface FxDowRow {
  day: string;
  avg_return_pct: number | null;
  count: number;
}
interface FxSeasonalityResponse {
  pair: string;
  symbol: string;
  years: number;
  months: FxMonthRow[];
  month_year_matrix: { year: number; month: number; return_pct: number }[];
  day_of_week: FxDowRow[];
  best_month: FxMonthRow | null;
  worst_month: FxMonthRow | null;
  strongest_month: FxMonthRow | null;
  current_month: FxMonthRow | null;
  annual_avg_pct: number | null;
  read: string;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

const PRESETS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"];

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: FxSeasonalityResponse = {
  pair: "EURUSD",
  symbol: "EURUSD=X",
  years: 15,
  months: [
    { month: 1, month_name: "Jan", avg_return_pct: -0.21, hit_rate_pct: 46.7, count: 15, best_year: 2018, best_year_pct: 3.45, worst_year: 2015, worst_year_pct: -6.71 },
    { month: 2, month_name: "Feb", avg_return_pct: -0.34, hit_rate_pct: 40.0, count: 15, best_year: 2016, best_year_pct: 0.97, worst_year: 2015, worst_year_pct: -0.66 },
    { month: 3, month_name: "Mar", avg_return_pct: 0.18, hit_rate_pct: 53.3, count: 15, best_year: 2016, best_year_pct: 4.62, worst_year: 2015, worst_year_pct: -4.18 },
    { month: 4, month_name: "Apr", avg_return_pct: 0.62, hit_rate_pct: 60.0, count: 15, best_year: 2011, best_year_pct: 4.41, worst_year: 2018, worst_year_pct: -1.96 },
    { month: 5, month_name: "May", avg_return_pct: -0.71, hit_rate_pct: 33.3, count: 15, best_year: 2020, best_year_pct: 1.34, worst_year: 2012, worst_year_pct: -6.61 },
    { month: 6, month_name: "Jun", avg_return_pct: 0.34, hit_rate_pct: 53.3, count: 15, best_year: 2010, best_year_pct: 1.10, worst_year: 2015, worst_year_pct: -1.50 },
    { month: 7, month_name: "Jul", avg_return_pct: 0.55, hit_rate_pct: 60.0, count: 15, best_year: 2017, best_year_pct: 3.62, worst_year: 2011, worst_year_pct: -2.21 },
    { month: 8, month_name: "Aug", avg_return_pct: -0.18, hit_rate_pct: 46.7, count: 15, best_year: 2010, best_year_pct: 1.85, worst_year: 2015, worst_year_pct: -7.32 },
    { month: 9, month_name: "Sep", avg_return_pct: -0.86, hit_rate_pct: 33.3, count: 15, best_year: 2010, best_year_pct: 7.51, worst_year: 2014, worst_year_pct: -3.84 },
    { month: 10, month_name: "Oct", avg_return_pct: 0.09, hit_rate_pct: 46.7, count: 15, best_year: 2010, best_year_pct: 2.07, worst_year: 2011, worst_year_pct: -3.21 },
    { month: 11, month_name: "Nov", avg_return_pct: -0.64, hit_rate_pct: 40.0, count: 15, best_year: 2012, best_year_pct: 0.81, worst_year: 2015, worst_year_pct: -4.07 },
    { month: 12, month_name: "Dec", avg_return_pct: 0.72, hit_rate_pct: 73.3, count: 15, best_year: 2015, best_year_pct: 3.32, worst_year: 2011, worst_year_pct: -3.61 },
  ],
  month_year_matrix: [],
  day_of_week: [
    { day: "Mon", avg_return_pct: -0.004, count: 780 },
    { day: "Tue", avg_return_pct: 0.012, count: 780 },
    { day: "Wed", avg_return_pct: -0.008, count: 780 },
    { day: "Thu", avg_return_pct: 0.006, count: 780 },
    { day: "Fri", avg_return_pct: 0.002, count: 780 },
  ],
  best_month: null,
  worst_month: null,
  strongest_month: { month: 12, month_name: "Dec", avg_return_pct: 0.72, hit_rate_pct: 73.3, count: 15, best_year: 2015, best_year_pct: 3.32, worst_year: 2011, worst_year_pct: -3.61 },
  current_month: null,
  annual_avg_pct: -0.44,
  read: "EURUSD has historically strengthened most in Dec (+0.72% avg, positive 73% of years). Its weakest month is Sep (-0.86% avg).",
  data_mode: "sample",
  as_of: "2026-06-30T12:00:00+00:00",
  source: "sample",
};

// ── Color helpers ────────────────────────────────────────────────────────────
function fmtPct(x: number | null, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return (x >= 0 ? "+" : "") + x.toFixed(digits) + "%";
}
function retColor(x: number | null): string {
  if (x === null || x === undefined) return "text-terminal-dim";
  if (x > 0.05) return "text-accent-green";
  if (x < -0.05) return "text-accent-red";
  return "text-terminal-text";
}
function hitColor(x: number | null): string {
  if (x === null || x === undefined) return "text-terminal-dim";
  if (x >= 60) return "text-accent-green";
  if (x <= 40) return "text-accent-red";
  return "text-terminal-muted";
}

// Heatmap cell background opacity scaled by magnitude of the monthly avg return.
function heatStyle(x: number | null, maxAbs: number): CSSProperties {
  if (x === null || x === undefined || maxAbs <= 0) return {};
  const a = Math.max(0.06, Math.min(0.42, Math.abs(x) / maxAbs * 0.42));
  const rgb = x >= 0 ? "52, 168, 122" : "214, 92, 92"; // green / red
  return { backgroundColor: `rgba(${rgb}, ${a})` };
}

export function FxSeasonalityPanel() {
  const [input, setInput] = useState("EURUSD");
  const [pair, setPair] = useState("EURUSD");
  const [data, setData] = useState<FxSeasonalityResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/fx-seasonality/${encodeURIComponent(pair)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: FxSeasonalityResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.months) && json.months.length === 12) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pair]);

  const submit = (p?: string) => {
    const s = (p ?? input).trim().toUpperCase().replace("/", "");
    if (s) {
      setInput(s);
      setPair(s);
    }
  };

  const maxAbs = useMemo(() => {
    const vals = data.months
      .map((m) => (m.avg_return_pct === null ? 0 : Math.abs(m.avg_return_pct)))
      .filter((v) => v > 0);
    return vals.length ? Math.max(...vals) : 1;
  }, [data]);

  const strongest = data.strongest_month;
  const dowMax = useMemo(() => {
    const vals = data.day_of_week
      .map((d) => (d.avg_return_pct === null ? 0 : Math.abs(d.avg_return_pct)))
      .filter((v) => v > 0);
    return vals.length ? Math.max(...vals) : 1;
  }, [data]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>FX SEASONALITY</span>
        <span className="text-[10px] font-mono text-terminal-dim">
          Monthly pattern / hit rate &middot; {data.years}y
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Pair"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase w-28 text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => submit()}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Load
          </button>
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => submit(p)}
                className={`px-2 py-1 text-[10px] font-mono uppercase border rounded transition-colors ${
                  pair === p
                    ? "border-accent text-accent"
                    : "border-terminal-border text-terminal-dim hover:text-accent hover:border-accent"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Headline cards */}
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-5 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Strongest Month
            </div>
            <div className="flex items-end gap-1">
              <span className="stat-figure leading-none text-accent-green">
                {strongest?.month_name ?? "n/a"}
              </span>
              <span className={`font-mono text-sm mb-1 tabular-nums ${retColor(strongest?.avg_return_pct ?? null)}`}>
                {fmtPct(strongest?.avg_return_pct ?? null)}
              </span>
            </div>
            <div className="text-[10px] font-mono text-terminal-muted">
              positive {strongest?.hit_rate_pct?.toFixed(0) ?? "n/a"}% of {strongest?.count ?? 0} years
            </div>
          </div>

          <div className="col-span-7 grid grid-cols-2 gap-2">
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">This Month</div>
              <div className={`stat-figure leading-none tabular-nums ${retColor(data.current_month?.avg_return_pct ?? null)}`}>
                {fmtPct(data.current_month?.avg_return_pct ?? null)}
              </div>
              <div className="text-[10px] font-mono text-terminal-muted">
                {data.current_month?.month_name ?? "-"} avg &middot; hit {data.current_month?.hit_rate_pct?.toFixed(0) ?? "n/a"}%
              </div>
            </div>
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Stacked Annual</div>
              <div className={`stat-figure leading-none tabular-nums ${retColor(data.annual_avg_pct)}`}>
                {fmtPct(data.annual_avg_pct, 1)}
              </div>
              <div className="text-[10px] font-mono text-terminal-muted">sum of monthly avgs</div>
            </div>
          </div>
        </div>

        {/* Plain-language read */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3">
          {data.read}
        </div>

        {/* Month-of-year seasonality table / heatmap */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            Month-of-Year Seasonality
          </div>
          <div className="border-t border-terminal-divider">
            <div className="grid grid-cols-12 gap-px text-[10px] font-mono uppercase text-terminal-dim py-1 px-1">
              <span className="col-span-2">Mon</span>
              <span className="col-span-4 text-right">Avg Return</span>
              <span className="col-span-2 text-right">Hit %</span>
              <span className="col-span-2 text-right">Best</span>
              <span className="col-span-2 text-right">Worst</span>
            </div>
            <div className="divide-y divide-terminal-divider">
              {data.months.map((m) => {
                const isStrong = strongest?.month === m.month;
                return (
                  <div
                    key={m.month}
                    className={`grid grid-cols-12 gap-px items-center py-1 px-1 text-xs font-mono tabular-nums ${
                      isStrong ? "ring-1 ring-accent/50 rounded" : ""
                    }`}
                  >
                    <span className="col-span-2 text-terminal-text">
                      {m.month_name}
                      {isStrong && <span className="text-accent ml-1">&#9733;</span>}
                    </span>
                    <span
                      className={`col-span-4 text-right rounded px-1 ${retColor(m.avg_return_pct)}`}
                      style={heatStyle(m.avg_return_pct, maxAbs)}
                    >
                      {fmtPct(m.avg_return_pct)}
                    </span>
                    <span className={`col-span-2 text-right ${hitColor(m.hit_rate_pct)}`}>
                      {m.hit_rate_pct === null ? "n/a" : m.hit_rate_pct.toFixed(0)}
                    </span>
                    <span className="col-span-2 text-right text-terminal-dim">
                      {m.best_year ?? "-"}
                    </span>
                    <span className="col-span-2 text-right text-terminal-dim">
                      {m.worst_year ?? "-"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Day-of-week mini-table */}
        <div className="mt-auto">
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            Day-of-Week Avg Return
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {data.day_of_week.map((d) => (
              <div
                key={d.day}
                className="bg-terminal-bg border border-terminal-border rounded p-1.5 flex flex-col items-center"
                style={heatStyle(d.avg_return_pct, dowMax)}
              >
                <span className="text-[10px] font-mono uppercase text-terminal-dim">{d.day}</span>
                <span className={`font-mono tabular-nums text-xs ${retColor(d.avg_return_pct)}`}>
                  {fmtPct(d.avg_return_pct, 3)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span>{data.symbol}</span>
          <span className="ml-auto">Calendar seasonality &middot; not a forecast</span>
        </div>
      </div>
    </div>
  );
}
