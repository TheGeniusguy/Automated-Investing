import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ── Local interfaces (mirror backend app/data/montecarlo.py output) ───────────
// The client method returns `any`; we bind it to these shapes locally so the
// panel owns its own contract without touching the shared types file.

interface MCFanPoint {
  day: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

interface MCHistBin {
  bucket: number;
  count: number;
}

interface MonteCarloResponse {
  symbol: string;
  horizon_days: number;
  sims: number;
  start_value: number;
  drift_annual_pct: number;
  vol_annual_pct: number;
  fan: MCFanPoint[];
  terminal_hist: MCHistBin[];
  var95: number | null;
  var99: number | null;
  cvar95: number | null;
  cvar99: number | null;
  prob_up_10pct: number | null;
  prob_dd_20pct: number | null;
  expected_value: number;
  data_mode: "live" | "sample" | string;
  as_of: string;
  source: string;
}

// ── Fan band styling (median emphasized, outer bands faded) ───────────────────
const CLAY = "#c9785c";
const STEEL = "110, 146, 196"; // accent.blue rgb

const FAN_BANDS: {
  key: keyof Omit<MCFanPoint, "day">;
  label: string;
  color: string;
  width: 1 | 2 | 3 | 4;
}[] = [
  { key: "p95", label: "95th", color: `rgba(${STEEL}, 0.30)`, width: 1 },
  { key: "p75", label: "75th", color: `rgba(${STEEL}, 0.60)`, width: 1 },
  { key: "p50", label: "Median", color: CLAY, width: 3 },
  { key: "p25", label: "25th", color: `rgba(${STEEL}, 0.60)`, width: 1 },
  { key: "p5", label: "5th", color: `rgba(${STEEL}, 0.30)`, width: 1 },
];

export function MonteCarloPanel() {
  const [input, setInput] = useState("SPY");
  const [data, setData] = useState<MonteCarloResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      setErr("Enter a symbol.");
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .monteCarlo(sym)
      .then((res: MonteCarloResponse) => {
        setData(res);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  // Initial load.
  useEffect(() => {
    run("SPY");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => run(input);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Monte Carlo Risk Simulation</span>
        {data && (
          <span className="text-terminal-dim normal-case tracking-normal">
            {data.symbol} &middot; {data.sims.toLocaleString()} paths &middot; {data.horizon_days}d horizon
          </span>
        )}
      </div>

      <div className="panel-body flex flex-col gap-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="SPY"
            className="flex-1 min-w-[8rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-terminal-bg disabled:opacity-40"
          >
            {loading ? "Running..." : "Simulate"}
          </button>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Running simulation...
          </div>
        )}

        {data && (
          <>
            {/* Hero cards */}
            <HeroCards data={data} />

            {/* Context row */}
            <ContextRow data={data} />

            {/* Percentile fan - the WOW element */}
            <Section title="Projected Value - Percentile Fan">
              <FanChart fan={data.fan} startValue={data.start_value} />
              <FanLegend />
            </Section>

            {/* Terminal distribution histogram */}
            <Section title="Terminal Value Distribution">
              <TerminalHistogram
                bins={data.terminal_hist}
                startValue={data.start_value}
                expectedValue={data.expected_value}
                sims={data.sims}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Hero cards ────────────────────────────────────────────────────────────────

function HeroCards({ data }: { data: MonteCarloResponse }) {
  const evGain = data.expected_value - data.start_value;
  const evColor = evGain >= 0 ? "text-accent-green" : "text-accent-red";

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
      <HeroCard
        label="Expected Value"
        figure={fmtMoney(data.expected_value)}
        figureClass="text-terminal-text"
        sub={
          <span className={evColor}>
            {evGain >= 0 ? "+" : ""}
            {fmtMoney(evGain)} ({fmtSignedPct((evGain / data.start_value) * 100)})
          </span>
        }
      />
      <HeroCard
        label="VaR 95%"
        figure={fmtLossPct(data.var95)}
        figureClass="text-accent-red"
        sub={<>CVaR {fmtLossPct(data.cvar95)}</>}
      />
      <HeroCard
        label="VaR 99%"
        figure={fmtLossPct(data.var99)}
        figureClass="text-accent-red"
        sub={<>CVaR {fmtLossPct(data.cvar99)}</>}
      />
      <HeroCard
        label="P(Up >= 10%)"
        figure={fmtPct(data.prob_up_10pct)}
        figureClass="text-accent-green"
        sub={<>terminal gain</>}
      />
      <HeroCard
        label="P(Drawdown >= 20%)"
        figure={fmtPct(data.prob_dd_20pct)}
        figureClass="text-accent-amber"
        sub={<>peak to trough</>}
      />
      <HeroCard
        label="Start Value"
        figure={fmtMoney(data.start_value)}
        figureClass="text-terminal-muted"
        sub={<>break-even line</>}
      />
    </div>
  );
}

function HeroCard({
  label,
  figure,
  figureClass,
  sub,
}: {
  label: string;
  figure: string;
  figureClass: string;
  sub: React.ReactNode;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 flex flex-col gap-1">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`stat-figure text-2xl leading-none ${figureClass}`}>{figure}</div>
      <div className="text-2xs text-terminal-muted tabular-nums">{sub}</div>
    </div>
  );
}

// ── Context row ───────────────────────────────────────────────────────────────

function ContextRow({ data }: { data: MonteCarloResponse }) {
  const driftColor = data.drift_annual_pct >= 0 ? "text-accent-green" : "text-accent-red";
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-x-6 gap-y-1 flex-wrap text-xs">
      <Context label="Drift (annual)">
        <span className={`tabular-nums ${driftColor}`}>{fmtSignedPct(data.drift_annual_pct)}</span>
      </Context>
      <Context label="Volatility (annual)">
        <span className="tabular-nums text-terminal-text">{fmtPct(data.vol_annual_pct)}</span>
      </Context>
      <Context label="Horizon">
        <span className="tabular-nums text-terminal-text">{data.horizon_days} trading days</span>
      </Context>
      <Context label="Paths">
        <span className="tabular-nums text-terminal-text">{data.sims.toLocaleString()}</span>
      </Context>
    </div>
  );
}

function Context({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</span>
      {children}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

// ── Percentile fan chart (TradingView Lightweight Charts) ─────────────────────

function FanChart({ fan, startValue }: { fan: MCFanPoint[]; startValue: number }) {
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
      height: 320,
      layout: { background: { color: "transparent" }, textColor: "#6e665a" },
      grid: {
        vertLines: { color: "#2e2a24" },
        horzLines: { color: "#2e2a24" },
      },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    // Map each forecast day to a forward calendar timestamp (day 0 = today) so
    // the time axis reads as a real projection window.
    const baseSec = Math.floor(Date.now() / 1000);
    const timeFor = (day: number) => (baseSec + day * 86400) as UTCTimestamp;

    FAN_BANDS.forEach((band) => {
      const line = chart.addSeries(LineSeries, {
        color: band.color,
        lineWidth: band.width,
        title: band.label,
        priceLineVisible: false,
        lastValueVisible: band.key === "p50",
        crosshairMarkerVisible: band.key === "p50",
      });
      line.setData(
        fan.map((pt) => ({ time: timeFor(pt.day), value: pt[band.key] })),
      );
      // Break-even reference drawn once, on the median series.
      if (band.key === "p50") {
        line.createPriceLine({
          price: startValue,
          color: "#6e665a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Start",
        });
      }
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
  }, [fan, startValue]);

  return <div ref={ref} />;
}

function FanLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
      {FAN_BANDS.map((band) => (
        <div key={band.key} className="flex items-center gap-1.5 text-2xs text-terminal-dim">
          <span
            className="inline-block rounded"
            style={{
              width: "1rem",
              height: band.key === "p50" ? "3px" : "2px",
              backgroundColor: band.color,
            }}
          />
          {band.label} percentile
        </div>
      ))}
    </div>
  );
}

// ── Terminal distribution histogram ───────────────────────────────────────────

function TerminalHistogram({
  bins,
  startValue,
  expectedValue,
  sims,
}: {
  bins: MCHistBin[];
  startValue: number;
  expectedValue: number;
  sims: number;
}) {
  const { maxCount, lo, hi } = useMemo(() => {
    let mc = 0;
    bins.forEach((b) => {
      if (b.count > mc) mc = b.count;
    });
    const buckets = bins.map((b) => b.bucket);
    return {
      maxCount: mc || 1,
      lo: buckets.length ? Math.min(...buckets) : 0,
      hi: buckets.length ? Math.max(...buckets) : 0,
    };
  }, [bins]);

  if (bins.length === 0) {
    return <div className="text-2xs text-terminal-dim">No distribution data.</div>;
  }

  const span = hi - lo;
  const posOf = (v: number) => (span > 0 ? ((v - lo) / span) * 100 : 50);
  const startPos = clamp(posOf(startValue), 0, 100);
  const evPos = clamp(posOf(expectedValue), 0, 100);

  return (
    <div>
      <div className="relative" style={{ height: "180px" }}>
        {/* Break-even marker */}
        <Marker pos={startPos} color="#6e665a" label="Start" />
        {/* Expected value marker */}
        <Marker pos={evPos} color="#c9785c" label="E[V]" align="right" />

        {/* Bars */}
        <div className="absolute inset-0 flex items-end gap-px">
          {bins.map((b, i) => {
            const h = (b.count / maxCount) * 100;
            const up = b.bucket >= startValue;
            const prob = sims > 0 ? (b.count / sims) * 100 : 0;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-sm"
                style={{
                  height: `${h}%`,
                  minHeight: b.count > 0 ? "1px" : "0",
                  backgroundColor: up
                    ? "rgba(91, 185, 127, 0.65)"
                    : "rgba(229, 86, 75, 0.65)",
                }}
                title={`${fmtMoney(b.bucket)}  ${b.count} paths (${prob.toFixed(1)}%)`}
              />
            );
          })}
        </div>
      </div>

      {/* Axis */}
      <div className="flex justify-between mt-1 text-2xs text-terminal-dim tabular-nums">
        <span>{fmtMoney(lo)}</span>
        <span>{fmtMoney((lo + hi) / 2)}</span>
        <span>{fmtMoney(hi)}</span>
      </div>
    </div>
  );
}

function Marker({
  pos,
  color,
  label,
  align = "left",
}: {
  pos: number;
  color: string;
  label: string;
  align?: "left" | "right";
}) {
  return (
    <div
      className="absolute top-0 bottom-0 z-10 pointer-events-none"
      style={{ left: `${pos}%`, borderLeft: `1px dashed ${color}` }}
    >
      <span
        className="absolute top-0 text-2xs px-1 whitespace-nowrap"
        style={{
          color,
          [align === "left" ? "left" : "right"]: align === "left" ? "2px" : "auto",
          ...(align === "right" ? { right: "calc(100% + 2px)" } : {}),
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(1)}%`;
}

function fmtSignedPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// VaR / CVaR arrive as positive loss magnitudes; render as a negative figure.
function fmtLossPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `-${Math.abs(v).toFixed(2)}%`;
}
