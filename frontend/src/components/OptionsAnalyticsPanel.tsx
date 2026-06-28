import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ── Response shapes (mirror options_greeks backend module) ────────────────────
// Local interfaces so this panel type-checks independently of the wiring agent.
interface SurfaceExpiry {
  label: string;
  days: number;
  T: number;
}
interface SurfaceTermPoint {
  label: string;
  days: number;
  atm_iv: number;
}
interface SurfaceSkewPoint {
  label: string;
  days: number;
  put_25d_iv: number;
  call_25d_iv: number;
  skew_25d: number;
}
interface OptionsSurface {
  symbol: string;
  spot: number;
  r: number;
  strikes: number[];
  expiries: SurfaceExpiry[];
  iv_grid: number[][]; // rows = strikes x cols = expiries, IV in percent
  term_structure: SurfaceTermPoint[];
  skew: SurfaceSkewPoint[];
}

interface GexLevel {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  cumulative_gex: number;
}
interface OptionsGex {
  symbol: string;
  spot: number;
  levels: GexLevel[];
  total_gex: number;
  zero_gamma: number;
  gex_unit: string;
}

interface PayoutPoint {
  strike: number;
  payout: number;
}
interface OptionsMaxPain {
  symbol: string;
  spot: number;
  max_pain: number;
  max_pain_distance_pct: number;
  payout_curve: PayoutPoint[];
  pc_ratio_oi: number;
}

interface GreekLeg {
  iv: number;
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  oi: number;
}
interface GreekRow {
  strike: number;
  moneyness: number;
  call: GreekLeg;
  put: GreekLeg;
}
interface OptionsGreeks {
  symbol: string;
  spot: number;
  expiry: string;
  days_to_expiry: number;
  rows: GreekRow[];
}

// The wiring agent adds these methods to api/client.ts. Until then tsc may flag
// the calls; the shapes above are the contract.
type OptionsApi = {
  optionsSurface: (symbol: string) => Promise<OptionsSurface>;
  optionsGex: (symbol: string) => Promise<OptionsGex>;
  optionsMaxPain: (symbol: string) => Promise<OptionsMaxPain>;
  optionsGreeks: (symbol: string) => Promise<OptionsGreeks>;
};
const optionsApi = api as unknown as OptionsApi;

const CLAY = { r: 201, g: 120, b: 92 }; // accent-amber / clay
const GREEN = "#5bb97f";
const RED = "#e5564b";

export function OptionsAnalyticsPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [surface, setSurface] = useState<OptionsSurface | null>(null);
  const [gex, setGex] = useState<OptionsGex | null>(null);
  const [maxPain, setMaxPain] = useState<OptionsMaxPain | null>(null);
  const [greeks, setGreeks] = useState<OptionsGreeks | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = (sym: string) => {
    const clean = sym.trim().toUpperCase();
    if (!clean) {
      setErr("Enter a symbol.");
      return;
    }
    setLoading(true);
    setErr(null);
    setSymbol(clean);
    Promise.allSettled([
      optionsApi.optionsSurface(clean),
      optionsApi.optionsGex(clean),
      optionsApi.optionsMaxPain(clean),
      optionsApi.optionsGreeks(clean),
    ])
      .then(([s, g, mp, gk]) => {
        setSurface(s.status === "fulfilled" ? s.value : null);
        setGex(g.status === "fulfilled" ? g.value : null);
        setMaxPain(mp.status === "fulfilled" ? mp.value : null);
        setGreeks(gk.status === "fulfilled" ? gk.value : null);
        const allFailed = [s, g, mp, gk].every((r) => r.status === "rejected");
        if (allFailed) {
          const first = [s, g, mp, gk].find((r) => r.status === "rejected") as
            | PromiseRejectedResult
            | undefined;
          setErr(first ? String(first.reason) : "Failed to load options analytics.");
        }
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    load("AAPL");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => load(input);

  // Hero figures preferring whichever payload is present.
  const spot = surface?.spot ?? gex?.spot ?? maxPain?.spot ?? greeks?.spot ?? null;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">
          Options Analytics
        </span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching..." : symbol}
        </span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls + hero stats */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="AAPL"
              className="w-40 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text uppercase focus:outline-none focus:border-accent"
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

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Hero label="Spot" value={spot != null ? `$${spot.toFixed(2)}` : "--"} />
            <Hero
              label="Max Pain"
              value={maxPain ? `$${maxPain.max_pain.toFixed(2)}` : "--"}
              sub={
                maxPain
                  ? `${maxPain.max_pain_distance_pct >= 0 ? "+" : ""}${maxPain.max_pain_distance_pct.toFixed(2)}% vs spot`
                  : undefined
              }
            />
            <Hero
              label="Zero Gamma"
              value={gex ? `$${gex.zero_gamma.toFixed(2)}` : "--"}
              sub={gex ? gammaRegime(gex.zero_gamma, gex.spot) : undefined}
            />
            <Hero
              label="Total GEX"
              value={gex ? fmtGex(gex.total_gex) : "--"}
              sub={gex?.gex_unit}
              accent={gex ? (gex.total_gex >= 0 ? GREEN : RED) : undefined}
            />
          </div>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !surface && !gex && !maxPain && !greeks && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading options analytics...
          </div>
        )}

        {/* (a) Volatility surface */}
        {surface && (
          <Section title="Volatility Surface">
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
              <div className="xl:col-span-2 min-w-0">
                <VolSurfaceHeatmap surface={surface} />
              </div>
              <div className="flex flex-col gap-3 min-w-0">
                <TermStructureTable points={surface.term_structure} />
                <SkewTable points={surface.skew} />
              </div>
            </div>
          </Section>
        )}

        {/* (b) Gamma exposure */}
        {gex && (
          <Section title="Dealer Gamma Exposure (GEX)">
            <GexChart gex={gex} />
          </Section>
        )}

        {/* (c) Max pain */}
        {maxPain && (
          <Section title="Max Pain">
            <div className="flex items-center gap-4 mb-2 flex-wrap">
              <div className="text-2xs text-terminal-dim uppercase">
                P/C Ratio (OI):{" "}
                <span
                  className={`tabular-nums font-semibold ${
                    maxPain.pc_ratio_oi > 1.1
                      ? "text-accent-red"
                      : maxPain.pc_ratio_oi < 0.9
                        ? "text-accent-green"
                        : "text-terminal-text"
                  }`}
                >
                  {maxPain.pc_ratio_oi.toFixed(2)}
                </span>
              </div>
              <div className="text-2xs text-terminal-dim uppercase">
                Max Pain:{" "}
                <span className="text-accent-amber tabular-nums font-semibold">
                  ${maxPain.max_pain.toFixed(2)}
                </span>
              </div>
            </div>
            <MaxPainChart maxPain={maxPain} />
          </Section>
        )}

        {/* (d) Greeks ladder */}
        {greeks && (
          <Section
            title={`Greeks Ladder ${greeks.expiry ? "- " + greeks.expiry : ""} (${greeks.days_to_expiry}d)`}
          >
            <GreeksLadder greeks={greeks} />
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Hero stat ─────────────────────────────────────────────────────────────────

function Hero({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-terminal-panel border border-terminal-border/40 rounded px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div
        className="stat-figure text-2xl leading-tight mt-0.5"
        style={{ color: accent ?? "#ece7df" }}
      >
        {value}
      </div>
      {sub && <div className="text-2xs text-terminal-muted tabular-nums mt-0.5">{sub}</div>}
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

// ── (a) Vol surface heatmap ───────────────────────────────────────────────────

function VolSurfaceHeatmap({ surface }: { surface: OptionsSurface }) {
  const { strikes, expiries, iv_grid, spot } = surface;

  const { lo, hi } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const row of iv_grid) {
      for (const v of row) {
        if (v == null || Number.isNaN(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!Number.isFinite(mn)) {
      mn = 0;
      mx = 1;
    }
    return { lo: mn, hi: mx };
  }, [iv_grid]);

  // Strike row nearest spot, for highlighting the ATM band.
  const atmRow = useMemo(() => {
    let best = -1;
    let bestD = Infinity;
    strikes.forEach((k, i) => {
      const d = Math.abs(k - spot);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }, [strikes, spot]);

  if (!strikes.length || !expiries.length) {
    return <div className="text-2xs text-terminal-dim">No surface data.</div>;
  }

  return (
    <div className="overflow-auto">
      <div
        className="inline-grid text-2xs"
        style={{
          gridTemplateColumns: `3.4rem repeat(${expiries.length}, minmax(2.6rem, 1fr))`,
        }}
      >
        {/* Header row */}
        <div className="sticky left-0 z-10 bg-terminal-bg text-terminal-dim text-center pb-1 flex items-end justify-center">
          IV %
        </div>
        {expiries.map((e) => (
          <div key={e.label} className="text-terminal-muted text-center pb-1" title={`${e.days}d`}>
            {e.label}
          </div>
        ))}

        {/* Strike rows (high strike at top) */}
        {strikes
          .map((k, i) => ({ k, i }))
          .slice()
          .sort((a, b) => b.k - a.k)
          .map(({ k, i }) => (
            <div key={k} className="contents">
              <div
                className={`sticky left-0 z-10 bg-terminal-bg pr-1 text-right tabular-nums flex items-center justify-end ${
                  i === atmRow ? "text-accent-amber font-semibold" : "text-terminal-muted"
                }`}
              >
                {k.toFixed(k < 25 ? 1 : 0)}
              </div>
              {expiries.map((_, j) => {
                const v = iv_grid[i]?.[j];
                return (
                  <div
                    key={j}
                    title={`K ${k.toFixed(2)} / ${expiries[j].label}: ${v == null ? "n/a" : v.toFixed(1) + "%"}`}
                    className={`h-6 flex items-center justify-center tabular-nums border border-terminal-bg ${
                      i === atmRow ? "ring-1 ring-inset ring-accent-amber/40" : ""
                    }`}
                    style={{
                      background: clayColor(v, lo, hi),
                      color: cellText(v, lo, hi),
                    }}
                  >
                    {v == null || Number.isNaN(v) ? "" : v.toFixed(0)}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
      <div className="flex items-center gap-2 mt-2 text-2xs text-terminal-dim">
        <span>Low IV</span>
        <span className="inline-block h-2 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${clayColor(lo, lo, hi)}, ${clayColor(hi, lo, hi)})` }} />
        <span>High IV</span>
        <span className="ml-2">
          {lo.toFixed(1)}% - {hi.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ── Term structure + skew tables (with sparklines) ────────────────────────────

function TermStructureTable({ points }: { points: SurfaceTermPoint[] }) {
  const vals = points.map((p) => p.atm_iv);
  return (
    <div className="bg-terminal-panel border border-terminal-border/40 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs text-terminal-dim uppercase tracking-wider">Term Structure (ATM IV)</span>
        <Sparkline values={vals} color="#c9785c" />
      </div>
      <table className="w-full text-2xs tabular-nums">
        <thead>
          <tr className="text-terminal-dim uppercase">
            <th className="text-left py-0.5">Expiry</th>
            <th className="text-right py-0.5">Days</th>
            <th className="text-right py-0.5">ATM IV</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label} className="border-t border-terminal-border/20">
              <td className="py-0.5 text-terminal-muted">{p.label}</td>
              <td className="py-0.5 text-right text-terminal-dim">{p.days}</td>
              <td className="py-0.5 text-right text-accent-amber">{p.atm_iv.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkewTable({ points }: { points: SurfaceSkewPoint[] }) {
  const vals = points.map((p) => p.skew_25d);
  return (
    <div className="bg-terminal-panel border border-terminal-border/40 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs text-terminal-dim uppercase tracking-wider">25d Skew (Put - Call)</span>
        <Sparkline values={vals} color="#6e92c4" />
      </div>
      <table className="w-full text-2xs tabular-nums">
        <thead>
          <tr className="text-terminal-dim uppercase">
            <th className="text-left py-0.5">Expiry</th>
            <th className="text-right py-0.5">25dP</th>
            <th className="text-right py-0.5">25dC</th>
            <th className="text-right py-0.5">Skew</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label} className="border-t border-terminal-border/20">
              <td className="py-0.5 text-terminal-muted">{p.label}</td>
              <td className="py-0.5 text-right text-terminal-text">{p.put_25d_iv.toFixed(1)}</td>
              <td className="py-0.5 text-right text-terminal-text">{p.call_25d_iv.toFixed(1)}</td>
              <td
                className={`py-0.5 text-right font-semibold ${
                  p.skew_25d >= 0 ? "text-accent-red" : "text-accent-green"
                }`}
              >
                {p.skew_25d >= 0 ? "+" : ""}
                {p.skew_25d.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 80;
  const h = 20;
  if (values.length < 2) return <span className="inline-block" style={{ width: w, height: h }} />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - lo) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

// ── (b) GEX diverging bar chart ───────────────────────────────────────────────

const GEX_ROW_H = 18;

function GexChart({ gex }: { gex: OptionsGex }) {
  // Display strikes high-to-low (price axis convention).
  const rows = useMemo(
    () => gex.levels.slice().sort((a, b) => b.strike - a.strike),
    [gex.levels],
  );
  const maxAbs = useMemo(
    () => Math.max(1e-9, ...rows.map((r) => Math.abs(r.net_gex))),
    [rows],
  );
  const strikesDesc = useMemo(() => rows.map((r) => r.strike), [rows]);

  const zeroGammaTop = interpTop(strikesDesc, gex.zero_gamma);
  const spotTop = interpTop(strikesDesc, gex.spot);

  if (!rows.length) return <div className="text-2xs text-terminal-dim">No GEX data.</div>;

  return (
    <div className="flex gap-3">
      {/* Bars */}
      <div className="relative flex-1 min-w-0" style={{ height: rows.length * GEX_ROW_H }}>
        {/* center zero axis */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-terminal-divider" />

        {/* zero-gamma flip line */}
        {zeroGammaTop != null && (
          <Marker top={zeroGammaTop} color="#c9785c" label={`Zero Gamma ${gex.zero_gamma.toFixed(2)}`} dashed />
        )}
        {/* spot marker */}
        {spotTop != null && (
          <Marker top={spotTop} color="#ece7df" label={`Spot ${gex.spot.toFixed(2)}`} align="right" />
        )}

        {rows.map((r, idx) => {
          const pct = (Math.abs(r.net_gex) / maxAbs) * 50; // half-width max
          const pos = r.net_gex >= 0;
          return (
            <div
              key={r.strike}
              className="absolute left-0 right-0 flex items-center"
              style={{ top: idx * GEX_ROW_H, height: GEX_ROW_H }}
              title={`K ${r.strike.toFixed(2)} | net ${fmtGex(r.net_gex)} | call ${fmtGex(r.call_gex)} | put ${fmtGex(r.put_gex)}`}
            >
              <div
                className="absolute h-2.5 rounded-sm"
                style={{
                  background: pos ? GREEN : RED,
                  opacity: 0.85,
                  width: `${pct}%`,
                  left: pos ? "50%" : `${50 - pct}%`,
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Strike axis labels */}
      <div className="w-12 shrink-0 relative" style={{ height: rows.length * GEX_ROW_H }}>
        {rows.map((r, idx) => (
          <div
            key={r.strike}
            className={`absolute right-0 text-2xs tabular-nums ${
              spotTop != null && Math.abs(idx * GEX_ROW_H + GEX_ROW_H / 2 - spotTop) < GEX_ROW_H / 2
                ? "text-terminal-text font-semibold"
                : "text-terminal-dim"
            }`}
            style={{ top: idx * GEX_ROW_H + 2 }}
          >
            {r.strike.toFixed(r.strike < 25 ? 1 : 0)}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="w-28 shrink-0 text-2xs text-terminal-dim flex flex-col gap-1">
        <LegendDot color={GREEN} label="Positive GEX" />
        <LegendDot color={RED} label="Negative GEX" />
        <LegendDot color="#c9785c" label="Zero gamma" />
        <LegendDot color="#ece7df" label="Spot" />
        <div className="mt-2 text-terminal-muted">
          Total{" "}
          <span className={gex.total_gex >= 0 ? "text-accent-green" : "text-accent-red"}>
            {fmtGex(gex.total_gex)}
          </span>
        </div>
        <div className="text-terminal-dim">{gex.gex_unit}</div>
      </div>
    </div>
  );
}

function Marker({
  top,
  color,
  label,
  dashed,
  align = "left",
}: {
  top: number;
  color: string;
  label: string;
  dashed?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top }}>
      <div
        className="w-full"
        style={{
          borderTop: `1px ${dashed ? "dashed" : "solid"} ${color}`,
          opacity: 0.9,
        }}
      />
      <span
        className={`absolute -translate-y-1/2 text-2xs px-1 rounded-sm bg-terminal-bg ${
          align === "right" ? "right-0" : "left-0"
        }`}
        style={{ color }}
      >
        {label}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

// ── (c) Max pain payout curve (TradingView) ───────────────────────────────────

const MP_BASE = Math.floor(Date.UTC(2000, 0, 1) / 1000);

function MaxPainChart({ maxPain }: { maxPain: OptionsMaxPain }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // Map each payout point to a synthetic, evenly-spaced time so the line renders;
  // the axis is re-labelled with the underlying strike via tickMarkFormatter.
  const curve = useMemo(
    () => maxPain.payout_curve.slice().sort((a, b) => a.strike - b.strike),
    [maxPain.payout_curve],
  );

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }
    if (!curve.length) return;

    const timeToStrike = (t: number) => curve[Math.round((t - MP_BASE) / 86400)]?.strike;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 240,
      layout: {
        background: { color: "transparent" },
        textColor: "#a39a8c",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      grid: { vertLines: { color: "#2e2a24" }, horzLines: { color: "#2e2a24" } },
      rightPriceScale: { borderColor: "#3a352d" },
      timeScale: {
        borderColor: "#3a352d",
        tickMarkFormatter: (t: number) => {
          const k = timeToStrike(t);
          return k == null ? "" : k.toFixed(0);
        },
      },
      localization: {
        timeFormatter: (t: number) => {
          const k = timeToStrike(t);
          return k == null ? "" : `K ${k.toFixed(2)}`;
        },
      },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#c9785c",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(
      curve.map((p, i) => ({
        time: (MP_BASE + i * 86400) as UTCTimestamp,
        value: p.payout,
      })),
    );

    // Spot + max-pain markers at their nearest strike index.
    const idxOf = (k: number) => {
      let best = 0;
      let bestD = Infinity;
      curve.forEach((p, i) => {
        const d = Math.abs(p.strike - k);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };
    const mpIdx = idxOf(maxPain.max_pain);
    const spotIdx = idxOf(maxPain.spot);
    try {
      (series as unknown as { setMarkers: (m: unknown[]) => void }).setMarkers(
        [
          {
            time: (MP_BASE + mpIdx * 86400) as UTCTimestamp,
            position: "belowBar",
            color: "#c9785c",
            shape: "arrowUp",
            text: `Max Pain ${maxPain.max_pain.toFixed(0)}`,
          },
          {
            time: (MP_BASE + spotIdx * 86400) as UTCTimestamp,
            position: "aboveBar",
            color: "#6e92c4",
            shape: "circle",
            text: `Spot ${maxPain.spot.toFixed(0)}`,
          },
        ].sort((a, b) => (a.time as number) - (b.time as number)),
      );
    } catch {
      /* setMarkers unavailable on this series build; curve still renders */
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
  }, [curve, maxPain.max_pain, maxPain.spot]);

  if (!curve.length) return <div className="text-2xs text-terminal-dim">No payout data.</div>;

  return (
    <div>
      <div ref={ref} />
      <div className="text-2xs text-terminal-dim mt-1">
        Total option holder payout by pinning strike. The minimum is the max-pain level.
      </div>
    </div>
  );
}

// ── (d) Greeks ladder ─────────────────────────────────────────────────────────

function GreeksLadder({ greeks }: { greeks: OptionsGreeks }) {
  const rows = greeks.rows;
  // ATM row = closest moneyness to 1 (or strike to spot).
  const atmIdx = useMemo(() => {
    let best = -1;
    let bestD = Infinity;
    rows.forEach((r, i) => {
      const d = Math.abs((r.moneyness ?? r.strike / greeks.spot) - 1);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }, [rows, greeks.spot]);

  if (!rows.length) return <div className="text-2xs text-terminal-dim">No greeks data.</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-2xs tabular-nums">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide">
            <th className="text-right py-1 px-2">Strike</th>
            <th className="text-right py-1 px-2">Mny</th>
            <th className="text-right py-1 px-2 border-l border-terminal-border/40 text-accent-green">C Δ</th>
            <th className="text-right py-1 px-2 text-accent-green">C Γ</th>
            <th className="text-right py-1 px-2 text-accent-green">C V</th>
            <th className="text-right py-1 px-2 text-accent-green">C Θ</th>
            <th className="text-right py-1 px-2 text-accent-green">C IV</th>
            <th className="text-right py-1 px-2 text-accent-green">C OI</th>
            <th className="text-right py-1 px-2 border-l border-terminal-border/40 text-accent-red">P Δ</th>
            <th className="text-right py-1 px-2 text-accent-red">P Γ</th>
            <th className="text-right py-1 px-2 text-accent-red">P V</th>
            <th className="text-right py-1 px-2 text-accent-red">P Θ</th>
            <th className="text-right py-1 px-2 text-accent-red">P IV</th>
            <th className="text-right py-1 px-2 text-accent-red">P OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const atm = i === atmIdx;
            return (
              <tr
                key={r.strike}
                className={`border-t border-terminal-border/20 ${
                  atm ? "bg-accent-amber/10" : "hover:bg-white/[0.02]"
                }`}
              >
                <td className={`py-1 px-2 text-right ${atm ? "text-accent-amber font-semibold" : "text-terminal-text"}`}>
                  {r.strike.toFixed(r.strike < 25 ? 1 : 0)}
                </td>
                <td className="py-1 px-2 text-right text-terminal-dim">{r.moneyness.toFixed(2)}</td>
                {/* Call */}
                <td className="py-1 px-2 text-right border-l border-terminal-border/40 text-terminal-text">{r.call.delta.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.call.gamma.toFixed(3)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.call.vega.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.call.theta.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-accent-amber">{r.call.iv.toFixed(1)}</td>
                <td className="py-1 px-2 text-right text-terminal-dim">{fmtOi(r.call.oi)}</td>
                {/* Put */}
                <td className="py-1 px-2 text-right border-l border-terminal-border/40 text-terminal-text">{r.put.delta.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.put.gamma.toFixed(3)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.put.vega.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-terminal-muted">{r.put.theta.toFixed(2)}</td>
                <td className="py-1 px-2 text-right text-accent-amber">{r.put.iv.toFixed(1)}</td>
                <td className="py-1 px-2 text-right text-terminal-dim">{fmtOi(r.put.oi)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-2xs text-terminal-dim mt-1">
        Mny = moneyness (K/spot). Greeks per BS model. V = vega per vol point, Θ = theta per day.
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clayColor(v: number | null | undefined, lo: number, hi: number): string {
  if (v == null || Number.isNaN(v)) return "#1a1714";
  const span = hi - lo || 1;
  const t = Math.max(0, Math.min(1, (v - lo) / span));
  const alpha = (0.1 + 0.85 * t).toFixed(2);
  return `rgba(${CLAY.r}, ${CLAY.g}, ${CLAY.b}, ${alpha})`;
}

function cellText(v: number | null | undefined, lo: number, hi: number): string {
  if (v == null || Number.isNaN(v)) return "#4b463d";
  const span = hi - lo || 1;
  const t = Math.max(0, Math.min(1, (v - lo) / span));
  // Darker ink on the hot (high-alpha clay) cells for contrast.
  return t > 0.55 ? "#1a1714" : "#ece7df";
}

// Fractional vertical pixel position of a strike value within a high-to-low list.
function interpTop(strikesDesc: number[], target: number): number | null {
  if (!strikesDesc.length || target == null || Number.isNaN(target)) return null;
  const n = strikesDesc.length;
  // Above the top strike or below the bottom: clamp to edges.
  if (target >= strikesDesc[0]) return GEX_ROW_H / 2;
  if (target <= strikesDesc[n - 1]) return (n - 1) * GEX_ROW_H + GEX_ROW_H / 2;
  for (let i = 0; i < n - 1; i++) {
    const a = strikesDesc[i];
    const b = strikesDesc[i + 1];
    if (a >= target && target >= b) {
      const frac = a === b ? 0 : (a - target) / (a - b);
      return (i + frac) * GEX_ROW_H + GEX_ROW_H / 2;
    }
  }
  return null;
}

function fmtGex(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(2)}K`;
  return `${sign}${a.toFixed(2)}`;
}

function fmtOi(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

function gammaRegime(zeroGamma: number, spot: number): string {
  if (spot >= zeroGamma) return "spot above flip (long gamma)";
  return "spot below flip (short gamma)";
}
