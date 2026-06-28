import { useEffect, useMemo, useState } from "react";

/**
 * Crack Spreads & Refining Margins (Bloomberg `CRK`).
 *
 * Fetches /api/crack-spreads. Renders a KPI strip (3-2-1 hero + gasoline,
 * distillate, 5-3-2 cracks), a hero inline-SVG line chart of the 3-2-1
 * history with its 1y hi/lo band, and a full spread table. Self-contained:
 * mirrors the backend shape as local interfaces and ships a populated
 * FALLBACK so the panel never renders empty.
 */

// -- Local mirrors of crack_spreads.py payload -------------------------------

interface HistoryPoint {
  date: string;
  value: number;
}

interface Spread {
  name: string;
  key: string;
  current: number;
  change: number;
  unit: string;
  pct_rank: number;
  hi_1y: number;
  lo_1y: number;
  avg_20d: number;
  context?: string;
  note?: string;
  history: HistoryPoint[];
}

interface FrontMonth {
  cl: number;
  rb: number;
  ho: number;
}

interface CrackSpreadsResponse {
  spreads: Spread[];
  front_month: FrontMonth;
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Deterministic local fallback (so screenshots are never empty) -----------

function buildFallbackHistory(base: number, amp: number, seed: number): HistoryPoint[] {
  const pts: HistoryPoint[] = [];
  const today = new Date();
  for (let i = 251; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const t = (251 - i) / 251;
    const wave = Math.sin((t * 6.0 + seed) * Math.PI) * amp;
    const drift = Math.cos((t * 2.0 + seed) * Math.PI) * amp * 0.5;
    pts.push({ date: d.toISOString().slice(0, 10), value: +(base + wave + drift).toFixed(2) });
  }
  return pts;
}

function fallbackSpread(
  name: string,
  key: string,
  base: number,
  amp: number,
  seed: number,
  note: string,
): Spread {
  const history = buildFallbackHistory(base, amp, seed);
  const vals = history.map((h) => h.value);
  const current = vals[vals.length - 1];
  const prev = vals[vals.length - 2] ?? current;
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const avg20 = vals.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vals.length);
  const rank = (vals.filter((v) => v <= current).length / vals.length) * 100;
  return {
    name,
    key,
    current: +current.toFixed(2),
    change: +(current - prev).toFixed(2),
    unit: "$/bbl",
    pct_rank: +rank.toFixed(1),
    hi_1y: +hi.toFixed(2),
    lo_1y: +lo.toFixed(2),
    avg_20d: +avg20.toFixed(2),
    context: rank >= 70 ? "strong - margins rich vs 1y" : rank <= 30 ? "weak - margins compressed vs 1y" : "mid-range vs 1y",
    note,
    history,
  };
}

const FALLBACK: CrackSpreadsResponse = {
  spreads: [
    fallbackSpread("3-2-1 Crack", "crack_321", 26.0, 5.5, 0.2,
      "Blended refiner margin: 3 barrels crude -> 2 gasoline + 1 distillate."),
    fallbackSpread("Gasoline Crack (1-1)", "crack_gas", 24.0, 6.0, 0.7,
      "RBOB gasoline value over WTI crude, per barrel."),
    fallbackSpread("Distillate Crack (1-1)", "crack_distillate", 28.0, 5.0, 1.1,
      "Heating oil / ULSD value over WTI crude, per barrel."),
    fallbackSpread("5-3-2 Crack", "crack_532", 25.5, 5.0, 1.6,
      "Alternate refiner margin: 5 crude -> 3 gasoline + 2 distillate."),
  ],
  front_month: { cl: 78.0, rb: 2.46, ho: 2.55 },
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "local fallback",
};

// -- Formatting helpers ------------------------------------------------------

function fmt(v: number, dp = 2): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function signed(v: number): string {
  const s = v >= 0 ? "+" : "";
  return s + fmt(v);
}

function changeClass(v: number): string {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

// -- Hero SVG line chart with 1y hi/lo band ----------------------------------

function HeroChart({ spread }: { spread: Spread }) {
  const W = 720;
  const H = 200;
  const padL = 6;
  const padR = 6;
  const padT = 10;
  const padB = 16;

  const { path, hiY, loY, lastX, lastY, up } = useMemo(() => {
    const vals = spread.history.map((h) => h.value);
    if (vals.length < 2) {
      return { path: "", hiY: 0, loY: 0, lastX: 0, lastY: 0, up: true };
    }
    const min = Math.min(...vals, spread.lo_1y);
    const max = Math.max(...vals, spread.hi_1y);
    const span = max - min || 1;
    const n = vals.length;
    const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    return {
      path: d,
      hiY: y(spread.hi_1y),
      loY: y(spread.lo_1y),
      lastX: x(n - 1),
      lastY: y(vals[n - 1]),
      up: vals[n - 1] >= vals[0],
    };
  }, [spread]);

  const stroke = up ? "var(--accent-green, #4f9d69)" : "var(--accent-red, #c2553f)";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 200 }}>
      {/* 1y hi/lo band */}
      <rect
        x={padL}
        y={hiY}
        width={W - padL - padR}
        height={Math.max(0, loY - hiY)}
        fill="currentColor"
        className="text-terminal-muted"
        opacity={0.06}
      />
      <line x1={padL} y1={hiY} x2={W - padR} y2={hiY} stroke="currentColor" className="text-accent-green" strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />
      <line x1={padL} y1={loY} x2={W - padR} y2={loY} stroke="currentColor" className="text-accent-red" strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />
      {/* spread line */}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      {/* last marker */}
      {lastX > 0 && <circle cx={lastX} cy={lastY} r={2.6} fill={stroke} />}
    </svg>
  );
}

// -- Panel -------------------------------------------------------------------

export function CrackSpreadsPanel() {
  const [data, setData] = useState<CrackSpreadsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/crack-spreads")
      .then((res) => res.json())
      .then((json: CrackSpreadsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.spreads) && json.spreads.length > 0) {
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

  const { spreads, front_month, data_mode, as_of, source } = data;

  const byKey = useMemo(() => {
    const m: Record<string, Spread> = {};
    spreads.forEach((s) => (m[s.key] = s));
    return m;
  }, [spreads]);

  const hero = byKey["crack_321"] ?? spreads[0];
  const kpis = [
    byKey["crack_gas"],
    byKey["crack_distillate"],
    byKey["crack_532"],
  ].filter(Boolean) as Spread[];

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <span>Crack Spreads & Refining Margins</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : `${data_mode === "live" ? "LIVE" : "SAMPLE"} · ${as_of.slice(0, 16)}Z`}
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-3">
          {/* 3-2-1 hero stat */}
          {hero && (
            <div className="rounded-panel border border-terminal-border bg-terminal-panel px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-terminal-muted">{hero.name}</div>
              <div className="flex items-baseline gap-1">
                <span className="stat-figure text-accent-amber tabular-nums">{fmt(hero.current)}</span>
                <span className="text-[11px] text-terminal-dim">$/bbl</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
                <span className={changeClass(hero.change)}>{signed(hero.change)}</span>
                <span className="pill">{fmt(hero.pct_rank, 0)} pctl</span>
              </div>
            </div>
          )}
          {/* secondary cracks */}
          {kpis.map((s) => (
            <div key={s.key} className="rounded-panel border border-terminal-border bg-terminal-panel px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-terminal-muted">{s.name}</div>
              <div className="flex items-baseline gap-1">
                <span className="font-serif text-2xl text-terminal-text tabular-nums">{fmt(s.current)}</span>
                <span className="text-[11px] text-terminal-dim">$/bbl</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
                <span className={changeClass(s.change)}>{signed(s.change)}</span>
                <span className="text-terminal-dim">20d {fmt(s.avg_20d)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Hero chart of 3-2-1 */}
        {hero && (
          <div className="rounded-panel border border-terminal-border bg-terminal-panel px-3 py-2 text-accent-green">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-terminal-muted">
                {hero.name} · 1y history
              </span>
              <span className="font-mono text-[11px] tabular-nums text-terminal-dim">
                1y range <span className="text-accent-red">{fmt(hero.lo_1y)}</span>
                {" to "}
                <span className="text-accent-green">{fmt(hero.hi_1y)}</span> $/bbl
                {hero.context ? ` · ${hero.context}` : ""}
              </span>
            </div>
            <HeroChart spread={hero} />
          </div>
        )}

        {/* Spread table */}
        <div className="rounded-panel border border-terminal-border overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-terminal-panel text-terminal-muted text-[10px] uppercase tracking-wide">
                <th className="px-3 py-1.5 text-left font-medium">Spread</th>
                <th className="px-3 py-1.5 text-right font-medium">Current</th>
                <th className="px-3 py-1.5 text-right font-medium">Day Chg</th>
                <th className="px-3 py-1.5 text-right font-medium">20d Avg</th>
                <th className="px-3 py-1.5 text-right font-medium">1y Range</th>
                <th className="px-3 py-1.5 text-right font-medium">Percentile</th>
              </tr>
            </thead>
            <tbody>
              {spreads.map((s) => (
                <tr key={s.key} className="border-t border-terminal-divider">
                  <td className="px-3 py-1.5 text-terminal-text">{s.name}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-text">{fmt(s.current)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${changeClass(s.change)}`}>{signed(s.change)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-muted">{fmt(s.avg_20d)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-muted">
                    {fmt(s.lo_1y)} to {fmt(s.hi_1y)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-text">{fmt(s.pct_rank, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Front-month legs + plain-language footer */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums text-terminal-dim">
          <span>Front-month:</span>
          <span>WTI <span className="text-terminal-text">{fmt(front_month.cl)}</span> $/bbl</span>
          <span>RBOB <span className="text-terminal-text">{fmt(front_month.rb, 4)}</span> $/gal</span>
          <span>ULSD <span className="text-terminal-text">{fmt(front_month.ho, 4)}</span> $/gal</span>
        </div>
        <p className="text-[11px] leading-snug text-terminal-muted">
          A crack spread is the refiner's gross margin: the value of the products (gasoline + distillate) made from
          a barrel of crude, minus the cost of that crude. A wider spread means refining is more profitable.
        </p>
        <div className="text-[10px] text-terminal-dim">Source: {source}</div>
      </div>
    </div>
  );
}
