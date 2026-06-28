import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ── Local mirror of the backend short_interest payload ────────────────────────
// Kept local on purpose: this panel owns its own shape and does not depend on the
// shared types module being wired first.

interface ShortInterestHistoryPoint {
  date: string;
  si_pct: number;
  dtc: number;
}

interface ShortInterestResponse {
  symbol: string;
  si_pct_float: number;
  days_to_cover: number;
  borrow_fee_pct: number;
  shares_short: number;
  float_shares: number;
  squeeze_score: number;
  squeeze_label: string;
  history: ShortInterestHistoryPoint[];
  data_mode: string;
  as_of: string;
  source: string;
}

// Consume api.shortInterest(symbol) when the client exposes it; otherwise hit the
// route directly so the panel stays self-sufficient and type-checks standalone.
type ShortInterestFetcher = (symbol: string) => Promise<ShortInterestResponse>;

const apiWithSI = api as unknown as { shortInterest?: ShortInterestFetcher };

const fetchShortInterest: ShortInterestFetcher = (symbol) =>
  apiWithSI.shortInterest
    ? apiWithSI.shortInterest(symbol)
    : fetch(`/api/short-interest/${encodeURIComponent(symbol)}`).then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<ShortInterestResponse>;
      });

// Squeeze color bands: calm sage at the low end, clay then vivid red at the top.
const GAUGE_GREEN = "#5bb97f";
const GAUGE_BLUE = "#6e92c4";
const GAUGE_AMBER = "#d99a4e";
const GAUGE_CLAY = "#c9785c";
const GAUGE_RED = "#e5564b";

function scoreColor(score: number): string {
  if (score >= 80) return GAUGE_RED;
  if (score >= 60) return GAUGE_CLAY;
  if (score >= 40) return GAUGE_AMBER;
  if (score >= 20) return GAUGE_BLUE;
  return GAUGE_GREEN;
}

export function ShortInterestPanel() {
  const [input, setInput] = useState("GME");
  const [data, setData] = useState<ShortInterestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = (symbol: string) => {
    const clean = symbol.trim().toUpperCase();
    if (!clean) {
      setErr("Enter a symbol.");
      return;
    }
    setLoading(true);
    setErr(null);
    fetchShortInterest(clean)
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
    load("GME");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => load(input);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Short Interest &amp; Squeeze</span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="GME"
            className="flex-1 min-w-[10rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text font-mono uppercase focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-black disabled:opacity-40"
          >
            {loading ? "Loading..." : "Load"}
          </button>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading short interest...
          </div>
        )}

        {data && (
          <>
            {/* Squeeze score gauge */}
            <Section title="Squeeze Score">
              <SqueezeGauge
                score={data.squeeze_score}
                label={data.squeeze_label}
                symbol={data.symbol}
              />
            </Section>

            {/* Metric cards */}
            <Section title="Short Interest Metrics">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
                <MetricCard
                  label="SI % of Float"
                  value={`${data.si_pct_float.toFixed(2)}%`}
                  accent={siFloatColor(data.si_pct_float)}
                />
                <MetricCard
                  label="Days to Cover"
                  value={data.days_to_cover.toFixed(2)}
                  accent={dtcColor(data.days_to_cover)}
                />
                <MetricCard
                  label="Borrow Fee"
                  value={`${data.borrow_fee_pct.toFixed(2)}%`}
                  accent={borrowColor(data.borrow_fee_pct)}
                />
                <MetricCard label="Shares Short" value={fmtShares(data.shares_short)} />
                <MetricCard label="Float" value={fmtShares(data.float_shares)} />
              </div>
            </Section>

            {/* History chart */}
            <Section title="Short Interest History">
              <SIHistoryChart history={data.history} />
              <div className="flex flex-wrap gap-4 mt-2 px-1">
                <LegendDot color={GAUGE_CLAY} label="SI % of float" />
                <LegendDot color={GAUGE_BLUE} label="Days to cover" />
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Squeeze gauge (semicircular arc) ──────────────────────────────────────────

function SqueezeGauge({
  score,
  label,
  symbol,
}: {
  score: number;
  label: string;
  symbol: string;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = scoreColor(clamped);

  // Semicircle arc geometry: center (100,100), radius 90, sweeping left to right.
  const arcPath = "M 10 100 A 90 90 0 0 1 190 100";
  const arcLen = Math.PI * 90; // length of the semicircle stroke
  const offset = arcLen * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full max-w-[18rem]">
        <svg viewBox="0 0 200 116" className="w-full">
          {/* Track */}
          <path
            d={arcPath}
            fill="none"
            stroke="#2e2a24"
            strokeWidth={14}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <path
            d={arcPath}
            fill="none"
            stroke={color}
            strokeWidth={14}
            strokeLinecap="round"
            strokeDasharray={arcLen}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
          />
          {/* Endpoint labels */}
          <text x="10" y="114" fill="#6e665a" fontSize="9" textAnchor="middle">
            0
          </text>
          <text x="190" y="114" fill="#6e665a" fontSize="9" textAnchor="middle">
            100
          </text>
        </svg>

        {/* Hero number overlaid in the arc well. */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pb-1">
          <span
            className="stat-figure text-5xl leading-none"
            style={{ color }}
          >
            {clamped}
          </span>
          <span
            className="text-xs uppercase tracking-[0.18em] font-semibold mt-1"
            style={{ color }}
          >
            {label}
          </span>
        </div>
      </div>
      <div className="text-2xs text-terminal-dim uppercase tracking-wider mt-1">
        {symbol} squeeze pressure
      </div>
    </div>
  );
}

// ── History chart ─────────────────────────────────────────────────────────────

function SIHistoryChart({ history }: { history: ShortInterestHistoryPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const rows = useMemo(
    () =>
      (history ?? [])
        .map((h) => ({
          time: Math.floor(new Date(h.date).getTime() / 1000) as UTCTimestamp,
          si: h.si_pct,
          dtc: h.dtc,
        }))
        .filter((r) => Number.isFinite(r.time)),
    [history],
  );

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 240,
      layout: { background: { color: "transparent" }, textColor: "#a39a8c" },
      grid: {
        vertLines: { color: "#2e2a24" },
        horzLines: { color: "#2e2a24" },
      },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
      leftPriceScale: { visible: true, borderColor: "#3a352d" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    if (rows.length) {
      const siLine = chart.addSeries(LineSeries, {
        color: GAUGE_CLAY,
        lineWidth: 2,
        priceScaleId: "right",
        title: "SI %",
      });
      siLine.setData(rows.map((r) => ({ time: r.time, value: r.si })));

      const dtcLine = chart.addSeries(LineSeries, {
        color: GAUGE_BLUE,
        lineWidth: 2,
        priceScaleId: "left",
        title: "DTC",
      });
      dtcLine.setData(rows.map((r) => ({ time: r.time, value: r.dtc })));

      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [rows]);

  if (!rows.length) {
    return <div className="text-2xs text-terminal-dim py-4">No history available.</div>;
  }

  return <div ref={ref} />;
}

// ── Small components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        {title.replace("&amp;", "&")}
      </div>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="bg-terminal-panel border border-terminal-border/40 rounded p-2 flex flex-col gap-1">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</span>
      <span
        className="stat-figure text-xl text-terminal-text"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span
        className="w-4 h-0.5 rounded inline-block"
        style={{ backgroundColor: color }}
      />
      {label}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtShares(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "--";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString();
}

function siFloatColor(v: number): string {
  if (v >= 25) return GAUGE_RED;
  if (v >= 12) return GAUGE_AMBER;
  return "#ece7df";
}

function dtcColor(v: number): string {
  if (v >= 7) return GAUGE_RED;
  if (v >= 4) return GAUGE_AMBER;
  return "#ece7df";
}

function borrowColor(v: number): string {
  if (v >= 40) return GAUGE_RED;
  if (v >= 15) return GAUGE_AMBER;
  return "#ece7df";
}
