import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose, per build contract)

interface HistoryPoint {
  date: string;
  value: number;
}

interface Ratio {
  key: string;
  name: string;
  num: string;
  den: string;
  op: string;
  unit: string;
  headline: boolean;
  precision: number;
  current: number;
  change: number;
  change_pct: number;
  z_score: number;
  pct_rank: number;
  hi: number;
  lo: number;
  mean: number;
  std: number;
  blurb: string;
  n_obs: number;
  data_mode: string;
  source: string;
  history: HistoryPoint[];
}

interface SpreadsResponse {
  ratios: Ratio[];
  count: number;
  live_count: number;
  data_mode: string;
  as_of: string;
  source: string;
}

// Headline ratios shown in the KPI strip (in this order when present).
const HEADLINE_ORDER = ["gold_silver", "gold_oil", "wti_brent", "oil_gas"];

// Deterministic mean-reverting fallback so the panel renders fully populated
// with no backend. Mirrors the backend sample story + levels.

function buildFallbackSeries(
  seed: number,
  level: number,
  sigma: number,
  trend: number,
  n: number,
): HistoryPoint[] {
  // Tiny seeded PRNG (mulberry32) so the fallback is stable across renders.
  let s = seed >>> 0;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const kappa = 0.04;
  const out: HistoryPoint[] = [];
  const today = new Date();
  let x = level;
  for (let i = 0; i < n; i++) {
    const center = level + trend * i;
    const shock = (rnd() - 0.5) * 2 * sigma * 1.6;
    x = x + kappa * (center - x) + shock;
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    out.push({ date: d.toISOString().slice(0, 10), value: x });
  }
  return out;
}

function statsFromSeries(
  spec: {
    key: string;
    name: string;
    num: string;
    den: string;
    op: string;
    unit: string;
    headline: boolean;
    precision: number;
    blurb: string;
  },
  seed: number,
  level: number,
  sigma: number,
  trend: number,
): Ratio {
  const series = buildFallbackSeries(seed, level, sigma, trend, 380);
  const vals = series.map((p) => p.value);
  const cur = vals[vals.length - 1];
  const prev = vals[vals.length - 2] ?? cur;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (vals.length - 1);
  const std = Math.sqrt(variance);
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const pct = (vals.filter((v) => v <= cur).length / vals.length) * 100;
  return {
    ...spec,
    current: cur,
    change: cur - prev,
    change_pct: prev ? ((cur - prev) / prev) * 100 : 0,
    z_score: std > 0 ? (cur - mean) / std : 0,
    pct_rank: pct,
    hi,
    lo,
    mean,
    std,
    n_obs: vals.length,
    data_mode: "sample",
    source: "curated",
    history: series,
  };
}

const FALLBACK: SpreadsResponse = {
  ratios: [
    statsFromSeries(
      { key: "gold_silver", name: "Gold / Silver", num: "GC=F", den: "SI=F", op: "ratio", unit: "ratio", headline: true, precision: 2, blurb: "Ounces of silver per ounce of gold (the mint ratio). High = silver cheap vs gold / risk-off; low = silver leading / reflation." },
      11, 86.0, 0.55, 0.01,
    ),
    statsFromSeries(
      { key: "gold_oil", name: "Gold / Oil", num: "GC=F", den: "CL=F", op: "ratio", unit: "bbl/oz", headline: true, precision: 1, blurb: "Barrels of WTI one ounce of gold buys. High = oil cheap or gold bid (slowdown/haven); low = energy leading." },
      23, 30.5, 0.4, 0.004,
    ),
    statsFromSeries(
      { key: "wti_brent", name: "WTI - Brent", num: "CL=F", den: "BZ=F", op: "spread", unit: "$/bbl", headline: true, precision: 2, blurb: "WTI minus Brent. Persistently negative; a widening discount signals US glut / export & logistics stress." },
      37, -3.85, 0.18, -0.004,
    ),
    statsFromSeries(
      { key: "oil_gas", name: "Oil / Gas", num: "CL=F", den: "NG=F", op: "ratio", unit: "ratio", headline: true, precision: 1, blurb: "Crude ($/bbl) divided by natural gas ($/MMBtu). Historically ~15-30; high = gas cheap on a BTU basis vs oil." },
      59, 26.5, 0.65, 0.012,
    ),
    statsFromSeries(
      { key: "gold_copper", name: "Gold / Copper", num: "GC=F", den: "HG=F", op: "ratio", unit: "ratio", headline: false, precision: 0, blurb: "Defensive gold vs growth-cyclical copper. Rising = defensive leadership / slowdown; falling = pro-growth." },
      71, 525.0, 4.2, 0.1,
    ),
    statsFromSeries(
      { key: "soy_corn", name: "Soybeans / Corn", num: "ZS=F", den: "ZC=F", op: "ratio", unit: "ratio", headline: false, precision: 2, blurb: "Bushel-price ratio that drives US acreage decisions. High (>2.5) favors planting soybeans next season." },
      83, 2.62, 0.018, 0.0004,
    ),
    statsFromSeries(
      { key: "platinum_gold", name: "Platinum / Gold", num: "PL=F", den: "GC=F", op: "ratio", unit: "ratio", headline: false, precision: 3, blurb: "Platinum priced in gold. Deeply below 1 historically; a turn up often tracks reviving industrial demand." },
      97, 0.415, 0.004, -0.00008,
    ),
  ],
  count: 7,
  live_count: 0,
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Formatting

function fmtNum(v: number | null | undefined, precision: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function fmtSigned(v: number | null | undefined, precision: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return sign + fmtNum(v, precision);
}

// Color a number by the extremity of its z-score. Extreme readings glow accent.
function zColor(z: number): string {
  const a = Math.abs(z);
  if (a >= 2) return "text-accent";
  if (a >= 1) return "text-accent-amber";
  return "text-terminal-text";
}

function changeColor(v: number): string {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

function zLabel(z: number): string {
  const a = Math.abs(z);
  if (a >= 2) return z > 0 ? "Stretched high" : "Stretched low";
  if (a >= 1) return z > 0 ? "Rich" : "Cheap";
  return "Neutral";
}

// Hero SVG chart geometry

const VW = 1000;
const VH = 280;
const PAD = { top: 16, right: 16, bottom: 24, left: 16 };

interface ChartGeom {
  linePath: string;
  areaPath: string;
  recentPath: string;
  meanY: number;
  plusZY: number;
  minusZY: number;
  curX: number;
  curY: number;
  ticks: { x: number; label: string }[];
}

function fmtMonth(iso: string): string {
  if (!iso) return "";
  const [y, m] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = parseInt(m, 10) - 1;
  return `${months[mi] ?? ""} '${y.slice(2)}`;
}

function buildGeom(r: Ratio): ChartGeom {
  const series = r.history;
  const n = series.length;
  const innerW = VW - PAD.left - PAD.right;
  const innerH = VH - PAD.top - PAD.bottom;

  const vals = series.map((p) => p.value);
  const band = r.std;
  const lo = Math.min(Math.min(...vals), r.mean - 1.2 * band);
  const hi = Math.max(Math.max(...vals), r.mean + 1.2 * band);
  const padY = (hi - lo) * 0.08 || 1;
  const yMin = lo - padY;
  const yMax = hi + padY;

  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const linePath = vals
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");

  const baseY = PAD.top + innerH;
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  const recentStart = Math.max(0, n - Math.round(n * 0.12));
  const recentPath = vals
    .slice(recentStart)
    .map((v, k) => `${k === 0 ? "M" : "L"}${x(recentStart + k).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");

  const ticks: { x: number; label: string }[] = [];
  const tickCount = 5;
  for (let t = 0; t < tickCount; t++) {
    const i = Math.round((t / (tickCount - 1)) * (n - 1));
    ticks.push({ x: x(i), label: fmtMonth(series[i].date) });
  }

  return {
    linePath,
    areaPath,
    recentPath,
    meanY: y(r.mean),
    plusZY: y(r.mean + band),
    minusZY: y(r.mean - band),
    curX: x(n - 1),
    curY: y(vals[n - 1]),
    ticks,
  };
}

// Panel

export function CommoditySpreadsPanel() {
  const [data, setData] = useState<SpreadsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>("gold_silver");

  useEffect(() => {
    let alive = true;
    fetch("/api/commodity-spreads")
      .then((res) => res.json())
      .then((json: SpreadsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.ratios) && json.ratios.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const ratios = data.ratios;
  const byKey = useMemo(() => {
    const map: Record<string, Ratio> = {};
    for (const r of ratios) map[r.key] = r;
    return map;
  }, [ratios]);

  const headline = HEADLINE_ORDER.map((k) => byKey[k]).filter(Boolean) as Ratio[];

  const hero = byKey[selected] ?? ratios[0];
  const geom = useMemo(() => (hero ? buildGeom(hero) : null), [hero]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Inter-Commodity Spreads &amp; Ratios</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip - headline ratios */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {headline.map((r) => (
            <button
              key={r.key}
              onClick={() => setSelected(r.key)}
              className={`text-left bg-terminal-bg border rounded p-2.5 flex flex-col gap-0.5 transition-colors ${
                selected === r.key ? "border-accent/60" : "border-terminal-border/50 hover:border-terminal-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{r.name}</div>
                <div className="text-2xs font-mono text-terminal-dim">{r.unit}</div>
              </div>
              <div className={`stat-figure text-2xl tabular-nums ${zColor(r.z_score)}`}>
                {fmtNum(r.current, r.precision)}
              </div>
              <div className="flex items-center justify-between text-2xs font-mono tabular-nums">
                <span className={changeColor(r.change)}>{fmtSigned(r.change, r.precision + 1)} ({fmtSigned(r.change_pct, 2)}%)</span>
                <span className={zColor(r.z_score)}>z {fmtSigned(r.z_score, 2)}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Hero chart */}
        {hero && geom && (
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <div className="flex items-baseline gap-2">
                <SectionLabel>{hero.name}</SectionLabel>
                <span className="font-mono tabular-nums text-sm text-terminal-text">
                  {fmtNum(hero.current, hero.precision)}
                </span>
                <span className="text-2xs text-terminal-dim font-mono">{hero.unit}</span>
                <span className={`text-2xs font-mono tabular-nums ${zColor(hero.z_score)}`}>
                  {zLabel(hero.z_score)} (z {fmtSigned(hero.z_score, 2)}, {fmtNum(hero.pct_rank, 0)} pct)
                </span>
              </div>
              <div className="flex items-center gap-3 text-2xs">
                <LegendDot cls="bg-accent" label="Ratio" />
                <LegendLine cls="stroke-terminal-muted" label="Mean" />
                <LegendLine cls="stroke-accent-amber" label="+/-1 z band" dashed />
              </div>
            </div>
            <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
              <defs>
                <linearGradient id="cs-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c9785c" stopOpacity="0.20" />
                  <stop offset="100%" stopColor="#c9785c" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* +/-1 z bands */}
              <line x1={PAD.left} x2={VW - PAD.right} y1={geom.plusZY} y2={geom.plusZY} className="stroke-accent-amber/40" strokeWidth={0.75} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              <line x1={PAD.left} x2={VW - PAD.right} y1={geom.minusZY} y2={geom.minusZY} className="stroke-accent-amber/40" strokeWidth={0.75} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />

              {/* mean line */}
              <line x1={PAD.left} x2={VW - PAD.right} y1={geom.meanY} y2={geom.meanY} className="stroke-terminal-muted/70" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />

              {/* fill + line */}
              <path d={geom.areaPath} fill="url(#cs-fill)" />
              <path d={geom.linePath} fill="none" className="stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <path d={geom.recentPath} fill="none" className="stroke-accent" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />

              {/* current marker */}
              <circle cx={geom.curX} cy={geom.curY} r={3.2} className="fill-accent" vectorEffect="non-scaling-stroke" />

              {/* x ticks */}
              {geom.ticks.map((t, i) => (
                <text
                  key={i}
                  x={t.x}
                  y={VH - 7}
                  textAnchor={i === 0 ? "start" : i === geom.ticks.length - 1 ? "end" : "middle"}
                  className="fill-terminal-dim"
                  style={{ fontSize: "11px" }}
                >
                  {t.label}
                </text>
              ))}
            </svg>
            <div className="text-2xs text-terminal-muted leading-relaxed pt-1">{hero.blurb}</div>
          </div>
        )}

        {/* Full ratio table */}
        <div>
          <SectionLabel>All Cross-Commodity Relationships</SectionLabel>
          <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden mt-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-2xs text-terminal-dim uppercase tracking-wider border-b border-terminal-border/50">
                  <th className="text-left font-medium px-3 py-1.5">Ratio</th>
                  <th className="text-left font-medium px-2 py-1.5">Legs</th>
                  <th className="text-right font-medium px-2 py-1.5">Current</th>
                  <th className="text-right font-medium px-2 py-1.5">Day Chg</th>
                  <th className="text-right font-medium px-2 py-1.5">Z-Score</th>
                  <th className="text-right font-medium px-2 py-1.5">Pctile</th>
                  <th className="text-right font-medium px-3 py-1.5">1-2y Range</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {ratios.map((r) => (
                  <tr
                    key={r.key}
                    onClick={() => setSelected(r.key)}
                    className={`border-b border-terminal-divider/40 last:border-0 cursor-pointer hover:bg-terminal-panel/60 ${
                      selected === r.key ? "bg-terminal-panel/50" : ""
                    }`}
                  >
                    <td className="px-3 py-1.5 font-sans text-terminal-text whitespace-nowrap">{r.name}</td>
                    <td className="px-2 py-1.5 text-terminal-dim text-2xs whitespace-nowrap">
                      {r.num} {r.op === "spread" ? "-" : "/"} {r.den}
                    </td>
                    <td className={`px-2 py-1.5 text-right ${zColor(r.z_score)}`}>{fmtNum(r.current, r.precision)}</td>
                    <td className={`px-2 py-1.5 text-right ${changeColor(r.change)}`}>{fmtSigned(r.change, r.precision + 1)}</td>
                    <td className={`px-2 py-1.5 text-right ${zColor(r.z_score)}`}>{fmtSigned(r.z_score, 2)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-muted">{fmtNum(r.pct_rank, 0)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-dim text-2xs whitespace-nowrap">
                      {fmtNum(r.lo, r.precision)} - {fmtNum(r.hi, r.precision)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Plain-language read on the headline ratios */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {headline.map((r) => (
            <div key={r.key} className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-0.5">
              <div className="flex items-center justify-between">
                <span className="text-2xs uppercase tracking-wider text-terminal-muted">{r.name}</span>
                <span className={`text-2xs font-mono tabular-nums ${zColor(r.z_score)}`}>{zLabel(r.z_score)}</span>
              </div>
              <p className="text-2xs text-terminal-dim leading-relaxed">
                At <span className="font-mono text-terminal-text">{fmtNum(r.current, r.precision)}</span> {r.unit} it sits in the{" "}
                <span className="font-mono text-terminal-text">{fmtNum(r.pct_rank, 0)}th</span> percentile of its 1-2y range
                ({fmtNum(r.lo, r.precision)} to {fmtNum(r.hi, r.precision)}), {Math.abs(r.z_score) >= 1 ? "a stretched" : "a contained"} reading
                {" "}{r.z_score >= 0 ? "above" : "below"} its {fmtNum(r.mean, r.precision)} mean.
              </p>
            </div>
          ))}
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim border-t border-terminal-border/30 pt-2 font-mono">
          <span>{ratios.length} cross-commodity relationships, front-month futures</span>
          <span>Z-score &amp; percentile vs own 1-2y history</span>
        </div>
      </div>
    </div>
  );
}

// Small components

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs text-terminal-muted uppercase tracking-wider">{children}</div>;
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className={`w-2 h-2 rounded-sm inline-block ${cls}`} />
      {label}
    </span>
  );
}

function LegendLine({ cls, label, dashed = false }: { cls: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <svg width="14" height="6" className="inline-block">
        <line x1="0" y1="3" x2="14" y2="3" className={cls} strokeWidth={1.5} strokeDasharray={dashed ? "3 2" : undefined} />
      </svg>
      {label}
    </span>
  );
}
