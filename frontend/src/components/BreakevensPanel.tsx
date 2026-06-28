import { useEffect, useMemo, useState } from "react";

// -- Local types (decoupled from api/types.ts on purpose) --------------------

interface CurvePoint {
  tenor: string;
  value: number | null;
}

interface DecompRow {
  tenor: string;
  nominal: number | null;
  real: number | null;
  breakeven: number | null;
}

interface HistoryPoint {
  date: string;
  value: number;
}

interface SeriesStat {
  label: string;
  current: number;
  change: number;
  high_1y: number;
  low_1y: number;
  percentile: number;
  zscore: number;
  mean_5y: number;
  history: HistoryPoint[];
}

interface BEIResponse {
  breakeven_curve: CurvePoint[];
  real_curve: CurvePoint[];
  decomposition: DecompRow[];
  series: Record<string, SeriesStat>;
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Local fallback so the panel renders fully populated, even offline -------

function mkHistory(key: string, end: number, swing: number): HistoryPoint[] {
  const n = 130;
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) & 0xffffff;
  const start = end + swing;
  const out: HistoryPoint[] = [];
  const today = new Date();
  let x = start;
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const target = start + (end - start) * frac;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((seed % 1000) / 1000 - 0.5) * 0.06;
    x = x + (target - x) * 0.25 + (i > 0 && i < n - 1 ? noise : 0);
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i) * 2);
    out.push({ date: d.toISOString().slice(0, 10), value: Number(x.toFixed(3)) });
  }
  out[n - 1].value = Number(end.toFixed(3));
  return out;
}

function mkStat(label: string, current: number, change: number, swing: number): SeriesStat {
  const hist = mkHistory(label, current, swing);
  const vals = hist.map((h) => h.value);
  return {
    label,
    current,
    change,
    high_1y: Number(Math.max(...vals).toFixed(3)),
    low_1y: Number(Math.min(...vals).toFixed(3)),
    percentile: 42,
    zscore: Number((swing >= 0 ? -0.6 : 0.6).toFixed(2)),
    mean_5y: Number((current + swing * 0.4).toFixed(3)),
    history: hist,
  };
}

const FALLBACK: BEIResponse = {
  breakeven_curve: [
    { tenor: "5Y", value: 2.42 },
    { tenor: "10Y", value: 2.3 },
    { tenor: "5Y5Y Fwd", value: 2.24 },
  ],
  real_curve: [
    { tenor: "5Y", value: 1.78 },
    { tenor: "10Y", value: 2.0 },
    { tenor: "30Y", value: 2.22 },
  ],
  decomposition: [
    { tenor: "5Y", nominal: 4.2, real: 1.78, breakeven: 2.42 },
    { tenor: "10Y", nominal: 4.3, real: 2.0, breakeven: 2.3 },
    { tenor: "30Y", nominal: 4.55, real: 2.22, breakeven: 2.33 },
  ],
  series: {
    t5yie: mkStat("5Y Breakeven", 2.42, -0.012, 0.18),
    t10yie: mkStat("10Y Breakeven", 2.3, 0.016, 0.12),
    t5yifr: mkStat("5Y5Y Fwd Breakeven", 2.24, 0.008, 0.1),
    dfii10: mkStat("10Y Real Yield", 2.0, 0.021, -0.22),
  },
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

// -- Formatting helpers ------------------------------------------------------

function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(dp)}%`;
}

function fmtChange(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const bps = Math.round(v * 100);
  const sign = bps > 0 ? "+" : "";
  return `${sign}${bps} bp`;
}

function changeColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return "text-terminal-muted";
  return v > 0 ? "text-accent-green" : "text-accent-red";
}

// -- Inline SVG: stacked decomposition bars (real + breakeven = nominal) ------

function DecompChart({ rows }: { rows: DecompRow[] }) {
  const clean = rows.filter((r) => r.nominal != null);
  const w = 100;
  const h = 168;
  const padTop = 14;
  const padBottom = 22;
  const plotH = h - padTop - padBottom;
  const maxV = Math.max(5, ...clean.map((r) => r.nominal ?? 0)) * 1.05;
  const groupW = w / Math.max(clean.length, 1);
  const barW = Math.min(26, groupW * 0.5);

  const yFor = (v: number) => padTop + plotH - (v / maxV) * plotH;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height: 168 }}>
      {/* gridlines */}
      {[0, 1, 2, 3, 4, 5].map((g) => {
        const y = yFor(g);
        if (y < padTop) return null;
        return (
          <g key={g}>
            <line x1={0} y1={y} x2={w} y2={y} stroke="#3a3530" strokeWidth={0.3} opacity={0.5} />
          </g>
        );
      })}
      {clean.map((r, i) => {
        const cx = groupW * i + groupW / 2;
        const x = cx - barW / 2;
        const real = r.real ?? 0;
        const be = r.breakeven ?? 0;
        const realY = yFor(real);
        const realH = padTop + plotH - realY;
        const topY = yFor(real + be);
        const beH = realY - topY;
        return (
          <g key={r.tenor}>
            {/* real component (base) */}
            <rect x={x} y={realY} width={barW} height={Math.max(realH, 0)} fill="#7c9cc4" opacity={0.85} rx={0.6} />
            {/* breakeven component (stacked on top) */}
            <rect x={x} y={topY} width={barW} height={Math.max(beH, 0)} fill="#c6794f" opacity={0.9} rx={0.6} />
            {/* nominal total label */}
            <text x={cx} y={topY - 3} textAnchor="middle" fontSize={6} fill="#e8e2d8" fontFamily="monospace">
              {(r.nominal ?? 0).toFixed(2)}
            </text>
            <text x={cx} y={h - 8} textAnchor="middle" fontSize={6.5} fill="#9a9389" fontFamily="monospace">
              {r.tenor}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// -- Inline SVG: overlaid breakeven curve + real curve ------------------------

function CurveOverlay({ be, real }: { be: CurvePoint[]; real: CurvePoint[] }) {
  const w = 100;
  const h = 168;
  const padTop = 12;
  const padBottom = 22;
  const padX = 8;
  const plotH = h - padTop - padBottom;
  const beVals = be.map((p) => p.value).filter((v): v is number => v != null);
  const realVals = real.map((p) => p.value).filter((v): v is number => v != null);
  const all = [...beVals, ...realVals];
  if (all.length === 0) return null;
  const lo = Math.min(...all) - 0.25;
  const hi = Math.max(...all) + 0.25;
  const range = hi - lo || 1;

  const xFor = (i: number, n: number) => padX + (i / Math.max(n - 1, 1)) * (w - padX * 2);
  const yFor = (v: number) => padTop + plotH - ((v - lo) / range) * plotH;

  const line = (pts: CurvePoint[]) =>
    pts
      .filter((p) => p.value != null)
      .map((p, i, arr) => `${i === 0 ? "M" : "L"}${xFor(i, arr.length).toFixed(1)},${yFor(p.value as number).toFixed(1)}`)
      .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height: 168 }}>
      {[lo, (lo + hi) / 2, hi].map((g, gi) => {
        const y = yFor(g);
        return (
          <g key={gi}>
            <line x1={0} y1={y} x2={w} y2={y} stroke="#3a3530" strokeWidth={0.3} opacity={0.5} />
            <text x={1} y={y - 1} fontSize={5} fill="#6f685f" fontFamily="monospace">
              {g.toFixed(1)}
            </text>
          </g>
        );
      })}
      <path d={line(real)} fill="none" stroke="#7c9cc4" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
      <path d={line(be)} fill="none" stroke="#c6794f" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
      {real.map((p, i, arr) =>
        p.value == null ? null : (
          <circle key={`r${i}`} cx={xFor(i, arr.length)} cy={yFor(p.value)} r={1.5} fill="#7c9cc4" />
        ),
      )}
      {be.map((p, i, arr) =>
        p.value == null ? null : (
          <circle key={`b${i}`} cx={xFor(i, arr.length)} cy={yFor(p.value)} r={1.5} fill="#c6794f" />
        ),
      )}
      {be.map((p, i, arr) =>
        p.value == null ? null : (
          <text
            key={`bt${i}`}
            x={xFor(i, arr.length)}
            y={h - 8}
            textAnchor="middle"
            fontSize={6}
            fill="#9a9389"
            fontFamily="monospace"
          >
            {p.tenor}
          </text>
        ),
      )}
    </svg>
  );
}

// -- Inline SVG sparkline of a history series --------------------------------

function Spark({ data, color }: { data: HistoryPoint[]; color: string }) {
  const w = 150;
  const h = 34;
  if (!data || data.length < 2) return <svg width={w} height={h} className="block" />;
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const points = data
    .map((d, i) => `${(i * stepX).toFixed(1)},${(h - 3 - ((d.value - min) / range) * (h - 6)).toFixed(1)}`)
    .join(" ");
  const lastY = h - 3 - ((vals[vals.length - 1] - min) / range) * (h - 6);
  return (
    <svg width={w} height={h} className="block w-full overflow-visible" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <circle cx={w} cy={lastY} r={1.8} fill={color} />
    </svg>
  );
}

// -- KPI card ----------------------------------------------------------------

function Kpi({
  label,
  value,
  change,
  accent,
  sub,
}: {
  label: string;
  value: string;
  change?: number | null;
  accent: string;
  sub?: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</div>
      <div className={`stat-figure text-2xl tabular-nums ${accent}`}>{value}</div>
      <div className="flex items-center gap-1.5 text-2xs">
        {change != null && (
          <span className={`font-mono tabular-nums font-semibold ${changeColor(change)}`}>{fmtChange(change)}</span>
        )}
        {sub && <span className="text-terminal-dim truncate">{sub}</span>}
      </div>
    </div>
  );
}

// -- Panel -------------------------------------------------------------------

export function BreakevensPanel() {
  const [data, setData] = useState<BEIResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"decomp" | "curve">("decomp");

  useEffect(() => {
    let alive = true;
    fetch("/api/breakevens")
      .then((res) => res.json())
      .then((json: BEIResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.decomposition) && json.decomposition.length > 0) {
          // Backfill headline series from fallback if backend omitted any.
          const merged: BEIResponse = {
            ...json,
            series: { ...FALLBACK.series, ...(json.series || {}) },
          };
          setData(merged);
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

  const { breakeven_curve, real_curve, decomposition, series } = data;

  const s10be = series.t10yie;
  const s5y5y = series.t5yifr;
  const s10real = series.dfii10;
  const nom10 = decomposition.find((r) => r.tenor === "10Y")?.nominal ?? null;

  const beColor = "#c6794f"; // clay - breakeven / inflation
  const realColor = "#7c9cc4"; // steel blue - real yield

  const histRows = useMemo(
    () =>
      [
        { label: "10Y Breakeven", stat: s10be, color: beColor },
        { label: "10Y Real Yield", stat: s10real, color: realColor },
      ].filter((r) => r.stat),
    [s10be, s10real],
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>BREAKEVEN INFLATION & REAL YIELDS</span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
          <div className="flex items-center gap-0.5 normal-case tracking-normal">
            <button
              type="button"
              onClick={() => setView("decomp")}
              className={`px-1.5 py-0.5 rounded text-2xs border ${
                view === "decomp"
                  ? "text-accent border-accent/40 bg-accent/10"
                  : "text-terminal-dim border-terminal-divider hover:text-terminal-muted"
              }`}
            >
              Decomp
            </button>
            <button
              type="button"
              onClick={() => setView("curve")}
              className={`px-1.5 py-0.5 rounded text-2xs border ${
                view === "curve"
                  ? "text-accent border-accent/40 bg-accent/10"
                  : "text-terminal-dim border-terminal-divider hover:text-terminal-muted"
              }`}
            >
              Curves
            </button>
          </div>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi
            label="10Y Breakeven"
            value={fmtPct(s10be?.current)}
            change={s10be?.change}
            accent="text-accent"
            sub="mkt-implied CPI"
          />
          <Kpi
            label="5Y5Y Fwd Breakeven"
            value={fmtPct(s5y5y?.current)}
            change={s5y5y?.change}
            accent="text-accent-amber"
            sub="Fed's favorite gauge"
          />
          <Kpi
            label="10Y Real Yield"
            value={fmtPct(s10real?.current)}
            change={s10real?.change}
            accent="text-accent-blue"
            sub="TIPS, inflation-adj"
          />
          <Kpi
            label="10Y Nominal"
            value={fmtPct(nom10)}
            accent="text-terminal-text"
            sub="real + breakeven"
          />
        </div>

        {/* HERO chart */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-2xs text-terminal-text uppercase tracking-wider font-medium">
              {view === "decomp" ? "Nominal = Real + Breakeven" : "Breakeven vs Real-Yield Curve"}
            </span>
            <div className="flex items-center gap-3 text-2xs">
              <span className="inline-flex items-center gap-1 text-terminal-dim">
                <span className="inline-block w-2.5 h-1.5 rounded-sm" style={{ background: realColor }} /> Real
              </span>
              <span className="inline-flex items-center gap-1 text-terminal-dim">
                <span className="inline-block w-2.5 h-1.5 rounded-sm" style={{ background: beColor }} /> Breakeven
              </span>
            </div>
          </div>
          {view === "decomp" ? (
            <DecompChart rows={decomposition} />
          ) : (
            <CurveOverlay be={breakeven_curve} real={real_curve} />
          )}
        </div>

        {/* History sparklines */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {histRows.map((r) => (
            <div key={r.label} className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-terminal-dim uppercase tracking-wider">{r.label}</span>
                <span className="font-mono tabular-nums text-sm font-semibold" style={{ color: r.color }}>
                  {fmtPct(r.stat?.current)}
                </span>
              </div>
              <Spark data={r.stat?.history ?? []} color={r.color} />
              <div className="flex items-center justify-between text-2xs text-terminal-dim font-mono tabular-nums">
                <span>lo {fmtPct(r.stat?.low_1y)}</span>
                <span>
                  z {r.stat ? (r.stat.zscore >= 0 ? "+" : "") + r.stat.zscore.toFixed(2) : "--"} | pct{" "}
                  {r.stat ? r.stat.percentile.toFixed(0) : "--"}
                </span>
                <span>hi {fmtPct(r.stat?.high_1y)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Decomposition table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden">
          <div className="px-2 py-1.5 border-b border-terminal-divider">
            <span className="text-2xs text-terminal-text uppercase tracking-wider font-medium">
              Yield Decomposition
            </span>
          </div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider/60">
                <th className="text-left py-1 px-2 font-medium">Tenor</th>
                <th className="text-right py-1 px-2 font-medium">Nominal</th>
                <th className="text-right py-1 px-2 font-medium" style={{ color: realColor }}>
                  Real
                </th>
                <th className="text-right py-1 px-2 font-medium" style={{ color: beColor }}>
                  Breakeven
                </th>
              </tr>
            </thead>
            <tbody>
              {decomposition.map((r) => (
                <tr key={r.tenor} className="border-t border-terminal-border/20 hover:bg-white/[0.02]">
                  <td className="py-1.5 px-2 font-mono text-terminal-text font-semibold">{r.tenor}</td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text font-semibold">
                    {fmtPct(r.nominal)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums" style={{ color: realColor }}>
                    {fmtPct(r.real)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums" style={{ color: beColor }}>
                    {fmtPct(r.breakeven)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <span>
            Breakeven = market-implied average inflation (nominal minus TIPS real yield). Real yield = inflation-adjusted
            return on Treasuries.
          </span>
          <span className="text-terminal-dim whitespace-nowrap">5y5y fwd = the Fed's preferred inflation-expectations gauge.</span>
        </div>
      </div>
    </div>
  );
}
