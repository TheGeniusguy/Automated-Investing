import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface HorizonLeg {
  carry_bps: number;
  rolldown_bps: number;
  total_bps: number;
}

interface CurvePoint {
  tenor_label: string;
  tenor_years: number;
  yield: number;
  funding_rate: number;
  carry_bps: number;
  rolldown_bps: number;
  total_bps: number;
  mod_duration: number;
  horizon_3m: HorizonLeg;
  horizon_6m: HorizonLeg;
  horizon_12m: HorizonLeg;
}

interface RvTrade {
  name: string;
  description: string;
  carry_bps: number;
  rolldown_bps: number;
  total_bps: number;
}

interface CarrySummary {
  best_point: string | null;
  best_trade: string | null;
  richest_total_bps: number;
}

interface CarryResponse {
  horizon_months: number;
  points: CurvePoint[];
  trades: RvTrade[];
  summary: CarrySummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Warm "ink" palette. Carry = clay/amber, Rolldown = green, negatives = red.
const CARRY_COLOR = "#c9a24a"; // amber — yield income
const ROLL_COLOR = "#6f8f5f"; // muted green — price roll
const NEG_COLOR = "#c2603f"; // clay-red — drag

function totalClass(v: number): string {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

// ---------------------------------------------------------------------------
// Local fallback so the panel renders fully populated, even offline.
// Mirrors the backend SAMPLE curve + analytics (3m horizon default).
// ---------------------------------------------------------------------------

const FALLBACK: CarryResponse = (() => {
  const FUNDING = 4.55;
  const FUNDING_YEARS = 0.25;
  // (label, years, yield)
  const curveDef: Array<[string, number, number]> = [
    ["6M", 0.5, 4.45],
    ["1Y", 1.0, 4.2],
    ["2Y", 2.0, 4.0],
    ["3Y", 3.0, 3.95],
    ["5Y", 5.0, 4.0],
    ["7Y", 7.0, 4.15],
    ["10Y", 10.0, 4.3],
    ["20Y", 20.0, 4.65],
    ["30Y", 30.0, 4.55],
  ];
  const interpCurve: Array<[number, number]> = [[FUNDING_YEARS, FUNDING], ...curveDef.map(([, yrs, y]) => [yrs, y] as [number, number])];
  interpCurve.sort((a, b) => a[0] - b[0]);
  const interp = (yrs: number): number => {
    if (yrs <= interpCurve[0][0]) return interpCurve[0][1];
    if (yrs >= interpCurve[interpCurve.length - 1][0]) return interpCurve[interpCurve.length - 1][1];
    for (let i = 1; i < interpCurve.length; i++) {
      const [x0, y0] = interpCurve[i - 1];
      const [x1, y1] = interpCurve[i];
      if (yrs <= x1) {
        const w = x1 > x0 ? (yrs - x0) / (x1 - x0) : 0;
        return y0 + w * (y1 - y0);
      }
    }
    return interpCurve[interpCurve.length - 1][1];
  };
  const modDur = (y: number, T: number): number => {
    const yd = Math.max(y, 0.01) / 100;
    return Math.round(((1 - Math.pow(1 + yd, -T)) / yd) * 1000) / 1000;
  };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const horizonLeg = (y: number, T: number, dur: number, m: number): HorizonLeg => {
    const h = m / 12;
    const carry = (y - FUNDING) * 100 * h;
    const rolled = Math.max(T - h, FUNDING_YEARS);
    const roll = -dur * (interp(rolled) - y) * 100;
    return { carry_bps: r1(carry), rolldown_bps: r1(roll), total_bps: r1(carry + roll) };
  };
  const points: CurvePoint[] = curveDef.map(([label, T, y]) => {
    const dur = modDur(y, T);
    const h3 = horizonLeg(y, T, dur, 3);
    return {
      tenor_label: label,
      tenor_years: T,
      yield: y,
      funding_rate: FUNDING,
      carry_bps: h3.carry_bps,
      rolldown_bps: h3.rolldown_bps,
      total_bps: h3.total_bps,
      mod_duration: dur,
      horizon_3m: h3,
      horizon_6m: horizonLeg(y, T, dur, 6),
      horizon_12m: horizonLeg(y, T, dur, 12),
    };
  });
  points.sort((a, b) => b.total_bps - a.total_bps);

  const perDv01 = (T: number, y: number): { carry: number; roll: number } => {
    const dur = Math.max(modDur(y, T), 0.05);
    const h = 3 / 12;
    const carry = ((y - FUNDING) * 100 * h) / dur;
    const rolled = Math.max(T - h, FUNDING_YEARS);
    const roll = -(interp(rolled) - y) * 100;
    return { carry, roll };
  };
  const byLabel: Record<string, { carry: number; roll: number }> = {};
  curveDef.forEach(([label, T, y]) => (byLabel[label] = perDv01(T, y)));
  const SCALE = 8;
  const tradeDefs: Array<[string, string, Array<[string, number]>]> = [
    ["2s10s Steepener", "Long 2Y / short 10Y, DV01-neutral — profits as the curve steepens", [["2Y", 1], ["10Y", -1]]],
    ["5s30s Steepener", "Long 5Y / short 30Y, DV01-neutral — belly vs long-end slope", [["5Y", 1], ["30Y", -1]]],
    ["2s5s10s Butterfly", "Long belly (5Y) vs short wings (2Y + 10Y) — curvature carry/roll", [["5Y", 2], ["2Y", -1], ["10Y", -1]]],
  ];
  const trades: RvTrade[] = tradeDefs.map(([name, desc, legs]) => {
    let carry = 0;
    let roll = 0;
    legs.forEach(([label, w]) => {
      carry += w * byLabel[label].carry;
      roll += w * byLabel[label].roll;
    });
    const c = r1(carry * SCALE);
    const rd = r1(roll * SCALE);
    return { name, description: desc, carry_bps: c, rolldown_bps: rd, total_bps: r1(c + rd) };
  });
  trades.sort((a, b) => b.total_bps - a.total_bps);

  return {
    horizon_months: 3,
    points,
    trades,
    summary: {
      best_point: points[0]?.tenor_label ?? null,
      best_trade: trades[0]?.name ?? null,
      richest_total_bps: points[0]?.total_bps ?? 0,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtBps(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} bp`;
}

// Panel

const HORIZON_OPTIONS = [3, 6, 12] as const;

export function CarryRolldownPanel() {
  const [data, setData] = useState<CarryResponse>(FALLBACK);
  const [horizon, setHorizon] = useState<number>(3);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/carry-rolldown?horizon_months=${horizon}`)
      .then((res) => res.json())
      .then((json: CarryResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.points) && json.points.length > 0) {
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
  }, [horizon]);

  const { points, trades, summary } = data;

  // Scale carry/roll bars to the widest absolute total so the leader fills.
  const maxAbs = useMemo(() => {
    const vals = points.map((p) => Math.abs(p.carry_bps) + Math.abs(p.rolldown_bps));
    return Math.max(10, ...vals);
  }, [points]);

  const bestPointRow = points[0];

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CARRY &amp; ROLLDOWN RV</span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
          <div className="flex items-center gap-1">
            {HORIZON_OPTIONS.map((m) => (
              <button
                key={m}
                onClick={() => setHorizon(m)}
                className={`pill normal-case tracking-normal ${
                  horizon === m ? "text-terminal-text" : "text-terminal-dim"
                }`}
                style={horizon === m ? { borderColor: "#c9a24a", color: "#c9a24a" } : undefined}
              >
                {m}m
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Richest Point">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.best_point ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {bestPointRow ? fmtBps(bestPointRow.total_bps) + ` over ${horizon}m` : ""}
            </span>
          </KpiCell>
          <KpiCell label="Best RV Trade">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.best_trade ? summary.best_trade.split(" ")[0] : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {trades[0] ? fmtBps(trades[0].total_bps) + " net carry+roll" : ""}
            </span>
          </KpiCell>
          <KpiCell label="Richest Total">
            <span className={`stat-figure text-3xl tabular-nums ${totalClass(summary.richest_total_bps)}`}>
              {summary.richest_total_bps.toFixed(1)}
            </span>
            <span className="text-2xs text-terminal-dim">bps / {horizon}m horizon</span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Total return on a held bond is carry (yield earned net of funding) plus rolldown (price
            gained as it ages down the curve). The richest points and curve trades earn the most for
            standing still — assuming the curve doesn&apos;t move.
          </p>
        </div>

        {/* HERO: carry+roll leaderboard */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          <div className="grid grid-cols-[96px_1fr_72px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Tenor</SectionLabel>
            <SectionLabel>Carry + rolldown breakdown ({horizon}m)</SectionLabel>
            <SectionLabel right>Total</SectionLabel>
          </div>

          <div className="flex flex-col">
            {points.map((row, i) => (
              <CarryLeaderRow key={row.tenor_label} row={row} maxAbs={maxAbs} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* RV trades section */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="grid grid-cols-[1fr_72px_72px_72px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Relative-value trade (DV01-neutral)</SectionLabel>
            <SectionLabel right>Carry</SectionLabel>
            <SectionLabel right>Roll</SectionLabel>
            <SectionLabel right>Total</SectionLabel>
          </div>
          <div className="flex flex-col">
            {trades.map((t) => (
              <TradeRow key={t.name} trade={t} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color={CARRY_COLOR} label="Carry — yield net of funding" />
            <LegendSwatch color={ROLL_COLOR} label="Rolldown — aging down the curve" />
            <LegendSwatch color={NEG_COLOR} label="Negative drag" />
          </div>
          <span className="uppercase tracking-wider">Total = carry + rolldown over the horizon</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function CarryLeaderRow({ row, maxAbs, rank }: { row: CurvePoint; maxAbs: number; rank: number }) {
  // Stacked bar centered on zero: carry then rolldown, each its own color.
  const carryPct = Math.min(50, (Math.abs(row.carry_bps) / maxAbs) * 50);
  const rollPct = Math.min(50, (Math.abs(row.rolldown_bps) / maxAbs) * 50);
  const carryColor = row.carry_bps >= 0 ? CARRY_COLOR : NEG_COLOR;
  const rollColor = row.rolldown_bps >= 0 ? ROLL_COLOR : NEG_COLOR;
  return (
    <div className="grid grid-cols-[96px_1fr_72px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Tenor + duration */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.tenor_label}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.yield.toFixed(2)}%</span>
      </div>

      {/* Stacked carry + rolldown bar */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/40 overflow-hidden flex">
          <div className="h-full rounded-l-full" style={{ width: `${carryPct}%`, backgroundColor: carryColor }} />
          <div className="h-full" style={{ width: `${rollPct}%`, backgroundColor: rollColor }} />
        </div>
        <span className="text-2xs text-terminal-muted truncate">
          <span style={{ color: carryColor }}>carry {fmtBps(row.carry_bps)}</span>
          <span className="text-terminal-dim"> · </span>
          <span style={{ color: rollColor }}>roll {fmtBps(row.rolldown_bps)}</span>
          <span className="text-terminal-dim"> · dur {row.mod_duration.toFixed(1)}</span>
        </span>
      </div>

      {/* Total */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className={`font-semibold ${totalClass(row.total_bps)}`}>{row.total_bps.toFixed(1)}</span>
        <div className="text-2xs text-terminal-dim">bps</div>
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: RvTrade }) {
  return (
    <div className="grid grid-cols-[1fr_72px_72px_72px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      <div className="flex flex-col min-w-0">
        <span className="font-mono text-xs text-terminal-text font-semibold truncate">{trade.name}</span>
        <span className="text-2xs text-terminal-dim truncate" title={trade.description}>
          {trade.description}
        </span>
      </div>
      <div className="text-right font-mono tabular-nums text-2xs" style={{ color: trade.carry_bps >= 0 ? CARRY_COLOR : NEG_COLOR }}>
        {fmtBps(trade.carry_bps)}
      </div>
      <div className="text-right font-mono tabular-nums text-2xs" style={{ color: trade.rolldown_bps >= 0 ? ROLL_COLOR : NEG_COLOR }}>
        {fmtBps(trade.rolldown_bps)}
      </div>
      <div className={`text-right font-mono tabular-nums text-xs font-semibold ${totalClass(trade.total_bps)}`}>
        {trade.total_bps.toFixed(1)}
      </div>
    </div>
  );
}

function KpiCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex flex-col gap-0.5 min-w-0">{children}</div>
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <div className={`text-2xs text-terminal-muted uppercase tracking-wider ${right ? "text-right" : ""}`}>
      {children}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
