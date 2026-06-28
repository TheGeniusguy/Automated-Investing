import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { AdvancedAnalyticsResponse, MetricCatalogItem } from "../api/types";

// ── Day windows ───────────────────────────────────────────────────────────────
const DAY_RANGES: { label: string; days: number }[] = [
  { label: "1Y", days: 252 },
  { label: "2Y", days: 504 },
  { label: "3Y", days: 756 },
  { label: "5Y", days: 1260 },
];

// ── Metric -> category grouping + display rules ───────────────────────────────
// Keys mirror the backend `metrics` block. Each row knows its category, label,
// formatter, a short formula caption, and whether to color by sign.
type MetricKey = keyof AdvancedAnalyticsResponse["metrics"];

type FmtKind = "ratio" | "pct" | "num" | "days";

interface MetricSpec {
  key: MetricKey;
  label: string;
  formula: string;
  fmt: FmtKind;
  signColor?: boolean; // color green/red by sign
}

type Category =
  | "Return"
  | "Risk-Adjusted"
  | "Drawdown"
  | "Distribution"
  | "Capture";

const GROUPS: { category: Category; metrics: MetricSpec[] }[] = [
  {
    category: "Return",
    metrics: [
      { key: "cagr", label: "CAGR", formula: "(end / start) ^ (252 / n) - 1", fmt: "pct", signColor: true },
      { key: "ann_vol", label: "Ann. Volatility", formula: "std(daily) * sqrt(252)", fmt: "pct" },
      { key: "kelly_fraction", label: "Kelly Fraction", formula: "mean(r) / var(r)", fmt: "ratio" },
    ],
  },
  {
    category: "Risk-Adjusted",
    metrics: [
      { key: "information_ratio", label: "Information Ratio", formula: "mean(active) / std(active) * sqrt(252)", fmt: "ratio" },
      { key: "treynor_ratio", label: "Treynor Ratio", formula: "(ann_ret - rf) / beta", fmt: "ratio" },
      { key: "omega_ratio", label: "Omega Ratio", formula: "sum(gains) / sum(losses), threshold 0", fmt: "ratio" },
      { key: "martin_ratio", label: "Martin Ratio", formula: "CAGR / ulcer index", fmt: "ratio" },
      { key: "gain_to_pain", label: "Gain to Pain", formula: "sum(r) / sum(|losses|)", fmt: "ratio" },
      { key: "common_sense_ratio", label: "Common Sense Ratio", formula: "tail ratio * gain-to-pain", fmt: "ratio" },
    ],
  },
  {
    category: "Drawdown",
    metrics: [
      { key: "max_drawdown", label: "Max Drawdown", formula: "min(equity / cummax - 1)", fmt: "pct", signColor: true },
      { key: "ulcer_index", label: "Ulcer Index", formula: "sqrt(mean(drawdown^2))", fmt: "ratio" },
      { key: "max_drawdown_duration_days", label: "Max DD Duration", formula: "longest peak-to-peak gap", fmt: "days" },
      { key: "recovery_days", label: "Recovery Days", formula: "trough back to prior peak", fmt: "days" },
    ],
  },
  {
    category: "Distribution",
    metrics: [
      { key: "skew", label: "Skew", formula: "E[(r - mean)^3] / std^3", fmt: "ratio", signColor: true },
      { key: "kurtosis", label: "Excess Kurtosis", formula: "E[(r - mean)^4] / std^4 - 3", fmt: "ratio" },
      { key: "downside_deviation", label: "Downside Deviation", formula: "sqrt(mean(min(r, 0)^2)) * sqrt(252)", fmt: "pct" },
      { key: "tail_ratio", label: "Tail Ratio", formula: "p95 / |p5|", fmt: "ratio" },
    ],
  },
  {
    category: "Capture",
    metrics: [
      { key: "upside_capture", label: "Upside Capture", formula: "up-market return / benchmark up return", fmt: "pct", signColor: true },
      { key: "downside_capture", label: "Downside Capture", formula: "down-market return / benchmark down return", fmt: "pct", signColor: true },
    ],
  },
];

const CATALOG_ORDER: string[] = ["Return", "Risk-Adjusted", "Drawdown", "Distribution", "Capture"];

// ── Component ─────────────────────────────────────────────────────────────────

export function AdvancedAnalyticsPanel() {
  const [symbolInput, setSymbolInput] = useState("SPY");
  const [benchInput, setBenchInput] = useState("SPY");
  const [symbol, setSymbol] = useState("SPY");
  const [benchmark, setBenchmark] = useState("SPY");
  const [days, setDays] = useState(756);

  const [data, setData] = useState<AdvancedAnalyticsResponse | null>(null);
  const [catalog, setCatalog] = useState<MetricCatalogItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch analytics on symbol/benchmark/days change, with an alive-guard so a
  // stale in-flight request can never overwrite a newer one.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .advancedAnalytics(symbol, benchmark, days)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol, benchmark, days]);

  // Catalog is static; fetch once.
  useEffect(() => {
    let alive = true;
    api
      .analyticsCatalog()
      .then((res) => {
        if (alive) setCatalog(res.metrics);
      })
      .catch(() => {
        /* catalog is supplementary; ignore its failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  const submitSymbols = () => {
    const s = symbolInput.trim().toUpperCase();
    const b = benchInput.trim().toUpperCase();
    if (!s) {
      setErr("Enter a symbol.");
      return;
    }
    setSymbol(s);
    setBenchmark(b || "SPY");
  };

  const catalogByCategory = useMemo(() => {
    const m = new Map<string, MetricCatalogItem[]>();
    (catalog ?? []).forEach((item) => {
      const arr = m.get(item.category) ?? [];
      arr.push(item);
      m.set(item.category, arr);
    });
    // Stable category order: known order first, then any extras.
    const ordered: { category: string; items: MetricCatalogItem[] }[] = [];
    CATALOG_ORDER.forEach((c) => {
      if (m.has(c)) ordered.push({ category: c, items: m.get(c)! });
    });
    [...m.keys()]
      .filter((c) => !CATALOG_ORDER.includes(c))
      .forEach((c) => ordered.push({ category: c, items: m.get(c)! }));
    return ordered;
  }, [catalog]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Advanced Analytics</span>
        {data && (
          <span className="text-terminal-dim normal-case tracking-normal">
            {data.symbol} vs {data.benchmark} / {data.days}d
          </span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5">
              <span className="text-2xs text-terminal-dim uppercase">Symbol</span>
              <input
                type="text"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSymbols();
                }}
                placeholder="SPY"
                className="w-24 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-2xs text-terminal-dim uppercase">Benchmark</span>
              <input
                type="text"
                value={benchInput}
                onChange={(e) => setBenchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSymbols();
                }}
                placeholder="SPY"
                className="w-24 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={submitSymbols}
              disabled={loading}
              className="pill bg-accent text-black disabled:opacity-40"
            >
              {loading ? "Loading..." : "Run"}
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-terminal-dim uppercase mr-1">Window</span>
            {DAY_RANGES.map(({ label, days: d }) => (
              <button
                key={label}
                type="button"
                onClick={() => setDays(d)}
                className={`pill ${
                  days === d ? "bg-accent text-black" : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">Computing analytics...</div>
        )}

        {data && (
          <>
            {/* Metric grid, grouped by category */}
            {GROUPS.map((group) => (
              <div
                key={group.category}
                className="bg-terminal-bg border border-terminal-border/50 rounded p-2"
              >
                <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                  {group.category}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {group.metrics.map((spec) => (
                    <MetricCell
                      key={String(spec.key)}
                      spec={spec}
                      value={data.metrics[spec.key] as number | null}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Rolling Sharpe chart */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Rolling Sharpe (63-day window)
              </div>
              <RollingSharpeChart values={data.rolling_sharpe} />
            </div>

            {/* Catalog */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                What this terminal computes
              </div>
              {catalogByCategory.length === 0 ? (
                <div className="text-2xs text-terminal-dim">Catalog unavailable.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {catalogByCategory.map(({ category, items }) => (
                    <div key={category}>
                      <div className="text-2xs text-accent-amber uppercase tracking-wide mb-1">
                        {category}
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-1.5">
                        {items.map((item) => (
                          <div
                            key={item.key}
                            className="flex flex-col border-l border-terminal-border/40 pl-2"
                          >
                            <span className="text-xs text-terminal-text">{item.name}</span>
                            <span className="text-2xs text-terminal-dim font-mono">
                              {item.formula}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Metric cell ───────────────────────────────────────────────────────────────

function MetricCell({ spec, value }: { spec: MetricSpec; value: number | null }) {
  const color = spec.signColor ? colorBySign(value) : "text-terminal-text";
  return (
    <div className="bg-terminal-panel border border-terminal-border/30 rounded p-2" title={spec.formula}>
      <div className="text-2xs text-terminal-dim uppercase leading-tight">{spec.label}</div>
      <div className={`stat-figure text-2xl mt-0.5 ${color}`}>{fmtValue(value, spec.fmt)}</div>
      <div className="text-2xs text-terminal-dim font-mono truncate mt-0.5">{spec.formula}</div>
    </div>
  );
}

// ── Rolling Sharpe chart ──────────────────────────────────────────────────────

function RollingSharpeChart({ values }: { values: number[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const clean = (values ?? []).filter((v) => v != null && !Number.isNaN(v));
    if (clean.length === 0) return;

    const chart: IChartApi = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 220,
      layout: { background: { color: "transparent" }, textColor: "#a39a8c" },
      grid: { vertLines: { color: "#2e2a24" }, horzLines: { color: "#2e2a24" } },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
      crosshair: { mode: 0 },
    });

    const line = chart.addSeries(LineSeries, {
      color: "#c9785c",
      lineWidth: 2,
      title: "Sharpe",
    });
    // Synthetic daily index back from today; the series is a rolling window so
    // the x-axis just needs to be monotonic and evenly spaced.
    const todayUtc = Math.floor(Date.now() / 1000);
    const dayStep = 86400;
    const start = todayUtc - (clean.length - 1) * dayStep;
    line.setData(
      clean.map((v, i) => ({
        time: (start + i * dayStep) as UTCTimestamp,
        value: v,
      })),
    );

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [values]);

  const hasData = (values ?? []).some((v) => v != null && !Number.isNaN(v));
  if (!hasData) {
    return <div className="text-2xs text-terminal-dim py-6 text-center">No rolling Sharpe data.</div>;
  }
  return <div ref={ref} />;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorBySign(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtValue(v: number | null, kind: FmtKind): string {
  if (v == null || Number.isNaN(v)) return "--";
  switch (kind) {
    case "pct":
      return `${(v * 100).toFixed(2)}%`;
    case "days":
      return `${Math.round(v)}`;
    case "ratio":
    case "num":
    default:
      return v.toFixed(2);
  }
}
