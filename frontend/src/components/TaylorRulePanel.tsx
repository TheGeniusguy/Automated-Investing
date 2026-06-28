import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface TaylorHistoryPoint {
  date: string;
  taylor: number;
  balanced: number;
  inertial: number;
  actual: number;
}

interface TaylorInputs {
  core_pce_yoy: number;
  unrate: number;
  nairu: number;
  unemployment_gap: number;
  output_gap: number;
}

interface TaylorCurrent {
  actual: number;
  taylor: number;
  balanced: number;
  inertial: number;
  stance: string;
  gap_taylor: number;
  gap_balanced: number;
  gap_inertial: number;
  inputs: TaylorInputs;
}

interface TaylorParams {
  r_star: number;
  pi_target: number;
  okun_coef?: number;
  inertia?: number;
}

interface TaylorResponse {
  current: TaylorCurrent;
  history: TaylorHistoryPoint[];
  params: TaylorParams;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend sample story: the 2021-2022 inflation surge forces a fast hiking cycle,
// the funds rate plateaus near 4.4 while disinflation pulls the rule-implied
// paths lower, leaving policy mildly restrictive vs the balanced-approach rule.

const FALLBACK: TaylorResponse = (() => {
  const R_STAR = 0.5;
  const PI_TARGET = 2.0;
  const OKUN = 2.0;
  const INERTIA = 0.85;
  const n = 84;

  const today = new Date();
  const history: TaylorHistoryPoint[] = [];
  let prevInertial: number | null = null;

  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 1;
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (n - 1 - i), 1));

    const hump = Math.exp(-Math.pow(frac - 0.45, 2) / 0.02);
    let pi = 1.9 + 3.6 * hump * (1 - 0.55 * frac);
    pi = pi * (1 - frac) + (pi * 0.4 + 2.6 * 0.6) * frac;

    const unrate = Math.max(3.4, 3.9 + 0.5 * frac - 0.4 * hump);
    const nairu = 4.6 - 0.2 * frac;

    let actual: number;
    if (frac < 0.3) actual = 0.1;
    else if (frac < 0.55) actual = 0.1 + ((frac - 0.3) / 0.25) * 5.25;
    else actual = 5.35 - ((frac - 0.55) / 0.45) * (5.35 - 4.4);
    actual = Math.max(0.05, actual);

    const outGap = -OKUN * (unrate - nairu);
    const taylor = Math.max(0, R_STAR + pi + 0.5 * (pi - PI_TARGET) + 0.5 * outGap);
    const balanced = Math.max(0, R_STAR + pi + 0.5 * (pi - PI_TARGET) + 1.0 * outGap);
    const inertial: number =
      prevInertial === null ? taylor : INERTIA * prevInertial + (1 - INERTIA) * taylor;
    prevInertial = inertial;

    history.push({
      date: d.toISOString().slice(0, 10),
      taylor: Math.round(taylor * 1000) / 1000,
      balanced: Math.round(balanced * 1000) / 1000,
      inertial: Math.round(inertial * 1000) / 1000,
      actual: Math.round(actual * 1000) / 1000,
    });
  }

  // Pin the latest reading to published anchors.
  const last = history[history.length - 1];
  last.actual = 4.4;
  const pi = 2.6;
  const unrate = 4.1;
  const nairu = 4.4;
  const outGap = -OKUN * (unrate - nairu);
  last.taylor = Math.round((R_STAR + pi + 0.5 * (pi - PI_TARGET) + 0.5 * outGap) * 1000) / 1000;
  last.balanced = Math.round((R_STAR + pi + 0.5 * (pi - PI_TARGET) + 1.0 * outGap) * 1000) / 1000;

  const gapBalanced = last.actual - last.balanced;
  const stance = gapBalanced >= 0.5 ? "Restrictive" : gapBalanced <= -0.5 ? "Accommodative" : "Neutral";

  return {
    current: {
      actual: last.actual,
      taylor: last.taylor,
      balanced: last.balanced,
      inertial: last.inertial,
      stance,
      gap_taylor: Math.round((last.actual - last.taylor) * 1000) / 1000,
      gap_balanced: Math.round(gapBalanced * 1000) / 1000,
      gap_inertial: Math.round((last.actual - last.inertial) * 1000) / 1000,
      inputs: {
        core_pce_yoy: pi,
        unrate,
        nairu,
        unemployment_gap: Math.round((unrate - nairu) * 1000) / 1000,
        output_gap: Math.round(outGap * 1000) / 1000,
      },
    },
    history,
    params: { r_star: R_STAR, pi_target: PI_TARGET, okun_coef: OKUN, inertia: INERTIA },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Helpers

function fmtPct(v: number | null | undefined, signed = false): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function stanceClasses(stance: string): { text: string; pill: string } {
  if (stance === "Restrictive") return { text: "text-accent-red", pill: "bg-accent-red/15 text-accent-red border-accent-red/30" };
  if (stance === "Accommodative") return { text: "text-accent-green", pill: "bg-accent-green/15 text-accent-green border-accent-green/30" };
  return { text: "text-accent-amber", pill: "bg-accent-amber/15 text-accent-amber border-accent-amber/30" };
}

function gapColor(v: number | null | undefined): string {
  if (v == null) return "text-terminal-muted";
  if (v > 0) return "text-accent-red";   // actual above implied = restrictive
  if (v < 0) return "text-accent-green";
  return "text-terminal-muted";
}

function fmtMonth(iso: string): string {
  if (!iso) return "";
  const [y, m] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = parseInt(m, 10) - 1;
  return `${months[mi] ?? ""} '${y.slice(2)}`;
}

// SVG hero geometry

const VW = 1000;
const VH = 320;
const PAD = { top: 16, right: 16, bottom: 24, left: 16 };

const SERIES: { key: keyof TaylorHistoryPoint; label: string; stroke: string; dash?: string; width: number }[] = [
  { key: "actual", label: "Actual funds", stroke: "#c9785c", width: 2.25 },
  { key: "taylor", label: "Taylor (1993)", stroke: "#5b8fb0", width: 1.5 },
  { key: "balanced", label: "Balanced-approach", stroke: "#c9a23a", width: 1.5 },
  { key: "inertial", label: "Inertial", stroke: "#8a8170", width: 1.4, dash: "4 3" },
];

interface ChartGeom {
  lines: { stroke: string; width: number; dash?: string; d: string }[];
  gapBand: string;
  endDots: { cx: number; cy: number; stroke: string }[];
  yMin: number;
  yMax: number;
  ticks: { x: number; label: string }[];
  gridY: { y: number; label: string }[];
}

function buildGeom(history: TaylorHistoryPoint[]): ChartGeom {
  const n = history.length;
  const innerW = VW - PAD.left - PAD.right;
  const innerH = VH - PAD.top - PAD.bottom;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of history) {
    for (const s of SERIES) {
      const v = p[s.key] as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const padY = (hi - lo) * 0.08 || 1;
  const yMin = Math.max(0, lo - padY);
  const yMax = hi + padY;

  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const lineOf = (key: keyof TaylorHistoryPoint) =>
    history
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key] as number).toFixed(1)}`)
      .join(" ");

  const lines = SERIES.map((s) => ({ stroke: s.stroke, width: s.width, dash: s.dash, d: lineOf(s.key) }));

  // Gap band between actual and balanced-approach implied = the policy stance gap.
  const gapBand =
    `${lineOf("actual")} ` +
    history
      .map((p, i) => `L${x(i).toFixed(1)},${y(p.balanced).toFixed(1)}`)
      .reverse()
      .join(" ") +
    " Z";

  const endDots = SERIES.map((s) => ({
    cx: x(n - 1),
    cy: y(history[n - 1][s.key] as number),
    stroke: s.stroke,
  }));

  const ticks: { x: number; label: string }[] = [];
  const tickCount = 6;
  for (let t = 0; t < tickCount; t++) {
    const i = Math.round((t / (tickCount - 1)) * (n - 1));
    ticks.push({ x: x(i), label: fmtMonth(history[i].date) });
  }

  const gridY: { y: number; label: string }[] = [];
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const v = yMin + (g / gridCount) * (yMax - yMin);
    gridY.push({ y: y(v), label: `${v.toFixed(1)}%` });
  }

  return { lines, gapBand, endDots, yMin, yMax, ticks, gridY };
}

// Panel

export function TaylorRulePanel() {
  const [data, setData] = useState<TaylorResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/taylor-rule")
      .then((res) => res.json())
      .then((json: TaylorResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.history) && json.history.length > 4 && json.current) {
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

  const { current, history, params } = data;
  const geom = useMemo(() => buildGeom(history), [history]);
  const sc = stanceClasses(current.stance);
  const inp = current.inputs;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Taylor Rule / Policy Estimator</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi label="Actual Fed Funds" value={fmtPct(current.actual)} sub="Effective / target" accent="text-accent" emphasize />
          <Kpi label="Taylor (1993)" value={fmtPct(current.taylor)} sub={`Gap ${fmtPct(current.gap_taylor, true)}`} accent="text-accent-blue" subAccent={gapColor(current.gap_taylor)} />
          <Kpi label="Balanced-approach" value={fmtPct(current.balanced)} sub={`Gap ${fmtPct(current.gap_balanced, true)}`} accent="text-accent-amber" subAccent={gapColor(current.gap_balanced)} />
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1 justify-between">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Policy Stance</div>
            <div className="flex items-center gap-2">
              <span className={`pill border ${sc.pill} text-xs font-semibold uppercase tracking-wide`}>{current.stance}</span>
            </div>
            <div className="text-2xs text-terminal-dim font-mono tabular-nums">
              vs balanced {fmtPct(current.gap_balanced, true)}
            </div>
          </div>
        </div>

        {/* Hero chart */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <SectionLabel>Actual Funds vs Rule-Implied Policy Rate</SectionLabel>
            <div className="flex items-center gap-3 text-2xs flex-wrap">
              {SERIES.map((s) => (
                <LegendDot key={s.key} color={s.stroke} label={s.label} />
              ))}
            </div>
          </div>
          <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
            {/* gridlines + y labels */}
            {geom.gridY.map((g, i) => (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={VW - PAD.right}
                  y1={g.y}
                  y2={g.y}
                  className="stroke-terminal-divider"
                  strokeWidth={0.75}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
                <text x={PAD.left + 2} y={g.y - 3} className="fill-terminal-dim" style={{ fontSize: "10px" }}>
                  {g.label}
                </text>
              </g>
            ))}

            {/* stance gap band (actual vs balanced) */}
            <path d={geom.gapBand} className="fill-accent/[0.07]" />

            {/* series lines */}
            {geom.lines.map((ln, i) => (
              <path
                key={i}
                d={ln.d}
                fill="none"
                stroke={ln.stroke}
                strokeWidth={ln.width}
                strokeDasharray={ln.dash}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* end dots */}
            {geom.endDots.map((dot, i) => (
              <circle key={i} cx={dot.cx} cy={dot.cy} r={3} fill={dot.stroke} stroke="#ffffff" strokeWidth={0.5} />
            ))}

            {/* x ticks */}
            {geom.ticks.map((t, i) => (
              <text
                key={i}
                x={t.x}
                y={VH - 6}
                textAnchor={i === 0 ? "start" : i === geom.ticks.length - 1 ? "end" : "middle"}
                className="fill-terminal-dim"
                style={{ fontSize: "11px" }}
              >
                {t.label}
              </text>
            ))}
          </svg>
        </div>

        {/* Inputs row */}
        <div>
          <SectionLabel>Rule Inputs (current)</SectionLabel>
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3">
            <div className="flex items-stretch justify-between gap-2 flex-wrap">
              <InputCell label="Core PCE YoY" sublabel="inflation" value={fmtPct(inp.core_pce_yoy)} accent="text-accent-amber" />
              <InputCell label="Unemployment" sublabel="UNRATE" value={fmtPct(inp.unrate)} accent="text-terminal-text" />
              <InputCell label="NAIRU" sublabel="NROU" value={fmtPct(inp.nairu)} accent="text-terminal-text" />
              <InputCell label="Unemp. Gap" sublabel="u - u*" value={fmtPct(inp.unemployment_gap, true)} accent={gapColor(-inp.unemployment_gap)} />
              <InputCell label="Output Gap" sublabel="Okun proxy" value={fmtPct(inp.output_gap, true)} accent={gapColor(inp.output_gap)} />
              <InputCell label="Neutral Real r*" sublabel="assumed" value={fmtPct(params.r_star)} accent="text-terminal-muted" />
              <InputCell label="Inflation Target" sublabel="pi*" value={fmtPct(params.pi_target)} accent="text-terminal-muted" />
            </div>
          </div>
        </div>

        {/* Implied-rate comparison table */}
        <div>
          <SectionLabel>Rule-Implied vs Actual</SectionLabel>
          <table className="w-full text-sm border border-terminal-border/50 rounded overflow-hidden">
            <thead>
              <tr className="bg-terminal-bg text-2xs text-terminal-dim uppercase tracking-wider">
                <th className="text-left font-medium px-3 py-1.5">Rule</th>
                <th className="text-right font-medium px-3 py-1.5">Implied</th>
                <th className="text-right font-medium px-3 py-1.5">Actual</th>
                <th className="text-right font-medium px-3 py-1.5">Gap (act - imp)</th>
                <th className="text-right font-medium px-3 py-1.5">Reading</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              <RuleRow name="Taylor (1993)" implied={current.taylor} actual={current.actual} gap={current.gap_taylor} />
              <RuleRow name="Balanced-approach" implied={current.balanced} actual={current.actual} gap={current.gap_balanced} />
              <RuleRow name="Inertial (smoothed)" implied={current.inertial} actual={current.actual} gap={current.gap_inertial} />
            </tbody>
          </table>
        </div>

        {/* Plain-language footer */}
        <div className="text-2xs text-terminal-muted leading-relaxed border-t border-terminal-border/30 pt-2">
          The Taylor Rule estimates where the fed funds rate should sit given inflation and the
          output gap: it raises the prescribed rate when inflation runs above the 2% target or the
          economy runs hot, and lowers it when slack opens up. When the actual funds rate sits above
          the rule-implied rate (positive gap) policy is restrictive, leaning against growth and
          inflation; when it sits below (negative gap) policy is accommodative.
        </div>
      </div>
    </div>
  );
}

// Small components

function Kpi({
  label,
  value,
  sub,
  accent,
  subAccent,
  emphasize = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  subAccent?: string;
  emphasize?: boolean;
}) {
  return (
    <div className={`bg-terminal-bg border rounded p-2.5 flex flex-col gap-0.5 ${emphasize ? "border-accent/30" : "border-terminal-border/50"}`}>
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-2xl tabular-nums ${accent}`}>{value}</div>
      {sub && <div className={`text-2xs font-mono tabular-nums ${subAccent ?? "text-terminal-dim"}`}>{sub}</div>}
    </div>
  );
}

function InputCell({ label, sublabel, value, accent }: { label: string; sublabel: string; value: string; accent: string }) {
  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-[6rem]">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</div>
      <div className={`font-mono tabular-nums text-base ${accent}`}>{value}</div>
      <div className="text-2xs text-terminal-dim font-mono">{sublabel}</div>
    </div>
  );
}

function RuleRow({ name, implied, actual, gap }: { name: string; implied: number; actual: number; gap: number }) {
  const reading = gap >= 0.5 ? "Restrictive" : gap <= -0.5 ? "Accommodative" : "Neutral";
  const rc = stanceClasses(reading);
  return (
    <tr className="border-t border-terminal-border/30">
      <td className="px-3 py-1.5 font-sans text-terminal-text">{name}</td>
      <td className="px-3 py-1.5 text-right text-terminal-text">{fmtPct(implied)}</td>
      <td className="px-3 py-1.5 text-right text-terminal-muted">{fmtPct(actual)}</td>
      <td className={`px-3 py-1.5 text-right ${gapColor(gap)}`}>{fmtPct(gap, true)}</td>
      <td className={`px-3 py-1.5 text-right font-sans ${rc.text}`}>{reading}</td>
    </tr>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">{children}</div>;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className="w-3 h-0.5 rounded-sm inline-block" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
