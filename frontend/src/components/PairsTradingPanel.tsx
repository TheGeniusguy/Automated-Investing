import { useEffect, useMemo, useState } from "react";

// ── Local types (decoupled from shared types.ts) ──────────────────────────────
interface RatioPoint {
  date: string;
  ratio: number;
}
interface ZPoint {
  date: string;
  z: number;
}
interface PairsAnalysis {
  sym1: string;
  sym2: string;
  beta: number;
  correlation: number;
  half_life_days: number;
  z_score: number;
  coint_stat: number;
  cointegrated: boolean;
  signal: string;
  ratio_series: RatioPoint[];
  zscore_series: ZPoint[];
  data_mode: string;
  as_of: string;
  source: string;
}
interface ScreenRow {
  sym1: string;
  sym2: string;
  label: string;
  z_score: number;
  correlation: number;
  half_life_days: number;
  signal: string;
}
interface PairsScreen {
  pairs: ScreenRow[];
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
function buildFallbackZSeries(): ZPoint[] {
  const out: ZPoint[] = [];
  const start = new Date("2025-07-01").getTime();
  for (let i = 0; i < 120; i++) {
    const t = i / 119;
    const z =
      1.9 * Math.sin(t * Math.PI * 2.3) +
      0.8 * Math.sin(t * Math.PI * 6.1) +
      0.35 * Math.cos(t * Math.PI * 11);
    const d = new Date(start + i * 86400000 * 1.4);
    out.push({ date: d.toISOString().slice(0, 10), z: Number(z.toFixed(3)) });
  }
  return out;
}
const FALLBACK_Z = buildFallbackZSeries();

const FALLBACK_ANALYSIS: PairsAnalysis = {
  sym1: "KO",
  sym2: "PEP",
  beta: 0.84,
  correlation: 0.71,
  half_life_days: 18.4,
  z_score: FALLBACK_Z[FALLBACK_Z.length - 1].z,
  coint_stat: -3.12,
  cointegrated: true,
  signal:
    FALLBACK_Z[FALLBACK_Z.length - 1].z >= 2
      ? "Short spread (sell KO/buy PEP)"
      : FALLBACK_Z[FALLBACK_Z.length - 1].z <= -2
        ? "Long spread (buy KO/sell PEP)"
        : "Neutral",
  ratio_series: FALLBACK_Z.map((p) => ({ date: p.date, ratio: 0.36 + p.z * 0.004 })),
  zscore_series: FALLBACK_Z,
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "sample (deterministic)",
};

const FALLBACK_SCREEN: PairsScreen = {
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "sample (deterministic)",
  pairs: [
    { sym1: "KO", sym2: "PEP", label: "Beverages", z_score: 2.31, correlation: 0.71, half_life_days: 18.4, signal: "Short spread (sell KO/buy PEP)" },
    { sym1: "GS", sym2: "MS", label: "Investment Banks", z_score: -2.18, correlation: 0.83, half_life_days: 12.6, signal: "Long spread (buy GS/sell MS)" },
    { sym1: "HD", sym2: "LOW", label: "Home Improvement", z_score: 1.74, correlation: 0.88, half_life_days: 9.2, signal: "Neutral" },
    { sym1: "V", sym2: "MA", label: "Card Networks", z_score: 1.42, correlation: 0.91, half_life_days: 14.1, signal: "Neutral" },
    { sym1: "WMT", sym2: "TGT", label: "Big-Box Retail", z_score: -1.21, correlation: 0.64, half_life_days: 22.7, signal: "Neutral" },
    { sym1: "XOM", sym2: "CVX", label: "Integrated Energy", z_score: 0.88, correlation: 0.86, half_life_days: 16.3, signal: "Neutral" },
    { sym1: "AAPL", sym2: "MSFT", label: "Mega-Cap Tech", z_score: -0.63, correlation: 0.79, half_life_days: 27.5, signal: "Neutral" },
    { sym1: "UPS", sym2: "FDX", label: "Parcel Logistics", z_score: 0.41, correlation: 0.74, half_life_days: 31.0, signal: "Neutral" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function zColor(z: number): string {
  if (z >= 2) return "text-accent-red";
  if (z <= -2) return "text-accent-green";
  return "text-terminal-text";
}
function signalTone(signal: string): string {
  if (signal.startsWith("Short")) return "text-accent-red border-accent-red/40 bg-accent-red/10";
  if (signal.startsWith("Long")) return "text-accent-green border-accent-green/40 bg-accent-green/10";
  return "text-terminal-muted border-terminal-divider bg-terminal-bg";
}
function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "-";
}

// ── Z-score spread chart (inline SVG with +/-2 and 0 bands) ───────────────────
function ZSpreadChart({ series }: { series: ZPoint[] }) {
  const W = 760;
  const H = 220;
  const PAD_L = 34;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 20;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { path, points, yFor, xFor, domain } = useMemo(() => {
    const zs = series.map((p) => p.z);
    const maxAbs = Math.max(3, ...zs.map((v) => Math.abs(v)));
    const lo = -maxAbs;
    const hi = maxAbs;
    const xFor = (i: number) =>
      PAD_L + (series.length <= 1 ? 0 : (i / (series.length - 1)) * innerW);
    const yFor = (v: number) => PAD_T + ((hi - v) / (hi - lo)) * innerH;
    const path = series
      .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.z).toFixed(1)}`)
      .join(" ");
    return { path, points: series, yFor, xFor, domain: { lo, hi } };
  }, [series, innerW, innerH]);

  const y0 = yFor(0);
  const yPos2 = yFor(2);
  const yNeg2 = yFor(-2);
  const yTop = yFor(domain.hi);
  const yBot = yFor(domain.lo);
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Spread z-score time series"
    >
      {/* entry zones: shade |z| >= 2 */}
      <rect x={PAD_L} y={yTop} width={innerW} height={Math.max(0, yPos2 - yTop)} fill="#f87171" opacity="0.07" />
      <rect x={PAD_L} y={yNeg2} width={innerW} height={Math.max(0, yBot - yNeg2)} fill="#34d399" opacity="0.07" />

      {/* reference bands */}
      {[
        { y: yPos2, label: "+2", color: "#f87171" },
        { y: y0, label: "0", color: "#6b7280" },
        { y: yNeg2, label: "-2", color: "#34d399" },
      ].map((b) => (
        <g key={b.label}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={b.y}
            y2={b.y}
            stroke={b.color}
            strokeWidth={b.label === "0" ? 1 : 1}
            strokeDasharray={b.label === "0" ? "0" : "4 3"}
            opacity={b.label === "0" ? 0.5 : 0.7}
          />
          <text x={4} y={b.y + 3} className="fill-terminal-dim font-mono" fontSize="9">
            {b.label}
          </text>
        </g>
      ))}

      {/* spread path */}
      <path d={path} fill="none" stroke="#d97757" strokeWidth="1.6" />

      {/* last marker */}
      {last && (
        <circle
          cx={xFor(points.length - 1)}
          cy={yFor(last.z)}
          r="3"
          fill={last.z >= 2 ? "#f87171" : last.z <= -2 ? "#34d399" : "#d97757"}
        />
      )}
    </svg>
  );
}

// ── KPI cell ──────────────────────────────────────────────────────────────────
function Kpi({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 border-r border-terminal-divider last:border-r-0">
      <span className="text-[10px] uppercase tracking-wide text-terminal-dim">{label}</span>
      <div className="leading-none">{children}</div>
      {hint && <span className="text-[10px] text-terminal-dim">{hint}</span>}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export function PairsTradingPanel() {
  const [sym1, setSym1] = useState("KO");
  const [sym2, setSym2] = useState("PEP");
  const [analysis, setAnalysis] = useState<PairsAnalysis>(FALLBACK_ANALYSIS);
  const [screen, setScreen] = useState<PairsScreen>(FALLBACK_SCREEN);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runAnalyze = (a: string, b: string) => {
    const s1 = a.trim().toUpperCase() || "KO";
    const s2 = b.trim().toUpperCase() || "PEP";
    setLoading(true);
    setErr(null);
    fetch(`/api/pairs/${encodeURIComponent(s1)}/${encodeURIComponent(s2)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: PairsAnalysis) => {
        if (data && Array.isArray(data.zscore_series)) setAnalysis(data);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  // initial loads
  useEffect(() => {
    runAnalyze("KO", "PEP");
    fetch("/api/pairs-screen")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: PairsScreen) => {
        if (data && Array.isArray(data.pairs) && data.pairs.length) setScreen(data);
      })
      .catch(() => {
        /* keep fallback */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const a = analysis;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>PAIRS / RELATIVE VALUE</span>
        <span className="text-[10px] font-mono text-terminal-dim normal-case tracking-normal">
          {a.data_mode === "live" ? "LIVE" : "SAMPLE"} - {a.source}
        </span>
      </div>

      <div className="panel-body flex-1 overflow-auto flex flex-col gap-3 p-3">
        {/* controls */}
        <form
          className="flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            runAnalyze(sym1, sym2);
          }}
        >
          <input
            value={sym1}
            onChange={(e) => setSym1(e.target.value)}
            spellCheck={false}
            className="w-24 px-2 py-1 font-mono text-sm uppercase bg-terminal-bg border border-terminal-border rounded text-terminal-text focus:border-accent outline-none"
            aria-label="Symbol 1"
          />
          <span className="text-terminal-dim font-mono">/</span>
          <input
            value={sym2}
            onChange={(e) => setSym2(e.target.value)}
            spellCheck={false}
            className="w-24 px-2 py-1 font-mono text-sm uppercase bg-terminal-bg border border-terminal-border rounded text-terminal-text focus:border-accent outline-none"
            aria-label="Symbol 2"
          />
          <button
            type="submit"
            className="px-3 py-1 text-xs font-medium rounded border border-accent/50 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {loading ? "Loading..." : "Analyze"}
          </button>
          <span className="ml-auto text-[11px] font-mono text-terminal-dim">
            {a.sym1} vs {a.sym2}
          </span>
        </form>

        {err && (
          <div className="text-[11px] text-accent-amber font-mono">
            Live fetch failed ({err}); showing last good data.
          </div>
        )}

        {/* KPI strip */}
        <div className="flex flex-wrap items-stretch border border-terminal-border rounded-panel bg-terminal-panel">
          <Kpi label="Z-Score">
            <span className={`stat-figure text-2xl ${zColor(a.z_score)}`}>
              {a.z_score > 0 ? "+" : ""}
              {fmt(a.z_score, 2)}
            </span>
          </Kpi>
          <Kpi label="Correlation" hint="daily returns">
            <span className="font-mono tabular-nums text-lg text-terminal-text">
              {fmt(a.correlation, 2)}
            </span>
          </Kpi>
          <Kpi label="Hedge Ratio" hint="beta (log)">
            <span className="font-mono tabular-nums text-lg text-terminal-text">
              {fmt(a.beta, 3)}
            </span>
          </Kpi>
          <Kpi label="Half-life" hint="days to revert">
            <span className="font-mono tabular-nums text-lg text-terminal-text">
              {fmt(a.half_life_days, 1)}
            </span>
          </Kpi>
          <Kpi label="Cointegrated" hint={`stat ${fmt(a.coint_stat, 2)} (heuristic)`}>
            <span
              className={`pill ${a.cointegrated ? "text-accent-green border-accent-green/40 bg-accent-green/10" : "text-terminal-muted border-terminal-divider"}`}
            >
              {a.cointegrated ? "YES" : "NO"}
            </span>
          </Kpi>
          <div className="flex flex-col gap-0.5 px-3 py-2 justify-center flex-1 min-w-[180px]">
            <span className="text-[10px] uppercase tracking-wide text-terminal-dim">Signal</span>
            <span className={`pill self-start text-xs ${signalTone(a.signal)}`}>{a.signal}</span>
          </div>
        </div>

        {/* spread z-score chart */}
        <div className="border border-terminal-border rounded-panel bg-terminal-panel p-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-medium text-terminal-muted">
              Spread Z-Score - {a.sym1} vs {a.sym2}
            </span>
            <span className="text-[10px] font-mono text-terminal-dim">
              shaded = entry zones (|z| &gt;= 2)
            </span>
          </div>
          <ZSpreadChart series={a.zscore_series.length ? a.zscore_series : FALLBACK_Z} />
        </div>

        {/* pairs screen table */}
        <div className="border border-terminal-border rounded-panel bg-terminal-panel overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-terminal-divider">
            <span className="text-[11px] font-medium text-terminal-muted uppercase tracking-wide">
              Pairs Screen
            </span>
            <span className="text-[10px] font-mono text-terminal-dim">
              sorted by |z| - {screen.pairs.length} pairs
            </span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-terminal-dim border-b border-terminal-divider">
                <th className="text-left font-medium px-3 py-1.5">Pair</th>
                <th className="text-left font-medium px-3 py-1.5">Sector</th>
                <th className="text-right font-medium px-3 py-1.5">Z</th>
                <th className="text-right font-medium px-3 py-1.5">Corr</th>
                <th className="text-right font-medium px-3 py-1.5">Half-life</th>
                <th className="text-left font-medium px-3 py-1.5">Signal</th>
              </tr>
            </thead>
            <tbody>
              {screen.pairs.map((r) => {
                const hot = Math.abs(r.z_score) >= 2;
                return (
                  <tr
                    key={`${r.sym1}-${r.sym2}`}
                    className={`border-b border-terminal-divider/60 last:border-0 cursor-pointer hover:bg-terminal-bg/60 ${hot ? "bg-accent-amber/5" : ""}`}
                    onClick={() => {
                      setSym1(r.sym1);
                      setSym2(r.sym2);
                      runAnalyze(r.sym1, r.sym2);
                    }}
                  >
                    <td className="px-3 py-1.5 font-mono text-terminal-text whitespace-nowrap">
                      {r.sym1}/{r.sym2}
                    </td>
                    <td className="px-3 py-1.5 text-terminal-muted whitespace-nowrap">{r.label}</td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums font-medium ${zColor(r.z_score)}`}>
                      {r.z_score > 0 ? "+" : ""}
                      {fmt(r.z_score, 2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-muted">
                      {fmt(r.correlation, 2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-terminal-muted">
                      {fmt(r.half_life_days, 1)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`pill text-[10px] ${signalTone(r.signal)}`}>
                        {r.signal.startsWith("Short")
                          ? "Short"
                          : r.signal.startsWith("Long")
                            ? "Long"
                            : "Neutral"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* footer legend */}
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-terminal-dim font-mono mt-auto pt-1">
          <span>
            <span className="text-accent-green">Long</span> = buy {a.sym1}/sell {a.sym2} (z &lt;= -2)
          </span>
          <span>
            <span className="text-accent-red">Short</span> = sell {a.sym1}/buy {a.sym2} (z &gt;= +2)
          </span>
          <span className="ml-auto">cointegration is a heuristic ADF proxy, not a formal test</span>
        </div>
      </div>
    </div>
  );
}
