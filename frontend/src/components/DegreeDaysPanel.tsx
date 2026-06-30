import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface DDNational {
  hdd: number;
  cdd: number;
  hdd_normal: number;
  cdd_normal: number;
  hdd_deviation: number;
  cdd_deviation: number;
}

interface DDRegion {
  region: string;
  pop_weight: number;
  hdd: number;
  cdd: number;
  hdd_normal: number;
  cdd_normal: number;
  hdd_deviation: number;
  cdd_deviation: number;
  demand_signal: string;
}

interface DDSummary {
  headline: string;
  gas_demand_read: string;
  vs_normal: string;
}

interface DegreeDaysResponse {
  season_context: string;
  national: DDNational;
  regions: DDRegion[];
  summary: DDSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Palette - warm "ink" tokens. HDD reads cool-blue, CDD warm-red.
const HDD_COLOR = "#5f7da0"; // cool slate-blue (heating)
const CDD_COLOR = "#c2603f"; // clay-red (cooling)
const GRID_DIM = "#5c554b";

// Demand-signal pill: more weather demand = bullish for gas/power.
function signalPillStyle(signal: string): CSSProperties {
  switch (signal) {
    case "Strong":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "Above normal":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    case "Weak":
      return { color: "#5f7da0", borderColor: "#5f7da0" };
    case "Below normal":
      return { color: "#8a8175", borderColor: "#5c554b" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Deviation text color: above normal = warm (more demand), below = cool.
function devClass(dev: number): string {
  if (dev >= 4) return "text-accent-red";
  if (dev >= 1) return "text-accent-amber";
  if (dev <= -4) return "text-accent-green";
  return "text-terminal-muted";
}

// Local fallback so the panel renders fully populated, even offline.
// A summer snapshot: CDD dominates, HDD near zero, cooling demand around normal.

const FALLBACK: DegreeDaysResponse = (() => {
  const regions: DDRegion[] = [
    { region: "Northeast", pop_weight: 0.172, hdd: 5.8, cdd: 42.1, hdd_normal: 4.2, cdd_normal: 41.0, hdd_deviation: 1.6, cdd_deviation: 1.1, demand_signal: "Normal" },
    { region: "Midwest", pop_weight: 0.208, hdd: 8.3, cdd: 53.6, hdd_normal: 4.7, cdd_normal: 50.8, hdd_deviation: 3.6, cdd_deviation: 2.8, demand_signal: "Normal" },
    { region: "South", pop_weight: 0.382, hdd: 0.7, cdd: 86.9, hdd_normal: 2.2, cdd_normal: 89.9, hdd_deviation: -1.5, cdd_deviation: -3.0, demand_signal: "Normal" },
    { region: "West", pop_weight: 0.238, hdd: 0.0, cdd: 54.2, hdd_normal: 2.7, cdd_normal: 48.9, hdd_deviation: -2.7, cdd_deviation: 5.3, demand_signal: "Above normal" },
  ];
  const wsum = (f: keyof DDRegion) =>
    Math.round(regions.reduce((s, r) => s + r.pop_weight * (r[f] as number), 0) * 10) / 10;
  const national: DDNational = {
    hdd: wsum("hdd"),
    cdd: wsum("cdd"),
    hdd_normal: wsum("hdd_normal"),
    cdd_normal: wsum("cdd_normal"),
    hdd_deviation: 0,
    cdd_deviation: 0,
  };
  national.hdd_deviation = Math.round((national.hdd - national.hdd_normal) * 10) / 10;
  national.cdd_deviation = Math.round((national.cdd - national.cdd_normal) * 10) / 10;
  return {
    season_context: "Summer - cooling-dominated (CDD drives power burn)",
    national,
    regions,
    summary: {
      headline: "National cooling demand near normal",
      gas_demand_read:
        "Cooling-degree days are running near normal, a neutral signal for near-term natural-gas and power demand.",
      vs_normal: "HDD +0 vs normal, CDD +0.9 vs normal",
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtDev(v: number): string {
  return (v >= 0 ? "+" : "") + v.toFixed(1);
}

// Panel

export function DegreeDaysPanel() {
  const [data, setData] = useState<DegreeDaysResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/degree-days")
      .then((res) => res.json())
      .then((json: DegreeDaysResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.regions) && json.regions.length > 0) {
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

  const { national, regions, summary } = data;

  // Scale the HDD/CDD bars to the largest reading across regions so the leader fills.
  const maxDD = useMemo(
    () => Math.max(20, ...regions.map((r) => Math.max(r.hdd, r.cdd))),
    [regions]
  );
  // Scale the deviation bars symmetrically around zero.
  const maxDev = useMemo(
    () =>
      Math.max(
        5,
        ...regions.map((r) => Math.max(Math.abs(r.hdd_deviation), Math.abs(r.cdd_deviation)))
      ),
    [regions]
  );

  const ndev = national.hdd_deviation + national.cdd_deviation;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>DEGREE DAYS - HDD / CDD</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Season context line */}
        <div className="text-2xs text-terminal-muted uppercase tracking-wider">
          {data.season_context}
        </div>

        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="National HDD">
            <span className="stat-figure text-3xl tabular-nums" style={{ color: HDD_COLOR }}>
              {national.hdd.toFixed(1)}
            </span>
            <span className="text-2xs text-terminal-dim">
              norm {national.hdd_normal.toFixed(1)} ({fmtDev(national.hdd_deviation)})
            </span>
          </KpiCell>
          <KpiCell label="National CDD">
            <span className="stat-figure text-3xl tabular-nums" style={{ color: CDD_COLOR }}>
              {national.cdd.toFixed(1)}
            </span>
            <span className="text-2xs text-terminal-dim">
              norm {national.cdd_normal.toFixed(1)} ({fmtDev(national.cdd_deviation)})
            </span>
          </KpiCell>
          <KpiCell label="Total vs Normal">
            <span className={`stat-figure text-3xl tabular-nums ${devClass(ndev)}`}>
              {fmtDev(ndev)}
            </span>
            <span className="text-2xs text-terminal-dim">degree-days vs climatology</span>
          </KpiCell>
        </div>

        {/* Plain-language gas-demand read */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            {summary.gas_demand_read}
          </p>
        </div>

        {/* HERO: region table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[132px_1fr_84px_72px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Region (pop. wt.)</SectionLabel>
            <SectionLabel>HDD / CDD vs normal</SectionLabel>
            <SectionLabel right>Deviation</SectionLabel>
            <SectionLabel right>Demand</SectionLabel>
          </div>

          <div className="flex flex-col">
            {regions.map((row) => (
              <RegionRow key={row.region} row={row} maxDD={maxDD} maxDev={maxDev} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color={HDD_COLOR} label="HDD (heating)" />
            <LegendSwatch color={CDD_COLOR} label="CDD (cooling)" />
            <LegendSwatch color="#8aa978" label="below normal" />
            <LegendSwatch color="#c2603f" label="above normal" />
          </div>
          <span className="uppercase tracking-wider">
            Population-weighted &middot; {data.source}
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function RegionRow({ row, maxDD, maxDev }: { row: DDRegion; maxDD: number; maxDev: number }) {
  const hddPct = Math.max(1, Math.min(100, (row.hdd / maxDD) * 100));
  const cddPct = Math.max(1, Math.min(100, (row.cdd / maxDD) * 100));
  return (
    <div className="grid grid-cols-[132px_1fr_84px_72px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Region + weight */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-mono text-xs text-terminal-text font-semibold truncate">
          {row.region}
        </span>
        <span className="text-2xs text-terminal-dim tabular-nums shrink-0">
          {(row.pop_weight * 100).toFixed(1)}%
        </span>
      </div>

      {/* HDD + CDD stacked bars */}
      <div className="flex flex-col gap-1 min-w-0">
        <BarLine
          label="HDD"
          value={row.hdd}
          pct={hddPct}
          color={HDD_COLOR}
          normal={row.hdd_normal}
          maxDD={maxDD}
        />
        <BarLine
          label="CDD"
          value={row.cdd}
          pct={cddPct}
          color={CDD_COLOR}
          normal={row.cdd_normal}
          maxDD={maxDD}
        />
      </div>

      {/* Deviation bars (green below / red above normal) */}
      <div className="flex flex-col gap-1 items-end">
        <DevBar dev={row.hdd_deviation} maxDev={maxDev} />
        <DevBar dev={row.cdd_deviation} maxDev={maxDev} />
      </div>

      {/* Demand-signal pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={signalPillStyle(row.demand_signal)}>
          {row.demand_signal}
        </span>
      </div>
    </div>
  );
}

function BarLine({
  label,
  value,
  pct,
  color,
  normal,
  maxDD,
}: {
  label: string;
  value: number;
  pct: number;
  color: string;
  normal: number;
  maxDD: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-2xs text-terminal-dim font-mono w-6 shrink-0">{label}</span>
      <div className="relative flex-1 h-2 rounded-full bg-terminal-divider/50 overflow-hidden min-w-0">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        {/* normal reference marker */}
        <div
          className="absolute inset-y-0 w-px"
          style={{
            left: `${Math.min(100, (normal / maxDD) * 100)}%`,
            backgroundColor: GRID_DIM,
          }}
        />
      </div>
      <span className="text-2xs text-terminal-text font-mono tabular-nums w-8 text-right shrink-0">
        {value.toFixed(0)}
      </span>
    </div>
  );
}

function DevBar({ dev, maxDev }: { dev: number; maxDev: number }) {
  const pct = Math.min(50, (Math.abs(dev) / maxDev) * 50);
  const positive = dev >= 0;
  const color = positive ? "#c2603f" : "#8aa978"; // above = warm/more demand, below = cool
  return (
    <div className="flex items-center gap-1 w-full">
      <div className="relative flex-1 h-2 rounded-full bg-terminal-divider/40 overflow-hidden">
        {/* center zero line */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-muted/60" />
        <div
          className="absolute inset-y-0 rounded-full"
          style={
            positive
              ? { left: "50%", width: `${pct}%`, backgroundColor: color }
              : { right: "50%", width: `${pct}%`, backgroundColor: color }
          }
        />
      </div>
      <span className={`text-2xs font-mono tabular-nums w-8 text-right shrink-0 ${devClass(dev)}`}>
        {fmtDev(dev)}
      </span>
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
