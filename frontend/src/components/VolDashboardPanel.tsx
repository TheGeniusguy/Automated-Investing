import { useEffect, useState, type ReactNode } from "react";

// ── Local mirror of the backend vol_dashboard.py payload ──────────────────────
interface TermPoint {
  tenor: string;
  days: number;
  level: number;
}

interface VixHistoryPoint {
  date: string;
  vix: number;
}

interface Gauge {
  label: string;
  value: number;
  note: string;
}

interface VolDashboard {
  vix: number;
  vix_change: number;
  realized_vol_20d: number;
  vol_risk_premium: number;
  term_structure: TermPoint[];
  structure_state: string;
  move_index: number;
  skew_index: number;
  put_call_ratio: number;
  regime: string;
  vix_history: VixHistoryPoint[];
  gauges: Gauge[];
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Local fallback so the panel is never an empty box ─────────────────────────
function buildFallbackHistory(): VixHistoryPoint[] {
  const out: VixHistoryPoint[] = [];
  const base = 18.9;
  let lvl = base;
  const start = new Date("2026-04-02");
  for (let i = 0; i < 60; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    // deterministic-ish gentle mean reversion toward 17.4
    lvl += (17.4 - lvl) * 0.08 + Math.sin(i / 4) * 0.45;
    out.push({ date: d.toISOString().slice(0, 10), vix: Math.round(lvl * 100) / 100 });
  }
  out[out.length - 1].vix = 17.4;
  return out;
}

const FALLBACK: VolDashboard = {
  vix: 17.4,
  vix_change: -0.7,
  realized_vol_20d: 12.8,
  vol_risk_premium: 4.6,
  term_structure: [
    { tenor: "VIX9D", days: 9, level: 15.8 },
    { tenor: "VIX", days: 30, level: 17.4 },
    { tenor: "VIX3M", days: 90, level: 19.3 },
    { tenor: "VIX6M", days: 180, level: 20.2 },
  ],
  structure_state: "contango",
  move_index: 92.5,
  skew_index: 141.0,
  put_call_ratio: 0.92,
  regime: "Normal",
  vix_history: buildFallbackHistory(),
  gauges: [
    { label: "MOVE Index", value: 92.5, note: "Bond market vol (Treasuries)" },
    { label: "SKEW Index", value: 141.0, note: "Tail-risk / crash hedging demand" },
    { label: "Put/Call Ratio", value: 0.92, note: "Equity options positioning" },
  ],
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "generated-sample",
};

// ── Regime color mapping ──────────────────────────────────────────────────────
const REGIME_STYLE: Record<string, { text: string; bg: string; border: string }> = {
  Calm: { text: "text-accent-green", bg: "bg-accent-green/10", border: "border-accent-green/40" },
  Normal: { text: "text-accent-blue", bg: "bg-accent-blue/10", border: "border-accent-blue/40" },
  Elevated: { text: "text-accent-amber", bg: "bg-accent-amber/10", border: "border-accent-amber/40" },
  Stressed: { text: "text-accent-red", bg: "bg-accent-red/10", border: "border-accent-red/40" },
};

function regimeStyle(regime: string) {
  return REGIME_STYLE[regime] ?? REGIME_STYLE.Normal;
}

export function VolDashboardPanel() {
  const [data, setData] = useState<VolDashboard>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/vol-dashboard")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: VolDashboard) => {
        if (alive && d && typeof d.vix === "number" && Array.isArray(d.term_structure)) {
          setData(d);
        }
        if (alive) setLoading(false);
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const rs = regimeStyle(data.regime);
  const changeUp = data.vix_change > 0;
  const changeColor =
    data.vix_change > 0 ? "text-accent-red" : data.vix_change < 0 ? "text-accent-green" : "text-terminal-muted";
  const vrpPositive = data.vol_risk_premium >= 0;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Volatility &amp; Risk Dashboard</span>
        <div className="flex items-center gap-3 text-2xs text-terminal-muted normal-case tracking-normal">
          <span className="uppercase tracking-wider">{data.structure_state}</span>
          <span className={`pill ${rs.bg} ${rs.text} ${rs.border} border`}>{data.regime}</span>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {err && (
          <div className="text-2xs text-terminal-dim">
            Showing sample snapshot. Live fetch unavailable.
          </div>
        )}
        {loading && (
          <div className="text-terminal-dim text-xs py-1">Loading volatility snapshot...</div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <KpiCard
            label="VIX (Spot)"
            figureClass={`${rs.text}`}
            value={data.vix.toFixed(2)}
            sub={
              <span className={`text-2xs font-mono tabular-nums ${changeColor}`}>
                {changeUp ? "+" : ""}
                {data.vix_change.toFixed(2)} 1D
              </span>
            }
            highlight={`${rs.bg} ${rs.border} border`}
          />
          <KpiCard
            label="Realized Vol 20d"
            value={data.realized_vol_20d.toFixed(1)}
            unit="%"
            sub={<span className="text-2xs text-terminal-dim">SPY, annualized</span>}
          />
          <KpiCard
            label="Vol Risk Premium"
            figureClass={vrpPositive ? "text-accent-green" : "text-accent-red"}
            value={`${vrpPositive ? "+" : ""}${data.vol_risk_premium.toFixed(2)}`}
            sub={<span className="text-2xs text-terminal-dim">Implied minus realized</span>}
          />
          <RegimeCard regime={data.regime} style={rs} vix={data.vix} />
        </div>

        {/* Term structure + sparkline */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
          <TermStructureChart term={data.term_structure} state={data.structure_state} />
          <VixSparkline history={data.vix_history} regimeColor={rs.text} />
        </div>

        {/* Gauges grid */}
        <GaugesGrid gauges={data.gauges} />

        <Legend />
      </div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({
  label,
  value,
  unit,
  sub,
  figureClass,
  highlight,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  figureClass?: string;
  highlight?: string;
}) {
  return (
    <div
      className={`bg-terminal-bg rounded-panel p-3 flex flex-col gap-1 ${
        highlight ?? "border border-terminal-border/50"
      }`}
    >
      <div className="text-2xs text-terminal-muted uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-3xl leading-none ${figureClass ?? "text-terminal-text"}`}>
        {value}
        {unit && <span className="text-lg text-terminal-muted ml-0.5">{unit}</span>}
      </div>
      {sub}
    </div>
  );
}

function RegimeCard({
  regime,
  style,
  vix,
}: {
  regime: string;
  style: { text: string; bg: string; border: string };
  vix: number;
}) {
  return (
    <div className={`rounded-panel p-3 flex flex-col gap-1 ${style.bg} ${style.border} border`}>
      <div className="text-2xs text-terminal-muted uppercase tracking-wider">Vol Regime</div>
      <div className={`stat-figure text-3xl leading-none ${style.text}`}>{regime}</div>
      <span className="text-2xs text-terminal-dim font-mono tabular-nums">
        VIX {vix.toFixed(1)} basis
      </span>
    </div>
  );
}

// ── Term structure SVG curve ──────────────────────────────────────────────────
function TermStructureChart({ term, state }: { term: TermPoint[]; state: string }) {
  const W = 320;
  const H = 150;
  const padL = 36;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const levels = term.map((t) => t.level);
  const maxDays = Math.max(...term.map((t) => t.days), 1);
  const minLvl = Math.min(...levels);
  const maxLvl = Math.max(...levels);
  const span = Math.max(maxLvl - minLvl, 0.5);
  const yPad = span * 0.25;
  const lo = minLvl - yPad;
  const hi = maxLvl + yPad;

  const x = (days: number) => padL + (days / maxDays) * plotW;
  const y = (lvl: number) => padT + (1 - (lvl - lo) / (hi - lo)) * plotH;

  const pts = term.map((t) => ({ ...t, cx: x(t.days), cy: y(t.level) }));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(" ");
  const area = `${path} L ${pts[pts.length - 1].cx.toFixed(1)} ${padT + plotH} L ${pts[0].cx.toFixed(1)} ${
    padT + plotH
  } Z`;

  const stateColor =
    state === "contango" ? "text-accent-green" : state === "backwardation" ? "text-accent-red" : "text-terminal-muted";
  const strokeClass =
    state === "backwardation" ? "text-accent-red" : state === "contango" ? "text-accent-green" : "text-accent-blue";

  const yTicks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];

  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3 flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <div className="text-2xs text-terminal-muted uppercase tracking-wider">VIX Term Structure</div>
        <div className={`text-2xs uppercase tracking-wider font-mono ${stateColor}`}>{state}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={`w-full ${strokeClass}`} preserveAspectRatio="xMidYMid meet">
        {/* gridlines + y labels */}
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(tv)}
              y2={y(tv)}
              className="stroke-terminal-border/40"
              strokeWidth={0.5}
            />
            <text x={padL - 5} y={y(tv) + 3} textAnchor="end" className="fill-terminal-dim" fontSize={8}>
              {tv.toFixed(1)}
            </text>
          </g>
        ))}
        {/* area + line */}
        <path d={area} fill="currentColor" opacity={0.08} />
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" />
        {/* points + labels */}
        {pts.map((p) => (
          <g key={p.tenor}>
            <circle cx={p.cx} cy={p.cy} r={2.6} fill="currentColor" />
            <text
              x={p.cx}
              y={p.cy - 7}
              textAnchor="middle"
              className="fill-terminal-text font-mono"
              fontSize={8}
            >
              {p.level.toFixed(1)}
            </text>
            <text x={p.cx} y={H - 8} textAnchor="middle" className="fill-terminal-muted" fontSize={8}>
              {p.tenor}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── VIX history sparkline ─────────────────────────────────────────────────────
function VixSparkline({ history, regimeColor }: { history: VixHistoryPoint[]; regimeColor: string }) {
  const W = 320;
  const H = 150;
  const padT = 14;
  const padB = 22;
  const padX = 6;
  const plotH = H - padT - padB;
  const plotW = W - padX * 2;

  const vals = history.map((h) => h.vix);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 0.5);
  const n = history.length;

  const x = (i: number) => padX + (i / Math.max(n - 1, 1)) * plotW;
  const y = (v: number) => padT + (1 - (v - lo) / span) * plotH;

  const path = history.map((h, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(h.vix).toFixed(1)}`).join(" ");
  const area = `${path} L ${x(n - 1).toFixed(1)} ${padT + plotH} L ${x(0).toFixed(1)} ${padT + plotH} Z`;

  const last = vals[n - 1];
  const first = vals[0];
  const upOverWindow = last > first;

  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3 flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <div className="text-2xs text-terminal-muted uppercase tracking-wider">VIX 60-Day History</div>
        <div className="flex items-center gap-2 text-2xs font-mono tabular-nums">
          <span className="text-terminal-dim">L {lo.toFixed(1)}</span>
          <span className="text-terminal-dim">H {hi.toFixed(1)}</span>
          <span className={upOverWindow ? "text-accent-red" : "text-accent-green"}>
            {last.toFixed(1)}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={`w-full ${regimeColor}`} preserveAspectRatio="none">
        <path d={area} fill="currentColor" opacity={0.08} />
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
        <circle cx={x(n - 1)} cy={y(last)} r={2.6} fill="currentColor" />
      </svg>
      <div className="flex justify-between text-2xs text-terminal-dim mt-1 font-mono">
        <span>{history[0]?.date.slice(5)}</span>
        <span>{history[n - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

// ── Gauges grid ───────────────────────────────────────────────────────────────
function GaugesGrid({ gauges }: { gauges: Gauge[] }) {
  return (
    <div>
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1.5">Cross-Asset Vol Gauges</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {gauges.map((g) => (
          <div
            key={g.label}
            className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3 flex flex-col gap-1"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-2xs text-terminal-muted uppercase tracking-wider">{g.label}</span>
            </div>
            <div className="stat-figure text-2xl leading-none text-terminal-text font-mono tabular-nums">
              {typeof g.value === "number" ? g.value.toFixed(g.value < 10 ? 2 : 1) : g.value}
            </div>
            <div className="text-2xs text-terminal-dim">{g.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-terminal-dim pt-1 border-t border-terminal-divider">
      <span>
        <span className="text-accent-green">Contango</span> = upward term curve (calm)
      </span>
      <span>
        <span className="text-accent-red">Backwardation</span> = inverted (stress)
      </span>
      <span>
        VRP = implied (VIX) minus realized vol; positive = vol sellers paid
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span className="text-accent-green">Calm</span>
        <span className="text-accent-blue">Normal</span>
        <span className="text-accent-amber">Elevated</span>
        <span className="text-accent-red">Stressed</span>
      </span>
    </div>
  );
}
