import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface LiquidityPoint {
  date: string;
  walcl: number;
  tga: number;
  rrp: number;
  net_liquidity: number;
}

interface LiquidityCurrent {
  net_liquidity: number;
  walcl: number;
  tga: number;
  rrp: number;
  reserves: number | null;
}

interface LiquidityChanges {
  chg_1m: number | null;
  chg_3m: number | null;
  chg_6m: number | null;
  chg_1y: number | null;
}

interface NetLiquidityResponse {
  series: LiquidityPoint[];
  current: LiquidityCurrent;
  changes: LiquidityChanges;
  qt_pace_b_per_month: number;
  unit: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline.
// Mirrors the backend sample story: QT runoff in WALCL, the great RRP drain,
// TGA oscillating around refunding cycles. Levels land near WALCL ~6.7T,
// TGA ~0.7T, RRP ~0.4T, net liquidity ~5.6T (all $B).

const FALLBACK: NetLiquidityResponse = (() => {
  const series: LiquidityPoint[] = [];
  const n = 132;
  const today = new Date();
  // snap to most recent Wednesday
  const wed = new Date(today);
  wed.setUTCDate(wed.getUTCDate() - ((wed.getUTCDay() + 4) % 7));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(wed);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const frac = (n - 1 - i) / (n - 1);
    const wobble = Math.sin(frac * 41 + 1.3);
    const walcl = 8400 - 1700 * frac + 18 * wobble;
    const rrp = Math.max(18, 400 + 1700 * Math.pow(1 - frac, 1.7) + 14 * Math.sin(frac * 33));
    const tga = Math.max(120, 650 + 130 * Math.sin(frac * 9 + 0.6) + 22 * Math.sin(frac * 50));
    const net = walcl - tga - rrp;
    series.push({
      date: d.toISOString().slice(0, 10),
      walcl: Math.round(walcl * 10) / 10,
      tga: Math.round(tga * 10) / 10,
      rrp: Math.round(rrp * 10) / 10,
      net_liquidity: Math.round(net * 10) / 10,
    });
  }
  const last = series[series.length - 1];
  return {
    series,
    current: {
      net_liquidity: last.net_liquidity,
      walcl: last.walcl,
      tga: last.tga,
      rrp: last.rrp,
      reserves: Math.round((last.net_liquidity * 0.585 + 50) * 10) / 10,
    },
    changes: { chg_1m: 4.2, chg_3m: -41.0, chg_6m: -150.0, chg_1y: -296.0 },
    qt_pace_b_per_month: -57.0,
    unit: "$B",
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Helpers

function fmtTrillions(b: number | null | undefined): string {
  if (b == null) return "--";
  return `$${(b / 1000).toFixed(2)}T`;
}

function fmtB(b: number | null | undefined, signed = false): string {
  if (b == null) return "--";
  const sign = signed && b > 0 ? "+" : "";
  const abs = Math.abs(b);
  if (abs >= 1000) return `${sign}$${(b / 1000).toFixed(2)}T`;
  return `${sign}$${b.toFixed(1)}B`;
}

function changeColor(v: number | null | undefined): string {
  if (v == null) return "text-terminal-muted";
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
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
const VH = 300;
const PAD = { top: 14, right: 14, bottom: 22, left: 14 };

interface ChartGeom {
  netPath: string;
  walclPath: string;
  drainArea: string;
  netArea: string;
  recentPath: string;
  yMin: number;
  yMax: number;
  ticks: { x: number; label: string }[];
  gridY: number[];
}

function buildGeom(series: LiquidityPoint[]): ChartGeom {
  const n = series.length;
  const innerW = VW - PAD.left - PAD.right;
  const innerH = VH - PAD.top - PAD.bottom;

  const nets = series.map((p) => p.net_liquidity);
  const walcls = series.map((p) => p.walcl);
  const lo = Math.min(...nets);
  const hi = Math.max(...walcls);
  const padY = (hi - lo) * 0.08 || 1;
  const yMin = lo - padY;
  const yMax = hi + padY;

  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const lineOf = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const netPath = lineOf(nets);
  const walclPath = lineOf(walcls);

  // Area between WALCL (upper) and net liquidity (lower) = the drains (TGA + RRP).
  const drainArea =
    `${lineOf(walcls)} ` +
    series.map((p, i) => `L${x(i).toFixed(1)},${y(p.net_liquidity).toFixed(1)}`).reverse().join(" ") +
    " Z";

  // Net-liquidity fill down to baseline.
  const baseY = PAD.top + innerH;
  const netArea = `${netPath} L${x(n - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  // Recent-trend highlight: last ~13 weeks (a quarter).
  const recentStart = Math.max(0, n - 13);
  const recentPath = nets
    .slice(recentStart)
    .map((v, k) => `${k === 0 ? "M" : "L"}${x(recentStart + k).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");

  // X ticks: ~5 evenly spaced.
  const ticks: { x: number; label: string }[] = [];
  const tickCount = 5;
  for (let t = 0; t < tickCount; t++) {
    const i = Math.round((t / (tickCount - 1)) * (n - 1));
    ticks.push({ x: x(i), label: fmtMonth(series[i].date) });
  }

  // Horizontal gridlines at 3 levels.
  const gridY = [0.25, 0.5, 0.75].map((f) => PAD.top + f * innerH);

  return { netPath, walclPath, drainArea, netArea, recentPath, yMin, yMax, ticks, gridY };
}

// Panel

export function NetLiquidityPanel() {
  const [data, setData] = useState<NetLiquidityResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/net-liquidity")
      .then((res) => res.json())
      .then((json: NetLiquidityResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.series) && json.series.length > 4) {
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

  const { series, current, changes, qt_pace_b_per_month } = data;
  const geom = useMemo(() => buildGeom(series), [series]);

  const drainsTotal = current.tga + current.rrp;
  const qtNegative = qt_pace_b_per_month <= 0;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Fed Net Liquidity</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-0.5">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Net Liquidity</div>
            <div className="stat-figure text-2xl tabular-nums text-terminal-text">{fmtTrillions(current.net_liquidity)}</div>
            <div className="text-2xs text-terminal-dim font-mono tabular-nums">{fmtB(current.net_liquidity)}</div>
          </div>
          <Kpi
            label="Change (3M)"
            value={fmtB(changes.chg_3m, true)}
            sub="Liquidity impulse"
            accent={changeColor(changes.chg_3m)}
          />
          <Kpi
            label="QT Runoff Pace"
            value={`${fmtB(qt_pace_b_per_month, true)}/mo`}
            sub={qtNegative ? "Balance sheet shrinking" : "Balance sheet growing"}
            accent={qtNegative ? "text-accent-red" : "text-accent-green"}
          />
          <Kpi
            label="Bank Reserves"
            value={fmtTrillions(current.reserves)}
            sub="WRESBAL"
            accent="text-accent-blue"
          />
        </div>

        {/* Hero chart */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <SectionLabel>Net Liquidity vs Fed Total Assets</SectionLabel>
            <div className="flex items-center gap-3 text-2xs">
              <LegendDot cls="bg-accent" label="Net liquidity" />
              <LegendDot cls="bg-terminal-muted/50" label="Fed assets (WALCL)" />
              <LegendDot cls="bg-accent-amber/30" label="Drains (TGA + RRP)" />
            </div>
          </div>
          <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
            <defs>
              <linearGradient id="nl-net-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c9785c" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#c9785c" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* gridlines */}
            {geom.gridY.map((gy, i) => (
              <line
                key={i}
                x1={PAD.left}
                x2={VW - PAD.right}
                y1={gy}
                y2={gy}
                className="stroke-terminal-divider"
                strokeWidth={0.75}
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* drain band: between WALCL and net liquidity */}
            <path d={geom.drainArea} className="fill-accent-amber/15" />

            {/* net liquidity fill */}
            <path d={geom.netArea} fill="url(#nl-net-fill)" />

            {/* WALCL faint upper line */}
            <path
              d={geom.walclPath}
              fill="none"
              className="stroke-terminal-muted/50"
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />

            {/* net liquidity main line */}
            <path
              d={geom.netPath}
              fill="none"
              className="stroke-accent"
              strokeWidth={1.75}
              vectorEffect="non-scaling-stroke"
            />

            {/* recent-trend highlight (last quarter) */}
            <path
              d={geom.recentPath}
              fill="none"
              className="stroke-accent"
              strokeWidth={3}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />

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

        {/* Decomposition row */}
        <div>
          <SectionLabel>Liquidity Decomposition (current)</SectionLabel>
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3">
            <div className="flex items-stretch justify-between gap-2 flex-wrap">
              <DecompCell label="Fed Total Assets" sublabel="WALCL" value={fmtTrillions(current.walcl)} accent="text-terminal-text" />
              <Operator sign="minus" />
              <DecompCell label="Treasury Account" sublabel="TGA" value={fmtTrillions(current.tga)} accent="text-accent-amber" />
              <Operator sign="minus" />
              <DecompCell label="Reverse Repo" sublabel="RRP" value={fmtTrillions(current.rrp)} accent="text-accent-amber" />
              <Operator sign="equals" />
              <DecompCell label="Net Liquidity" sublabel="FARBAST" value={fmtTrillions(current.net_liquidity)} accent="text-accent" emphasize />
            </div>
            <div className="mt-2 pt-2 border-t border-terminal-border/30 flex items-center justify-between text-2xs text-terminal-dim">
              <span className="font-mono tabular-nums">
                Total drains TGA + RRP = <span className="text-accent-amber">{fmtTrillions(drainsTotal)}</span>
              </span>
              <span className="font-mono tabular-nums">{series.length} weekly observations</span>
            </div>
          </div>
        </div>

        {/* Trailing change grid */}
        <div className="grid grid-cols-4 gap-2">
          <ChangeChip label="1M" v={changes.chg_1m} />
          <ChangeChip label="3M" v={changes.chg_3m} />
          <ChangeChip label="6M" v={changes.chg_6m} />
          <ChangeChip label="1Y" v={changes.chg_1y} />
        </div>

        {/* Plain-language footer */}
        <div className="text-2xs text-terminal-muted leading-relaxed border-t border-terminal-border/30 pt-2">
          Net liquidity is Fed assets minus the cash drained into the Treasury General Account and the
          reverse-repo facility. It is the liquidity that actually reaches markets, and it tends to lead
          risk assets: rising net liquidity is a tailwind for equities and credit, falling net liquidity a headwind.
        </div>
      </div>
    </div>
  );
}

// Small components

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-xl tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-2xs text-terminal-dim truncate" title={sub}>{sub}</div>}
    </div>
  );
}

function DecompCell({
  label,
  sublabel,
  value,
  accent,
  emphasize = false,
}: {
  label: string;
  sublabel: string;
  value: string;
  accent: string;
  emphasize?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 flex-1 min-w-[7rem] ${emphasize ? "rounded bg-accent/[0.06] px-2 py-1 -my-1" : ""}`}>
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</div>
      <div className={`font-mono tabular-nums ${emphasize ? "text-lg" : "text-base"} ${accent}`}>{value}</div>
      <div className="text-2xs text-terminal-dim font-mono">{sublabel}</div>
    </div>
  );
}

function Operator({ sign }: { sign: "minus" | "equals" }) {
  return (
    <div className="flex items-center justify-center text-terminal-dim font-mono text-lg select-none px-0.5">
      {sign === "minus" ? "-" : "="}
    </div>
  );
}

function ChangeChip({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2 py-1.5 flex items-center justify-between">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</span>
      <span className={`font-mono tabular-nums text-sm ${changeColor(v)}`}>{fmtB(v, true)}</span>
    </div>
  );
}

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
