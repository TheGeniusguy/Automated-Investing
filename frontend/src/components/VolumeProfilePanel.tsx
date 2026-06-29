import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface ProfileBin {
  price_low: number;
  price_high: number;
  price_mid: number;
  volume: number;
  pct_of_total: number;
  node_type: string; // "poc" | "hvn" | "lvn" | "normal"
}

interface PocInfo {
  price: number;
  volume: number;
}

interface ValueArea {
  high: number;
  low: number;
  pct: number;
}

interface ProfileSummary {
  hvn_count: number;
  lvn_count: number;
  range_low: number;
  range_high: number;
}

interface VolumeProfileResponse {
  symbol: string;
  lookback_days: number;
  bins: ProfileBin[];
  poc: PocInfo;
  value_area: ValueArea;
  current_price: number;
  price_vs_poc: string;
  total_volume: number;
  summary: ProfileSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Node -> bar color. POC = clay/red, HVN = amber, LVN = dim, normal = neutral.

function nodeColor(node: string): string {
  switch (node) {
    case "poc":
      return "#c2603f"; // clay / red - the magnet
    case "hvn":
      return "#c9a24a"; // amber - acceptance shelf
    case "lvn":
      return "#5c554b"; // dim - rejection gap
    default:
      return "#8a8175"; // neutral
  }
}

function nodeTextClass(node: string): string {
  switch (node) {
    case "poc":
      return "text-accent-red";
    case "hvn":
      return "text-accent-amber";
    case "lvn":
      return "text-terminal-dim";
    default:
      return "text-terminal-muted";
  }
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic SPY volume-at-price snapshot: clear POC, ~70% value area band,
// a couple of secondary shelves above and below.

const FALLBACK: VolumeProfileResponse = (() => {
  // [price_mid, raw volume, node] - ascending by price.
  const seed: Array<[number, number, string]> = [
    [486, 18, "lvn"],
    [492, 41, "normal"],
    [498, 96, "hvn"],
    [504, 132, "hvn"],
    [510, 78, "normal"],
    [516, 44, "lvn"],
    [522, 69, "normal"],
    [528, 158, "hvn"],
    [534, 214, "hvn"],
    [540, 296, "poc"],
    [546, 247, "hvn"],
    [552, 181, "hvn"],
    [558, 112, "normal"],
    [564, 63, "normal"],
    [570, 38, "lvn"],
    [576, 89, "normal"],
    [582, 134, "hvn"],
    [588, 71, "normal"],
    [594, 33, "lvn"],
    [600, 16, "lvn"],
  ];
  const width = 6;
  const total = seed.reduce((s, [, v]) => s + v, 0);
  const bins: ProfileBin[] = seed.map(([mid, vol, node]) => ({
    price_low: mid - width / 2,
    price_high: mid + width / 2,
    price_mid: mid,
    volume: vol,
    pct_of_total: Math.round((vol / total) * 10000) / 100,
    node_type: node,
  }));
  return {
    symbol: "SPY",
    lookback_days: 120,
    bins,
    poc: { price: 540, volume: 296 },
    value_area: { high: 555, low: 525, pct: 70.4 },
    current_price: 562.3,
    price_vs_poc: "above",
    total_volume: total,
    summary: { hvn_count: 7, lvn_count: 5, range_low: 483, range_high: 603 },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtPrice(v: number): string {
  return `$${v.toFixed(2)}`;
}

function nodeLabel(node: string): string {
  switch (node) {
    case "poc":
      return "POC";
    case "hvn":
      return "HVN";
    case "lvn":
      return "LVN";
    default:
      return "";
  }
}

// Panel

export function VolumeProfilePanel() {
  const [data, setData] = useState<VolumeProfileResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("SPY");
  const [pending, setPending] = useState("SPY");

  function load(sym: string) {
    const clean = (sym || "SPY").trim().toUpperCase() || "SPY";
    setLoading(true);
    fetch(`/api/volume-profile/${encodeURIComponent(clean)}`)
      .then((res) => res.json())
      .then((json: VolumeProfileResponse) => {
        if (json && Array.isArray(json.bins) && json.bins.length > 0) {
          setData(json);
          setSymbol(clean);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/volume-profile/SPY")
      .then((res) => res.json())
      .then((json: VolumeProfileResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.bins) && json.bins.length > 0) {
          setData(json);
          setSymbol(json.symbol || "SPY");
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

  const { bins, poc, value_area, current_price, summary } = data;

  // Rows render top = high price down to bottom = low price.
  const rows = useMemo(() => [...bins].reverse(), [bins]);

  // Scale bars to the heaviest bin so the POC fills the track.
  const maxPct = useMemo(
    () => Math.max(1, ...bins.map((b) => b.pct_of_total)),
    [bins]
  );

  // Which displayed rows sit inside the value area band (for the highlight).
  function inValueArea(b: ProfileBin): boolean {
    return b.price_high > value_area.low && b.price_low < value_area.high;
  }

  // Which row is closest to current price (for the price marker).
  const currentRowIdx = useMemo(() => {
    let best = 0;
    let bestDist = Infinity;
    rows.forEach((b, i) => {
      const d = Math.abs(b.price_mid - current_price);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }, [rows, current_price]);

  const vsPoc = current_price - poc.price;
  const vsPocPct = poc.price > 0 ? (vsPoc / poc.price) * 100 : 0;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>VOLUME PROFILE / VPVR</span>
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              load(pending);
            }}
            className="flex items-center gap-1"
          >
            <input
              value={pending}
              onChange={(e) => setPending(e.target.value)}
              spellCheck={false}
              className="w-16 bg-terminal-bg border border-terminal-border/60 rounded px-1.5 py-0.5 text-2xs font-mono uppercase tracking-wider text-terminal-text outline-none focus:border-accent-amber/70 normal-case"
              placeholder="SPY"
              aria-label="Symbol"
            />
            <button
              type="submit"
              className="pill uppercase tracking-wider text-terminal-muted hover:text-terminal-text"
            >
              Go
            </button>
          </form>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-2">
          <KpiCell label="Point of Control">
            <span className="stat-figure text-2xl tabular-nums text-accent-red leading-none">
              {fmtPrice(poc.price)}
            </span>
            <span className="text-2xs text-terminal-dim">{symbol} fair value</span>
          </KpiCell>
          <KpiCell label="Value Area High">
            <span className="stat-figure text-2xl tabular-nums text-terminal-text leading-none">
              {fmtPrice(value_area.high)}
            </span>
            <span className="text-2xs text-terminal-dim">{value_area.pct.toFixed(0)}% band top</span>
          </KpiCell>
          <KpiCell label="Value Area Low">
            <span className="stat-figure text-2xl tabular-nums text-terminal-text leading-none">
              {fmtPrice(value_area.low)}
            </span>
            <span className="text-2xs text-terminal-dim">{value_area.pct.toFixed(0)}% band base</span>
          </KpiCell>
          <KpiCell label="Last vs POC">
            <span className="stat-figure text-2xl tabular-nums leading-none text-terminal-text">
              {fmtPrice(current_price)}
            </span>
            <span
              className={`text-2xs tabular-nums ${vsPoc >= 0 ? "text-accent-green" : "text-accent-red"}`}
            >
              {(vsPoc >= 0 ? "+" : "") + vsPocPct.toFixed(1)}% {vsPoc >= 0 ? "above" : "below"} POC
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Volume-at-price maps where {symbol} actually traded. The POC is the
            magnet; the shaded value area holds ~{value_area.pct.toFixed(0)}% of volume.
            High-volume shelves act as support and resistance, while low-volume gaps
            are levels price tends to slice through quickly.
          </p>
        </div>

        {/* HERO: horizontal volume-by-price histogram */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[72px_1fr_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Price</SectionLabel>
            <SectionLabel>Volume at price (top = high, bottom = low)</SectionLabel>
            <SectionLabel right>% Vol</SectionLabel>
          </div>

          <div className="flex flex-col">
            {rows.map((b, i) => (
              <ProfileRow
                key={`${b.price_mid}-${i}`}
                bin={b}
                maxPct={maxPct}
                inVa={inValueArea(b)}
                isCurrent={i === currentRowIdx}
              />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="POC" />
            <LegendSwatch color="#c9a24a" label="HVN (shelf)" />
            <LegendSwatch color="#8a8175" label="Normal" />
            <LegendSwatch color="#5c554b" label="LVN (gap)" />
          </div>
          <span className="uppercase tracking-wider">
            {summary.hvn_count} HVN / {summary.lvn_count} LVN over {data.lookback_days}d &middot;{" "}
            {fmtPrice(summary.range_low)}-{fmtPrice(summary.range_high)}
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function ProfileRow({
  bin,
  maxPct,
  inVa,
  isCurrent,
}: {
  bin: ProfileBin;
  maxPct: number;
  inVa: boolean;
  isCurrent: boolean;
}) {
  const color = nodeColor(bin.node_type);
  const pct = Math.max(1.5, Math.min(100, (bin.pct_of_total / maxPct) * 100));
  const tag = nodeLabel(bin.node_type);
  return (
    <div
      className="grid grid-cols-[72px_1fr_56px] items-center gap-2 py-0.5"
      style={inVa ? { backgroundColor: "rgba(201,162,74,0.07)" } : undefined}
    >
      {/* Price label */}
      <div className="font-mono tabular-nums text-2xs text-right pr-1 leading-tight">
        <span className={isCurrent ? "text-accent-green font-semibold" : "text-terminal-muted"}>
          {bin.price_mid.toFixed(2)}
        </span>
      </div>

      {/* Horizontal volume bar */}
      <div className="relative h-3.5 flex items-center">
        <div
          className="h-2.5 rounded-sm"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        {tag && (
          <span
            className={`ml-1.5 text-2xs font-semibold tracking-wider ${nodeTextClass(bin.node_type)}`}
          >
            {tag}
          </span>
        )}
        {/* current-price marker line */}
        {isCurrent && (
          <div
            className="absolute inset-y-0 right-0 left-0 pointer-events-none"
            aria-hidden
          >
            <div className="absolute inset-y-0 left-0 w-full border-t border-dashed border-accent-green/60 top-1/2" />
          </div>
        )}
      </div>

      {/* % of total */}
      <div className="text-right font-mono tabular-nums text-2xs" style={{ color }}>
        {bin.pct_of_total.toFixed(1)}%
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
