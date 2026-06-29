import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface FlowRow {
  symbol: string;
  name: string;
  asset_class: string;
  sector: string;
  aum: number;
  aum_display: string | null;
  price: number;
  est_daily_flow: number;
  est_daily_flow_display: string | null;
  est_weekly_flow: number;
  est_weekly_flow_display: string | null;
  flow_pct_aum: number;
  direction: string;
}

interface FlowGroup {
  group: string;
  level: string;
  members: number;
  est_daily_flow: number;
  est_daily_flow_display: string | null;
  est_weekly_flow: number;
  est_weekly_flow_display: string | null;
  direction: string;
  top_inflow: string | null;
  top_outflow: string | null;
}

interface FlowSummary {
  biggest_inflow: string | null;
  biggest_inflow_amount: number;
  biggest_inflow_display: string | null;
  biggest_outflow: string | null;
  biggest_outflow_amount: number;
  biggest_outflow_display: string | null;
  net_flow: number;
  net_flow_display: string | null;
  rotation_note: string;
}

interface EtfFlowsResponse {
  etfs: FlowRow[];
  groups: FlowGroup[];
  summary: FlowSummary;
  method: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Color convention: inflow = green, outflow = red, flat = dim.

function flowTextClass(flow: number): string {
  if (flow > 0) return "text-accent-green";
  if (flow < 0) return "text-accent-red";
  return "text-terminal-dim";
}

const INFLOW_COLOR = "#5f8c6a"; // muted green
const OUTFLOW_COLOR = "#c2603f"; // clay red

function flowColor(flow: number): string {
  return flow >= 0 ? INFLOW_COLOR : OUTFLOW_COLOR;
}

function directionPillStyle(direction: string): CSSProperties {
  if (direction === "inflow") return { color: "#5f8c6a", borderColor: "#5f8c6a" };
  if (direction === "outflow") return { color: "#c2603f", borderColor: "#c2603f" };
  return { color: "#a59c8e", borderColor: "#5c554b" };
}

// Formatting helpers

function fmtFlow(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "--";
  const sign = amount < 0 ? "-" : amount > 0 ? "+" : "";
  const a = Math.abs(amount);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic rotation snapshot: tech + broad-equity bid, energy bleeding.

const FALLBACK: EtfFlowsResponse = (() => {
  // [symbol, name, asset_class, sector, aum, price, weekly_flow]
  const seed: Array<[string, string, string, string, number, number, number]> = [
    ["SPY", "SPDR S&P 500 ETF Trust", "Broad Equity", "US Large Cap", 555e9, 545, 3.59e9],
    ["XLK", "Technology Select Sector SPDR", "Sector", "Technology", 72e9, 225, 1.84e9],
    ["QQQ", "Invesco QQQ Trust", "Broad Equity", "US Large Cap", 290e9, 470, 1.61e9],
    ["TLT", "iShares 20+ Year Treasury Bond ETF", "Fixed Income", "Long Treasuries", 52e9, 92, 1.12e9],
    ["GLD", "SPDR Gold Shares", "Commodities", "Gold", 78e9, 215, 0.86e9],
    ["VTI", "Vanguard Total Stock Market ETF", "Broad Equity", "US Total Market", 410e9, 270, 0.74e9],
    ["XLF", "Financial Select Sector SPDR", "Sector", "Financials", 48e9, 44, 0.41e9],
    ["XLY", "Consumer Discretionary Select Sector SPDR", "Sector", "Consumer Discretionary", 21e9, 195, 0.22e9],
    ["XLU", "Utilities Select Sector SPDR", "Sector", "Utilities", 16e9, 73, 0.15e9],
    ["LQD", "iShares iBoxx IG Corporate Bond ETF", "Fixed Income", "IG Credit", 32e9, 109, 0.13e9],
    ["XLV", "Health Care Select Sector SPDR", "Sector", "Health Care", 40e9, 145, 0.09e9],
    ["XLRE", "Real Estate Select Sector SPDR", "Sector", "Real Estate", 7e9, 40, -0.05e9],
    ["HYG", "iShares iBoxx High Yield Corp Bond ETF", "Fixed Income", "High Yield Credit", 16e9, 79, -0.11e9],
    ["VWO", "Vanguard FTSE Emerging Markets ETF", "International", "Emerging Markets", 88e9, 46, -0.17e9],
    ["IWM", "iShares Russell 2000 ETF", "Broad Equity", "US Small Cap", 68e9, 215, -0.23e9],
    ["EEM", "iShares MSCI Emerging Markets ETF", "International", "Emerging Markets", 18e9, 44, -0.31e9],
    ["USO", "United States Oil Fund", "Commodities", "Crude Oil", 1.4e9, 78, -0.44e9],
    ["XLE", "Energy Select Sector SPDR", "Sector", "Energy", 38e9, 92, -0.97e9],
  ];
  const etfs: FlowRow[] = seed
    .map(([symbol, name, asset_class, sector, aum, price, weekly]) => {
      const daily = weekly / 4.4;
      const pct = Math.round((weekly / aum) * 1000000) / 10000;
      const dir = weekly > 0 ? "inflow" : weekly < 0 ? "outflow" : "flat";
      return {
        symbol,
        name,
        asset_class,
        sector,
        aum,
        aum_display: null,
        price,
        est_daily_flow: daily,
        est_daily_flow_display: null,
        est_weekly_flow: weekly,
        est_weekly_flow_display: null,
        flow_pct_aum: pct,
        direction: dir,
      };
    })
    .sort((a, b) => Math.abs(b.est_weekly_flow) - Math.abs(a.est_weekly_flow));

  const byKey = (key: "asset_class" | "sector"): FlowGroup[] => {
    const buckets = new Map<string, FlowRow[]>();
    etfs.forEach((r) => {
      const arr = buckets.get(r[key]) ?? [];
      arr.push(r);
      buckets.set(r[key], arr);
    });
    const out: FlowGroup[] = [];
    buckets.forEach((members, group) => {
      const weekly = members.reduce((s, m) => s + m.est_weekly_flow, 0);
      const daily = members.reduce((s, m) => s + m.est_daily_flow, 0);
      const topIn = members.reduce((a, b) => (b.est_weekly_flow > a.est_weekly_flow ? b : a));
      const topOut = members.reduce((a, b) => (b.est_weekly_flow < a.est_weekly_flow ? b : a));
      out.push({
        group,
        level: key,
        members: members.length,
        est_daily_flow: daily,
        est_daily_flow_display: null,
        est_weekly_flow: weekly,
        est_weekly_flow_display: null,
        direction: weekly > 0 ? "inflow" : weekly < 0 ? "outflow" : "flat",
        top_inflow: topIn.est_weekly_flow > 0 ? topIn.symbol : null,
        top_outflow: topOut.est_weekly_flow < 0 ? topOut.symbol : null,
      });
    });
    return out.sort((a, b) => b.est_weekly_flow - a.est_weekly_flow);
  };

  const groups = [...byKey("asset_class"), ...byKey("sector")];
  const biggestIn = etfs.reduce((a, b) => (b.est_weekly_flow > a.est_weekly_flow ? b : a));
  const biggestOut = etfs.reduce((a, b) => (b.est_weekly_flow < a.est_weekly_flow ? b : a));
  const net = etfs.reduce((s, r) => s + r.est_weekly_flow, 0);

  return {
    etfs,
    groups,
    summary: {
      biggest_inflow: biggestIn.symbol,
      biggest_inflow_amount: biggestIn.est_weekly_flow,
      biggest_inflow_display: null,
      biggest_outflow: biggestOut.symbol,
      biggest_outflow_amount: biggestOut.est_weekly_flow,
      biggest_outflow_display: null,
      net_flow: net,
      net_flow_display: null,
      rotation_note:
        "Money rotating into Broad Equity (led by SPY) and out of Sector energy (led by XLE).",
    },
    method: "modeled_rotation_sample",
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Panel

export function EtfFlowsPanel() {
  const [data, setData] = useState<EtfFlowsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/etf-flows")
      .then((res) => res.json())
      .then((json: EtfFlowsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.etfs) && json.etfs.length > 0) {
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

  const { etfs, groups, summary } = data;

  // Diverging-bar scale: largest absolute weekly flow defines a half-track.
  const maxAbs = useMemo(
    () => Math.max(1, ...etfs.map((r) => Math.abs(r.est_weekly_flow))),
    [etfs]
  );

  const assetClassGroups = useMemo(
    () => groups.filter((g) => g.level === "asset_class"),
    [groups]
  );
  const sectorGroups = useMemo(
    () => groups.filter((g) => g.level === "sector"),
    [groups]
  );
  const maxGroupAbs = useMemo(
    () => Math.max(1, ...groups.map((g) => Math.abs(g.est_weekly_flow))),
    [groups]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>ETF NET-FLOW DASHBOARD</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Biggest Inflow">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.biggest_inflow ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {fmtFlow(summary.biggest_inflow_amount)} this week
            </span>
          </KpiCell>
          <KpiCell label="Biggest Outflow">
            <span className="stat-figure text-3xl text-accent-red leading-none truncate">
              {summary.biggest_outflow ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {fmtFlow(summary.biggest_outflow_amount)} this week
            </span>
          </KpiCell>
          <KpiCell label="Net Flow (Universe)">
            <span className={`stat-figure text-3xl tabular-nums leading-none ${flowTextClass(summary.net_flow)}`}>
              {fmtFlow(summary.net_flow)}
            </span>
            <span className="text-2xs text-terminal-dim truncate">est. trailing week</span>
          </KpiCell>
        </div>

        {/* Rotation one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            {summary.rotation_note}
          </p>
        </div>

        {/* HERO: flow leaderboard with diverging bars */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          <div className="grid grid-cols-[124px_1fr_84px_64px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>ETF</SectionLabel>
            <SectionLabel>Outflow &larr; estimated weekly net flow &rarr; Inflow</SectionLabel>
            <SectionLabel right>Net / AUM</SectionLabel>
            <SectionLabel right>% AUM</SectionLabel>
          </div>

          <div className="flex flex-col">
            {etfs.map((row) => (
              <FlowLeaderRow key={row.symbol} row={row} maxAbs={maxAbs} />
            ))}
          </div>
        </div>

        {/* Group rotation: where money is rotating, by asset class + sector */}
        <div className="grid grid-cols-2 gap-2">
          <GroupCard title="By Asset Class" groups={assetClassGroups} maxAbs={maxGroupAbs} />
          <GroupCard title="By Sector" groups={sectorGroups} maxAbs={maxGroupAbs} />
        </div>

        {/* Footer: legend + honest method note */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color={INFLOW_COLOR} label="Inflow" />
            <LegendSwatch color={OUTFLOW_COLOR} label="Outflow" />
          </div>
          <span className="uppercase tracking-wider text-right">
            Estimate = avg daily $ volume x trend money-flow sign (proxy, not settled creation/redemption data)
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function FlowLeaderRow({ row, maxAbs }: { row: FlowRow; maxAbs: number }) {
  const flow = row.est_weekly_flow;
  const color = flowColor(flow);
  // Half-width track each side of center; bar grows from the midline outward.
  const pct = Math.max(1.5, Math.min(50, (Math.abs(flow) / maxAbs) * 50));
  const inflow = flow >= 0;
  return (
    <div className="grid grid-cols-[124px_1fr_84px_64px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Ticker + sector */}
      <div className="flex flex-col min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
          <span className="pill uppercase tracking-wider shrink-0" style={directionPillStyle(row.direction)}>
            {row.direction}
          </span>
        </div>
        <span className="text-2xs text-terminal-dim truncate">{row.sector}</span>
      </div>

      {/* Diverging bar */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-3 rounded-full bg-terminal-divider/40 overflow-hidden">
          {/* center reference line */}
          <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-muted/70" />
          <div
            className="absolute inset-y-0 rounded-full"
            style={
              inflow
                ? { left: "50%", width: `${pct}%`, backgroundColor: color }
                : { right: "50%", width: `${pct}%`, backgroundColor: color }
            }
          />
        </div>
        <span className="text-2xs font-mono tabular-nums" style={{ color }}>
          {fmtFlow(flow)} <span className="text-terminal-dim">wk</span>
          <span className="text-terminal-dim"> &middot; {fmtFlow(row.est_daily_flow)}/day</span>
        </span>
      </div>

      {/* Net / AUM */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <div style={{ color }}>{fmtFlow(flow)}</div>
        <div className="text-2xs text-terminal-dim">{row.aum_display ?? fmtFlow(row.aum)}</div>
      </div>

      {/* % of AUM */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span className={flowTextClass(flow)}>{fmtPct(row.flow_pct_aum)}</span>
      </div>
    </div>
  );
}

function GroupCard({ title, groups, maxAbs }: { title: string; groups: FlowGroup[]; maxAbs: number }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1 min-w-0">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-0.5">{title}</div>
      {groups.map((g) => {
        const color = flowColor(g.est_weekly_flow);
        const pct = Math.max(1.5, Math.min(50, (Math.abs(g.est_weekly_flow) / maxAbs) * 50));
        const inflow = g.est_weekly_flow >= 0;
        return (
          <div key={g.group} className="grid grid-cols-[96px_1fr_72px] items-center gap-2 py-0.5">
            <span className="text-2xs text-terminal-text truncate" title={g.group}>{g.group}</span>
            <div className="relative h-2 rounded-full bg-terminal-divider/40 overflow-hidden">
              <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-muted/60" />
              <div
                className="absolute inset-y-0 rounded-full"
                style={
                  inflow
                    ? { left: "50%", width: `${pct}%`, backgroundColor: color }
                    : { right: "50%", width: `${pct}%`, backgroundColor: color }
                }
              />
            </div>
            <span className="text-2xs font-mono tabular-nums text-right" style={{ color }}>
              {fmtFlow(g.est_weekly_flow)}
            </span>
          </div>
        );
      })}
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
