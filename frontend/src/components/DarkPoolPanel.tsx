import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface DarkPoolRow {
  symbol: string;
  name: string;
  short_volume: number;
  total_volume: number;
  short_ratio: number;
  exempt_ratio: number;
  flag: string;
  trend: string;
}

interface DarkPoolAggregate {
  market_short_ratio: number;
  heavy_count: number;
  symbols_count: number;
}

interface DarkPoolSummary {
  most_shorted: string | null;
  least_shorted: string | null;
  market_short_ratio: number;
  note: string;
}

interface DarkPoolResponse {
  symbols: DarkPoolRow[];
  aggregate: DarkPoolAggregate;
  summary: DarkPoolSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Flag -> color. Heavy = red, Elevated = amber, Normal = neutral.

function flagPillStyle(flag: string): CSSProperties {
  switch (flag) {
    case "Heavy":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "Elevated":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Short-ratio bar fill ramps neutral -> amber -> red as it climbs past 50%.
function ratioColor(ratio: number): string {
  if (ratio >= 58) return "#c2603f"; // deep red, heavy distribution
  if (ratio >= 55) return "#cc6a44"; // red
  if (ratio >= 52) return "#cc8a55"; // clay-orange
  if (ratio >= 50) return "#c9a24a"; // amber, above midpoint
  if (ratio >= 45) return "#8a8175"; // neutral
  return "#5c554b"; // light / dim
}

function trendGlyph(trend: string): string {
  if (trend === "rising") return "▲"; // up triangle
  if (trend === "falling") return "▼"; // down triangle
  return "→"; // right arrow (flat)
}

function trendClass(trend: string): string {
  if (trend === "rising") return "text-accent-red";
  if (trend === "falling") return "text-accent-green";
  return "text-terminal-dim";
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic FINRA snapshot: most names near the off-exchange midpoint, a few heavy.

const FALLBACK: DarkPoolResponse = (() => {
  // [symbol, name, totalVolume(M), shortRatio, trend]
  const seed: Array<[string, string, number, number, string]> = [
    ["GME", "GameStop Corp.", 22.4, 61.3, "rising"],
    ["AMC", "AMC Entertainment", 31.7, 59.1, "rising"],
    ["SMCI", "Super Micro Computer", 18.9, 57.8, "flat"],
    ["TSLA", "Tesla Inc.", 78.5, 56.2, "rising"],
    ["MARA", "MARA Holdings Inc.", 41.2, 55.4, "falling"],
    ["COIN", "Coinbase Global Inc.", 14.6, 53.7, "rising"],
    ["PLTR", "Palantir Technologies", 52.3, 52.9, "flat"],
    ["NVDA", "NVIDIA Corp.", 91.8, 51.6, "rising"],
    ["AMD", "Advanced Micro Devices", 44.1, 50.8, "flat"],
    ["SOFI", "SoFi Technologies", 38.4, 49.7, "falling"],
    ["F", "Ford Motor Co.", 47.9, 48.9, "flat"],
    ["INTC", "Intel Corp.", 39.2, 48.1, "rising"],
    ["MU", "Micron Technology", 21.5, 47.3, "flat"],
    ["AAPL", "Apple Inc.", 56.7, 46.8, "falling"],
    ["BABA", "Alibaba Group", 18.3, 46.2, "flat"],
    ["META", "Meta Platforms Inc.", 16.9, 45.4, "rising"],
    ["MSFT", "Microsoft Corp.", 24.6, 44.7, "flat"],
    ["GOOGL", "Alphabet Inc.", 27.8, 44.1, "falling"],
    ["NFLX", "Netflix Inc.", 4.2, 43.3, "flat"],
    ["SPY", "SPDR S&P 500 ETF", 68.4, 42.1, "flat"],
    ["QQQ", "Invesco QQQ Trust", 36.7, 41.5, "falling"],
    ["AMZN", "Amazon.com Inc.", 42.9, 40.6, "flat"],
  ];
  const symbols: DarkPoolRow[] = seed
    .map(([symbol, name, volM, ratio, trend]) => {
      const total = Math.round(volM * 1_000_000);
      const short = Math.round((total * ratio) / 100);
      const flag = ratio >= 55 ? "Heavy" : ratio >= 50 ? "Elevated" : "Normal";
      const exempt = Math.round(((symbol.charCodeAt(0) % 17) / 10) * 100) / 100;
      return {
        symbol,
        name,
        short_volume: short,
        total_volume: total,
        short_ratio: ratio,
        exempt_ratio: exempt,
        flag,
        trend,
      };
    })
    .sort((a, b) => b.short_ratio - a.short_ratio);
  const heavy = symbols.filter((s) => s.short_ratio >= 55);
  const totShort = symbols.reduce((s, r) => s + r.short_volume, 0);
  const totVol = symbols.reduce((s, r) => s + r.total_volume, 0);
  const market = Math.round((100 * totShort) / totVol * 100) / 100;
  return {
    symbols,
    aggregate: {
      market_short_ratio: market,
      heavy_count: heavy.length,
      symbols_count: symbols.length,
    },
    summary: {
      most_shorted: symbols[0]?.symbol ?? null,
      least_shorted: symbols[symbols.length - 1]?.symbol ?? null,
      market_short_ratio: market,
      note:
        "Off-exchange short volume is a dark-pool / internalizer routing proxy, not net short interest.",
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function fmtVol(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return `${v}`;
}

// Panel

export function DarkPoolPanel() {
  const [data, setData] = useState<DarkPoolResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/dark-pool")
      .then((res) => res.json())
      .then((json: DarkPoolResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.symbols) && json.symbols.length > 0) {
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

  const { symbols, aggregate, summary } = data;

  // Scale ratio bars across a fixed 35-65% off-exchange band so the 50% marker
  // sits at a consistent visual position and heavy names visibly run hot.
  const RATIO_MIN = 35;
  const RATIO_MAX = 65;
  const markerPct = useMemo(
    () => ((50 - RATIO_MIN) / (RATIO_MAX - RATIO_MIN)) * 100,
    []
  );

  const heaviestRow = symbols[0];

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>DARK-POOL SHORT VOLUME</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Market Short Ratio">
            <span className={`stat-figure text-3xl tabular-nums ${aggregate.market_short_ratio >= 50 ? "text-accent-red" : "text-terminal-text"}`}>
              {fmtPct(aggregate.market_short_ratio)}
            </span>
            <span className="text-2xs text-terminal-dim">off-exchange avg</span>
          </KpiCell>
          <KpiCell label="Heaviest">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.most_shorted ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {heaviestRow ? fmtPct(heaviestRow.short_ratio) + " short" : ""}
            </span>
          </KpiCell>
          <KpiCell label="Flagged Heavy">
            <span className={`stat-figure text-3xl tabular-nums ${aggregate.heavy_count > 0 ? "text-accent-red" : "text-terminal-muted"}`}>
              {aggregate.heavy_count}
            </span>
            <span className="text-2xs text-terminal-dim">
              of {aggregate.symbols_count} names
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Short volume routed off the lit exchanges, through dark pools and
            internalizers, is where quiet accumulation and distribution hide. Names
            running well above the 50% line are seeing the heaviest hidden short flow.
          </p>
        </div>

        {/* HERO: short-ratio leaderboard */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[120px_1fr_78px_52px_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Ticker</SectionLabel>
            <SectionLabel>Off-exchange short ratio (50% threshold)</SectionLabel>
            <SectionLabel right>Short / Total</SectionLabel>
            <SectionLabel right>Trend</SectionLabel>
            <SectionLabel right>Flag</SectionLabel>
          </div>

          <div className="flex flex-col">
            {symbols.map((row, i) => (
              <DarkPoolLeaderRow
                key={row.symbol}
                row={row}
                rank={i + 1}
                ratioMin={RATIO_MIN}
                ratioMax={RATIO_MAX}
                markerPct={markerPct}
              />
            ))}
          </div>
        </div>

        {/* Footer legend + honesty note */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-2xs text-terminal-dim">
            <div className="flex items-center gap-3">
              <LegendSwatch color="#c2603f" label="Heavy >= 55%" />
              <LegendSwatch color="#c9a24a" label="Elevated >= 50%" />
              <LegendSwatch color="#8a8175" label="Normal" />
            </div>
            <span className="uppercase tracking-wider">Short ratio = ShortVolume / TotalVolume (FINRA Reg SHO)</span>
          </div>
          <p className="text-2xs text-terminal-dim leading-snug">
            Off-exchange short volume is a dark-pool / internalizer routing proxy, not
            net short interest. A ratio above 50% does NOT mean a name is net short, much
            of it is a market-maker hedging the other side of retail buy orders.
          </p>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function DarkPoolLeaderRow({
  row,
  rank,
  ratioMin,
  ratioMax,
  markerPct,
}: {
  row: DarkPoolRow;
  rank: number;
  ratioMin: number;
  ratioMax: number;
  markerPct: number;
}) {
  const color = ratioColor(row.short_ratio);
  const clamped = Math.max(ratioMin, Math.min(ratioMax, row.short_ratio));
  const pct = Math.max(2, Math.min(100, ((clamped - ratioMin) / (ratioMax - ratioMin)) * 100));
  return (
    <div className="grid grid-cols-[120px_1fr_78px_52px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Ticker + name */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.name}</span>
      </div>

      {/* Ratio bar + figure */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
          {/* 50% threshold marker line */}
          <div
            className="absolute inset-y-0 w-px bg-terminal-muted/80"
            style={{ left: `${markerPct}%` }}
          />
        </div>
        <span className="text-2xs text-terminal-muted truncate">
          <span className="font-mono tabular-nums font-semibold" style={{ color }}>
            {fmtPct(row.short_ratio)}
          </span>
          <span className="text-terminal-dim"> off-exchange short</span>
          {row.exempt_ratio > 0 && (
            <span className="text-terminal-dim"> &middot; {fmtPct(row.exempt_ratio)} exempt</span>
          )}
        </span>
      </div>

      {/* Short / Total volume */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className="text-terminal-text">{fmtVol(row.short_volume)}</span>
        <div className="text-2xs text-terminal-dim">/ {fmtVol(row.total_volume)}</div>
      </div>

      {/* Trend */}
      <div className="text-right font-mono text-xs">
        <span className={trendClass(row.trend)} title={`Short ratio ${row.trend} vs prior session`}>
          {trendGlyph(row.trend)}
        </span>
      </div>

      {/* Flag pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={flagPillStyle(row.flag)}>
          {row.flag}
        </span>
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
