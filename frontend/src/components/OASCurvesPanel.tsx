import { useEffect, useMemo, useState } from "react";

/**
 * Corporate OAS Term-Structure by Rating (Bloomberg `SPRD`).
 *
 * Credit spreads across the full rating ladder (AAA -> CCC) plus the IG and HY
 * aggregate option-adjusted spreads. Header KPIs (IG OAS, HY OAS, IG-HY gap,
 * BBB-BB crossover), a hero credit-curve SVG, IG/HY history sparklines, and a
 * per-rating table colored by z-score extremity. Shapes mirror the backend at
 * backend/app/data/oas_curves.py. Fetches /api/oas-curves directly to stay
 * decoupled from the api client (wired by the controller).
 */

// ── Local mirrors of the backend shape ────────────────────────────────────────

interface HistPoint {
  date: string;
  value: number;
}

interface RatingRow {
  rating: string;
  oas_bps: number;
  change_bps: number;
  pct_rank: number;
  z_score: number;
  hi_1y: number;
  lo_1y: number;
  history: HistPoint[];
}

interface CurvePoint {
  rating: string;
  oas_bps: number;
}

interface OASData {
  ratings: RatingRow[];
  curve: CurvePoint[];
  ig_oas: number;
  ig_oas_change_bps?: number;
  ig_oas_history?: HistPoint[];
  hy_oas: number;
  hy_oas_change_bps?: number;
  hy_oas_history?: HistPoint[];
  ig_hy_gap: number;
  crossover_gap: number;
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Local fallback so the panel is never empty ────────────────────────────────

const FALLBACK: OASData = {
  ratings: [
    { rating: "AAA", oas_bps: 52, change_bps: 0.4, pct_rank: 28, z_score: -0.6, hi_1y: 66, lo_1y: 47, history: [] },
    { rating: "AA", oas_bps: 64, change_bps: 0.6, pct_rank: 31, z_score: -0.5, hi_1y: 81, lo_1y: 58, history: [] },
    { rating: "A", oas_bps: 88, change_bps: 0.9, pct_rank: 24, z_score: -0.8, hi_1y: 110, lo_1y: 80, history: [] },
    { rating: "BBB", oas_bps: 128, change_bps: 1.2, pct_rank: 22, z_score: -0.9, hi_1y: 162, lo_1y: 118, history: [] },
    { rating: "BB", oas_bps: 232, change_bps: 2.6, pct_rank: 18, z_score: -1.1, hi_1y: 312, lo_1y: 210, history: [] },
    { rating: "B", oas_bps: 392, change_bps: 4.1, pct_rank: 26, z_score: -0.7, hi_1y: 520, lo_1y: 360, history: [] },
    { rating: "CCC", oas_bps: 902, change_bps: 12.5, pct_rank: 34, z_score: -0.3, hi_1y: 1240, lo_1y: 820, history: [] },
  ],
  curve: [
    { rating: "AAA", oas_bps: 52 }, { rating: "AA", oas_bps: 64 }, { rating: "A", oas_bps: 88 },
    { rating: "BBB", oas_bps: 128 }, { rating: "BB", oas_bps: 232 }, { rating: "B", oas_bps: 392 },
    { rating: "CCC", oas_bps: 902 },
  ],
  ig_oas: 96,
  ig_oas_change_bps: 1.0,
  hy_oas: 324,
  hy_oas_change_bps: 3.4,
  ig_hy_gap: 228,
  crossover_gap: 104,
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "local fallback",
};

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmt0 = (n: number) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = (n: number) => (n >= 0 ? "+" : "") + fmt1(n);

const changeColor = (n: number) => (n > 0 ? "text-accent-red" : n < 0 ? "text-accent-green" : "text-terminal-muted");

// z-score extremity -> color. Wide (high positive z) = stress = red.
function zColor(z: number): string {
  if (z >= 1.5) return "text-accent-red";
  if (z >= 0.75) return "text-accent-amber";
  if (z <= -1.0) return "text-accent-green";
  return "text-terminal-text";
}

function ratingColor(rating: string): string {
  if (rating === "BB" || rating === "B" || rating === "CCC") return "text-accent-amber";
  return "text-accent-blue";
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ data, color, w = 150, h = 34 }: { data: HistPoint[]; color: string; w?: number; h?: number }) {
  if (!data || data.length < 2) {
    return <div className="text-terminal-dim text-[10px] font-mono">no history</div>;
  }
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

// ── KPI cell ──────────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 border-r border-terminal-divider last:border-r-0 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-terminal-muted truncate">{label}</div>
      <div className="stat-figure text-terminal-text tabular-nums leading-none">{value}</div>
      {sub ? <div className={`text-[11px] font-mono tabular-nums ${subColor ?? "text-terminal-muted"}`}>{sub}</div> : null}
    </div>
  );
}

// ── Hero credit curve (log-ish y) ─────────────────────────────────────────────

function CreditCurve({ curve }: { curve: CurvePoint[] }) {
  const W = 520;
  const H = 200;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const geom = useMemo(() => {
    if (curve.length === 0) return null;
    const logs = curve.map((c) => Math.log10(Math.max(c.oas_bps, 1)));
    const lo = Math.min(...logs);
    const hi = Math.max(...logs);
    const span = hi - lo || 1;
    const x = (i: number) => padL + (i / (curve.length - 1)) * plotW;
    const y = (oas: number) => padT + plotH - ((Math.log10(Math.max(oas, 1)) - lo) / span) * plotH;
    const pts = curve.map((c, i) => ({ x: x(i), y: y(c.oas_bps), c }));
    const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${padL},${padT + plotH} ${line} ${padL + plotW},${padT + plotH}`;
    // log gridlines at 10/100/1000 bps
    const grid = [10, 100, 1000].filter((g) => Math.log10(g) >= lo - 0.1 && Math.log10(g) <= hi + 0.1).map((g) => ({ g, y: y(g) }));
    return { pts, line, area, grid };
  }, [curve, plotH, plotW]);

  if (!geom) return null;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="block">
      <defs>
        <linearGradient id="oasFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c2703d" stopOpacity={0.28} />
          <stop offset="100%" stopColor="#c2703d" stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {geom.grid.map((gl) => (
        <g key={gl.g}>
          <line x1={padL} y1={gl.y} x2={W - padR} y2={gl.y} stroke="#2a2622" strokeWidth={1} strokeDasharray="2 3" />
          <text x={padL - 6} y={gl.y + 3} textAnchor="end" className="fill-terminal-dim" style={{ fontSize: 9, fontFamily: "monospace" }}>
            {gl.g}
          </text>
        </g>
      ))}
      <polygon points={geom.area} fill="url(#oasFill)" />
      <polyline points={geom.line} fill="none" stroke="#c2703d" strokeWidth={2} strokeLinejoin="round" />
      {geom.pts.map((p) => (
        <g key={p.c.rating}>
          <circle cx={p.x} cy={p.y} r={3} fill="#c2703d" stroke="#0d0b09" strokeWidth={1} />
          <text x={p.x} y={p.y - 8} textAnchor="middle" className="fill-terminal-text" style={{ fontSize: 9, fontFamily: "monospace" }}>
            {fmt0(p.c.oas_bps)}
          </text>
          <text x={p.x} y={H - 10} textAnchor="middle" className="fill-terminal-muted" style={{ fontSize: 10, fontFamily: "monospace" }}>
            {p.c.rating}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function OASCurvesPanel() {
  const [data, setData] = useState<OASData>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/oas-curves")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: OASData) => {
        if (!alive) return;
        if (d && Array.isArray(d.ratings) && d.ratings.length > 0) setData(d);
      })
      .catch(() => {
        /* keep populated fallback */
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const igHist = data.ig_oas_history ?? [];
  const hyHist = data.hy_oas_history ?? [];

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CREDIT SPREADS BY RATING (OAS)</span>
        <span className="flex items-center gap-2">
          {loading ? <span className="text-[10px] text-terminal-dim font-mono">loading...</span> : null}
          <span className={`pill ${data.data_mode === "live" ? "text-accent-green" : "text-accent-amber"}`}>
            {data.data_mode === "live" ? "LIVE" : "SAMPLE"}
          </span>
        </span>
      </div>

      <div className="panel-body flex-1 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-4 rounded-panel border border-terminal-border bg-terminal-panel">
          <Kpi
            label="IG OAS"
            value={`${fmt0(data.ig_oas)} bp`}
            sub={data.ig_oas_change_bps != null ? `${signed(data.ig_oas_change_bps)} bp` : undefined}
            subColor={data.ig_oas_change_bps != null ? changeColor(data.ig_oas_change_bps) : undefined}
          />
          <Kpi
            label="HY OAS"
            value={`${fmt0(data.hy_oas)} bp`}
            sub={data.hy_oas_change_bps != null ? `${signed(data.hy_oas_change_bps)} bp` : undefined}
            subColor={data.hy_oas_change_bps != null ? changeColor(data.hy_oas_change_bps) : undefined}
          />
          <Kpi label="IG-HY GAP" value={`${fmt0(data.ig_hy_gap)} bp`} sub="HY over IG" />
          <Kpi label="BBB-BB CROSSOVER" value={`${fmt0(data.crossover_gap)} bp`} sub="IG/HY boundary" />
        </div>

        {/* Hero curve + sparklines */}
        <div className="grid grid-cols-[1.7fr_1fr] gap-3">
          <div className="rounded-panel border border-terminal-border bg-terminal-panel p-2">
            <div className="text-[10px] uppercase tracking-wider text-terminal-muted px-1 pb-1">
              Credit curve - OAS by rating (log scale, bps)
            </div>
            <CreditCurve curve={data.curve} />
          </div>
          <div className="rounded-panel border border-terminal-border bg-terminal-panel p-3 flex flex-col gap-3 justify-center">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-mono text-accent-blue">IG MASTER</span>
                <span className="font-mono tabular-nums text-terminal-text text-sm">{fmt0(data.ig_oas)} bp</span>
              </div>
              <Sparkline data={igHist} color="#5b8def" w={210} />
            </div>
            <div className="border-t border-terminal-divider" />
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-mono text-accent-amber">HY MASTER</span>
                <span className="font-mono tabular-nums text-terminal-text text-sm">{fmt0(data.hy_oas)} bp</span>
              </div>
              <Sparkline data={hyHist} color="#d99a2b" w={210} />
            </div>
          </div>
        </div>

        {/* Ratings table */}
        <div className="rounded-panel border border-terminal-border bg-terminal-panel overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-terminal-muted border-b border-terminal-divider">
                <th className="text-left font-medium px-3 py-2">Rating</th>
                <th className="text-right font-medium px-3 py-2">OAS (bp)</th>
                <th className="text-right font-medium px-3 py-2">Day Chg</th>
                <th className="text-right font-medium px-3 py-2">Pctile</th>
                <th className="text-right font-medium px-3 py-2">Z-Score</th>
                <th className="text-right font-medium px-3 py-2">1Y Range (bp)</th>
              </tr>
            </thead>
            <tbody>
              {data.ratings.map((r) => {
                const range = Math.max(r.hi_1y - r.lo_1y, 1);
                const posPct = Math.min(100, Math.max(0, ((r.oas_bps - r.lo_1y) / range) * 100));
                return (
                  <tr key={r.rating} className="border-b border-terminal-divider last:border-b-0 hover:bg-terminal-bg/40">
                    <td className={`px-3 py-2 font-mono font-semibold ${ratingColor(r.rating)}`}>{r.rating}</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums font-semibold ${zColor(r.z_score)}`}>
                      {fmt1(r.oas_bps)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${changeColor(r.change_bps)}`}>
                      {signed(r.change_bps)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-terminal-muted">{fmt0(r.pct_rank)}%</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${zColor(r.z_score)}`}>
                      {r.z_score >= 0 ? "+" : ""}
                      {r.z_score.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono tabular-nums text-terminal-dim text-[11px]">{fmt0(r.lo_1y)}</span>
                        <span className="relative h-1.5 w-16 rounded-full bg-terminal-bg overflow-hidden">
                          <span
                            className="absolute top-0 h-full w-1 rounded-full bg-accent"
                            style={{ left: `calc(${posPct}% - 2px)` }}
                          />
                        </span>
                        <span className="font-mono tabular-nums text-terminal-dim text-[11px]">{fmt0(r.hi_1y)}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer / legend */}
        <div className="flex items-start justify-between gap-3 text-[10px] text-terminal-dim">
          <p className="leading-snug max-w-[60%]">
            OAS (option-adjusted spread) is the extra yield over Treasuries that investors demand to hold corporate
            credit - it is the compensation for default and liquidity risk. Wider spreads signal stress; tighter spreads
            signal risk appetite. Cells turn red when a rating trades rich to its history (high z-score).
          </p>
          <div className="flex flex-col items-end gap-1 font-mono shrink-0">
            <span>src: {data.source}</span>
            <span>{new Date(data.as_of).toLocaleString("en-US")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
