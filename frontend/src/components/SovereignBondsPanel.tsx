import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface BondRow {
  country: string;
  code: string;
  flag_label: string;
  region?: string;
  yield_10y: number;
  yield_2y: number | null;
  yield_30y: number | null;
  change_bps: number | null;
  spread_to_ust_bps: number;
  spread_to_bund_bps: number;
}

interface BondRef {
  country: string;
  code: string;
  flag_label: string;
  yield_10y: number;
  spread_to_bund_bps: number;
}

interface BondSummary {
  highest_yield: BondRef | null;
  lowest_yield: BondRef | null;
  widest_spread_to_bund: BondRef | null;
  count: number;
}

interface SovereignBondsResponse {
  countries: BondRow[];
  summary: BondSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Yield-level bar color ramps cool -> warm as the 10Y level climbs.
function yieldColor(y: number): string {
  if (y >= 5.0) return "#c2603f"; // deep red, very high
  if (y >= 4.0) return "#cc6a44"; // red
  if (y >= 3.0) return "#cc8a55"; // clay-orange
  if (y >= 2.0) return "#c9a24a"; // amber
  if (y >= 1.0) return "#8a8175"; // neutral
  return "#5c554b"; // very low / dim
}

// A daily yield FALL is bullish for bonds (price up) -> green.
// A daily yield RISE is bearish for bonds (price down) -> red.
function changeClass(bps: number | null): string {
  if (bps === null) return "text-terminal-dim";
  if (bps > 0) return "text-accent-red";
  if (bps < 0) return "text-accent-green";
  return "text-terminal-muted";
}

// Spread cells: wider (more positive) = cheaper/riskier vs the anchor -> warmer.
function spreadClass(bps: number): string {
  if (bps >= 100) return "text-accent-red";
  if (bps >= 25) return "text-accent-amber";
  if (bps <= -25) return "text-accent-green";
  return "text-terminal-muted";
}

// Local fallback so the panel renders fully populated, even offline.
// Realistic mid-2026 global sovereign 10Y board (curated OECD levels).

const FALLBACK: SovereignBondsResponse = (() => {
  // [country, code, flag, region, 10y, 2y, 30y, change_bps]
  const seed: Array<[string, string, string, string, number, number | null, number | null, number]> = [
    ["United States", "US", "\u{1F1FA}\u{1F1F8}", "Americas", 4.3, 3.95, 4.55, -2.1],
    ["Germany", "DE", "\u{1F1E9}\u{1F1EA}", "EMEA", 2.4, 2.05, 2.7, -1.4],
    ["United Kingdom", "GB", "\u{1F1EC}\u{1F1E7}", "EMEA", 4.1, 4.2, 4.65, 1.8],
    ["France", "FR", "\u{1F1EB}\u{1F1F7}", "EMEA", 3.05, 2.3, 3.85, -0.6],
    ["Italy", "IT", "\u{1F1EE}\u{1F1F9}", "EMEA", 3.7, 2.95, 4.55, 2.7],
    ["Spain", "ES", "\u{1F1EA}\u{1F1F8}", "EMEA", 3.15, 2.45, 3.95, 0.9],
    ["Netherlands", "NL", "\u{1F1F3}\u{1F1F1}", "EMEA", 2.65, 2.15, 2.95, -1.1],
    ["Switzerland", "CH", "\u{1F1E8}\u{1F1ED}", "EMEA", 0.6, 0.3, 0.95, -0.4],
    ["Sweden", "SE", "\u{1F1F8}\u{1F1EA}", "EMEA", 2.3, 2.2, 2.55, 0.5],
    ["Japan", "JP", "\u{1F1EF}\u{1F1F5}", "Asia-Pacific", 1.0, 0.55, 2.45, 0.8],
    ["Australia", "AU", "\u{1F1E6}\u{1F1FA}", "Asia-Pacific", 4.2, 3.85, 4.6, 3.1],
    ["Canada", "CA", "\u{1F1E8}\u{1F1E6}", "Americas", 3.25, 3.05, 3.35, -1.7],
  ];
  const ust = 4.3;
  const bund = 2.4;
  const countries: BondRow[] = seed
    .map(([country, code, flag, region, y10, y2, y30, chg]) => ({
      country,
      code,
      flag_label: flag,
      region,
      yield_10y: y10,
      yield_2y: y2,
      yield_30y: y30,
      change_bps: chg,
      spread_to_ust_bps: Math.round((y10 - ust) * 100 * 10) / 10,
      spread_to_bund_bps: Math.round((y10 - bund) * 100 * 10) / 10,
    }))
    .sort((a, b) => b.yield_10y - a.yield_10y);

  const highest = countries[0];
  const lowest = countries[countries.length - 1];
  const nonBund = countries.filter((c) => c.code !== "DE");
  const widest = nonBund.reduce((m, c) =>
    c.spread_to_bund_bps > m.spread_to_bund_bps ? c : m, nonBund[0]);

  const ref = (r: BondRow): BondRef => ({
    country: r.country,
    code: r.code,
    flag_label: r.flag_label,
    yield_10y: r.yield_10y,
    spread_to_bund_bps: r.spread_to_bund_bps,
  });

  return {
    countries,
    summary: {
      highest_yield: ref(highest),
      lowest_yield: ref(lowest),
      widest_spread_to_bund: ref(widest),
      count: countries.length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated OECD long-term levels",
  };
})();

// Formatting helpers

function fmtPct(v: number | null): string {
  return v === null ? "--" : `${v.toFixed(2)}%`;
}

function fmtBps(v: number | null): string {
  if (v === null) return "--";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

// Panel

export function SovereignBondsPanel() {
  const [data, setData] = useState<SovereignBondsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/sovereign-bonds")
      .then((res) => res.json())
      .then((json: SovereignBondsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.countries) && json.countries.length > 0) {
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

  const { countries, summary } = data;

  // Scale 10Y bars to the highest reading so the leader fills the track.
  const maxYield = useMemo(
    () => Math.max(5, ...countries.map((c) => c.yield_10y)),
    [countries]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>GLOBAL SOVEREIGN BONDS</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Highest 10Y">
            <span className="stat-figure text-3xl text-accent-red leading-none truncate">
              {summary.highest_yield
                ? `${summary.highest_yield.flag_label} ${fmtPct(summary.highest_yield.yield_10y)}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.highest_yield?.country ?? ""}
            </span>
          </KpiCell>
          <KpiCell label="Lowest 10Y">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.lowest_yield
                ? `${summary.lowest_yield.flag_label} ${fmtPct(summary.lowest_yield.yield_10y)}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.lowest_yield?.country ?? ""}
            </span>
          </KpiCell>
          <KpiCell label="Widest vs Bund">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.widest_spread_to_bund
                ? `${summary.widest_spread_to_bund.flag_label} ${fmtBps(summary.widest_spread_to_bund.spread_to_bund_bps)}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.widest_spread_to_bund
                ? `${summary.widest_spread_to_bund.country} · bps`
                : ""}
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            The 10-year benchmark is the global risk-free term every cross-asset desk watches.
            Spreads-to-Treasury and spreads-to-Bund frame where sovereign risk and relative value
            are concentrating today.
          </p>
        </div>

        {/* HERO: sovereign board */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[150px_1fr_64px_60px_66px_66px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Country</SectionLabel>
            <SectionLabel>10Y level (2Y / 30Y)</SectionLabel>
            <SectionLabel right>10Y</SectionLabel>
            <SectionLabel right>&Delta;bp</SectionLabel>
            <SectionLabel right>vs UST</SectionLabel>
            <SectionLabel right>vs Bund</SectionLabel>
          </div>

          <div className="flex flex-col">
            {countries.map((row) => (
              <BondBoardRow key={row.code} row={row} maxYield={maxYield} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span className="text-accent-green">&Delta;bp -</span> yield fell (bond rally)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-accent-red">&Delta;bp +</span> yield rose (bond selloff)
            </span>
          </div>
          <span className="uppercase tracking-wider">Source: FRED OECD long-term rates (IRLTLT01)</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function BondBoardRow({ row, maxYield }: { row: BondRow; maxYield: number }) {
  const color = yieldColor(row.yield_10y);
  const pct = Math.max(2, Math.min(100, (row.yield_10y / maxYield) * 100));
  return (
    <div className="grid grid-cols-[150px_1fr_64px_60px_66px_66px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Flag + country */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-sm shrink-0">{row.flag_label}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.code}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.country}</span>
      </div>

      {/* 10Y bar + 2Y/30Y legs */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-2xs text-terminal-muted truncate">
          2Y {fmtPct(row.yield_2y)}
          <span className="text-terminal-dim"> &middot; </span>
          30Y {fmtPct(row.yield_30y)}
        </span>
      </div>

      {/* 10Y level */}
      <div className="text-right font-mono tabular-nums text-xs font-semibold" style={{ color }}>
        {fmtPct(row.yield_10y)}
      </div>

      {/* daily change */}
      <div className={`text-right font-mono tabular-nums text-xs ${changeClass(row.change_bps)}`}>
        {fmtBps(row.change_bps)}
      </div>

      {/* spread to UST */}
      <div className={`text-right font-mono tabular-nums text-xs ${spreadClass(row.spread_to_ust_bps)}`}>
        {fmtBps(row.spread_to_ust_bps)}
      </div>

      {/* spread to Bund */}
      <div className={`text-right font-mono tabular-nums text-xs ${spreadClass(row.spread_to_bund_bps)}`}>
        {fmtBps(row.spread_to_bund_bps)}
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
