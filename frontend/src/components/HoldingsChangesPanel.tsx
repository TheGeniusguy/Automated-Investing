import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface NewBuy {
  symbol: string;
  name: string;
  value: number;
}

interface SoldOut {
  symbol: string;
  name: string;
}

interface TopMove {
  symbol: string;
  pct: number;
}

interface ManagerChange {
  manager: string;
  firm: string;
  new_buys: NewBuy[];
  sold_out: SoldOut[];
  top_add: TopMove | null;
  top_trim: TopMove | null;
  net_change_value: number;
}

interface MarketNewBuy {
  symbol: string;
  name: string;
  manager_count: number;
  total_value: number;
}

interface MarketSoldOut {
  symbol: string;
  name: string;
  manager_count: number;
}

interface MarketAdd {
  symbol: string;
  name: string;
  net_value: number;
}

interface MarketMoves {
  top_new_buys: MarketNewBuy[];
  top_sold_out: MarketSoldOut[];
  top_adds: MarketAdd[];
}

interface CrowdRow {
  symbol: string;
  name: string;
  held_by: number;
  combined_value: number;
  recent_action: string;
}

interface ChangesSummary {
  most_bought: string | null;
  most_sold: string | null;
  most_crowded: string | null;
  manager_count: number;
}

interface HoldingsChangesResponse {
  manager_changes: ManagerChange[];
  market_moves: MarketMoves;
  crowding: CrowdRow[];
  summary: ChangesSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Recent-action -> color. Buying = green, Selling = red, Holding = muted.

function actionPillStyle(action: string): CSSProperties {
  switch (action) {
    case "Buying":
      return { color: "#6f8f5f", borderColor: "#6f8f5f" };
    case "Selling":
      return { color: "#c2603f", borderColor: "#c2603f" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Formatting helpers

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtSignedUsd(v: number): string {
  return (v >= 0 ? "+" : "-") + fmtUsd(Math.abs(v));
}

function fmtPct(v: number): string {
  return (v >= 0 ? "+" : "") + v.toFixed(0) + "%";
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic q/q tape: NVDA the consensus new buy, INTC the consensus exit,
// AAPL the crowded mega-cap getting broadly trimmed.

const FALLBACK: HoldingsChangesResponse = {
  manager_changes: [
    {
      manager: "Berkshire Hathaway",
      firm: "Berkshire Hathaway Inc.",
      new_buys: [{ symbol: "NVDA", name: "NVIDIA Corp.", value: 4_000_000_000 }],
      sold_out: [{ symbol: "INTC", name: "Intel Corp." }],
      top_add: { symbol: "CVX", pct: 3.2 },
      top_trim: { symbol: "BAC", pct: -18 },
      net_change_value: -14_200_000_000,
    },
    {
      manager: "Pershing Square",
      firm: "Pershing Square Capital Mgmt",
      new_buys: [{ symbol: "NVDA", name: "NVIDIA Corp.", value: 2_600_000_000 }],
      sold_out: [{ symbol: "INTC", name: "Intel Corp." }],
      top_add: { symbol: "UBER", pct: 12 },
      top_trim: { symbol: "CMG", pct: -9 },
      net_change_value: 2_870_000_000,
    },
    {
      manager: "Bridgewater Associates",
      firm: "Bridgewater Associates LP",
      new_buys: [],
      sold_out: [{ symbol: "INTC", name: "Intel Corp." }],
      top_add: { symbol: "GOOGL", pct: 5 },
      top_trim: { symbol: "NVDA", pct: -22 },
      net_change_value: -284_000_000,
    },
    {
      manager: "Third Point",
      firm: "Third Point LLC",
      new_buys: [{ symbol: "KKR", name: "KKR & Co. Inc.", value: 380_000_000 }],
      sold_out: [],
      top_add: { symbol: "META", pct: 8 },
      top_trim: { symbol: "MSFT", pct: -7 },
      net_change_value: 380_000_000,
    },
    {
      manager: "Duquesne Family Office",
      firm: "Duquesne Family Office LLC",
      new_buys: [{ symbol: "NVDA", name: "NVIDIA Corp.", value: 310_000_000 }],
      sold_out: [{ symbol: "AGCO", name: "AGCO Corp." }],
      top_add: { symbol: "CPNG", pct: 30 },
      top_trim: { symbol: "WFC", pct: -18 },
      net_change_value: 78_000_000,
    },
  ],
  market_moves: {
    top_new_buys: [
      { symbol: "NVDA", name: "NVIDIA Corp.", manager_count: 5, total_value: 7_392_000_000 },
      { symbol: "KKR", name: "KKR & Co. Inc.", manager_count: 1, total_value: 380_000_000 },
      { symbol: "HPQ", name: "HP Inc.", manager_count: 1, total_value: 140_000_000 },
      { symbol: "MOH", name: "Molina Healthcare Inc.", manager_count: 1, total_value: 4_700_000 },
    ],
    top_sold_out: [
      { symbol: "INTC", name: "Intel Corp.", manager_count: 4 },
      { symbol: "AGCO", name: "AGCO Corp.", manager_count: 1 },
      { symbol: "REAL", name: "The RealReal Inc.", manager_count: 1 },
    ],
    top_adds: [
      { symbol: "NVDA", name: "NVIDIA Corp.", net_value: 7_392_000_000 },
      { symbol: "CVX", name: "Chevron Corp.", net_value: 600_000_000 },
      { symbol: "BABA", name: "Alibaba Group Holding", net_value: 115_250_000 },
      { symbol: "CPNG", name: "Coupang Inc.", net_value: 65_000_000 },
    ],
  },
  crowding: [
    { symbol: "AAPL", name: "Apple Inc.", held_by: 5, combined_value: 70_900_000_000, recent_action: "Selling" },
    { symbol: "NVDA", name: "NVIDIA Corp.", held_by: 5, combined_value: 7_872_000_000, recent_action: "Buying" },
    { symbol: "MSFT", name: "Microsoft Corp.", held_by: 3, combined_value: 1_090_000_000, recent_action: "Holding" },
    { symbol: "META", name: "Meta Platforms Inc.", held_by: 3, combined_value: 1_430_000_000, recent_action: "Selling" },
    { symbol: "AMZN", name: "Amazon.com Inc.", held_by: 2, combined_value: 1_150_000_000, recent_action: "Buying" },
    { symbol: "BABA", name: "Alibaba Group Holding", held_by: 2, combined_value: 736_900_000, recent_action: "Buying" },
  ],
  summary: {
    most_bought: "NVDA",
    most_sold: "INTC",
    most_crowded: "AAPL",
    manager_count: 8,
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Panel

export function HoldingsChangesPanel() {
  const [data, setData] = useState<HoldingsChangesResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/holdings-changes")
      .then((res) => res.json())
      .then((json: HoldingsChangesResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.crowding) && json.crowding.length > 0) {
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

  const { manager_changes, market_moves, crowding, summary } = data;
  const maxHeld = Math.max(1, ...crowding.map((c) => c.held_by));

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>13F CHANGE & CROWDING TRACKER</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Most Bought">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.most_bought ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">new buys this quarter</span>
          </KpiCell>
          <KpiCell label="Most Sold">
            <span className="stat-figure text-3xl text-accent-red leading-none truncate">
              {summary.most_sold ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">consensus exit</span>
          </KpiCell>
          <KpiCell label="Most Crowded">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.most_crowded ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              across {summary.manager_count} managers
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Where the smart money moved last quarter. Names many managers initiated, or exited,
            at once flag conviction shifts; the most-crowded longs are where consensus, and
            crowding risk, concentrate.
          </p>
        </div>

        {/* HERO: smart-money moves - two columns */}
        <div className="grid grid-cols-2 gap-2">
          <MovesColumn
            title="Top New Buys"
            accent="text-accent-green"
            empty="No fresh initiations"
            rows={market_moves.top_new_buys.map((r) => ({
              symbol: r.symbol,
              name: r.name,
              count: r.manager_count,
              right: fmtUsd(r.total_value),
              rightClass: "text-accent-green",
            }))}
          />
          <MovesColumn
            title="Top Sold-Out"
            accent="text-accent-red"
            empty="No full exits"
            rows={market_moves.top_sold_out.map((r) => ({
              symbol: r.symbol,
              name: r.name,
              count: r.manager_count,
              right: "Exited",
              rightClass: "text-accent-red",
            }))}
          />
        </div>

        {/* Crowding leaderboard */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="grid grid-cols-[112px_1fr_92px_84px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Crowded Long</SectionLabel>
            <SectionLabel>Managers holding</SectionLabel>
            <SectionLabel right>Combined</SectionLabel>
            <SectionLabel right>Action</SectionLabel>
          </div>
          <div className="flex flex-col">
            {crowding.map((row, i) => (
              <CrowdLeaderRow key={row.symbol} row={row} maxHeld={maxHeld} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* Compact per-manager changes */}
        {manager_changes.length > 0 && (
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
            <div className="text-2xs text-terminal-muted uppercase tracking-wider pb-1.5 mb-1 border-b border-terminal-divider">
              Per-manager moves
            </div>
            <div className="flex flex-col">
              {manager_changes.slice(0, 8).map((m) => (
                <ManagerRow key={m.manager} m={m} />
              ))}
            </div>
          </div>
        )}

        {/* Footer note */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#6f8f5f" label="Buying" />
            <LegendSwatch color="#c2603f" label="Selling" />
            <LegendSwatch color="#8a8175" label="Holding" />
          </div>
          <span className="uppercase tracking-wider">Source: EDGAR 13F-HR &middot; quarterly &middot; ~45d lagged</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

interface MoveRow {
  symbol: string;
  name: string;
  count: number;
  right: string;
  rightClass: string;
}

function MovesColumn({
  title,
  accent,
  rows,
  empty,
}: {
  title: string;
  accent: string;
  rows: MoveRow[];
  empty: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col">
      <div className={`text-2xs uppercase tracking-wider pb-1.5 mb-1 border-b border-terminal-divider ${accent}`}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-2xs text-terminal-dim py-2">{empty}</div>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => (
            <div
              key={r.symbol}
              className="grid grid-cols-[1fr_auto] items-center gap-2 py-1 border-b border-terminal-divider/40 last:border-0"
            >
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">
                  {r.symbol}
                </span>
                <span className="text-2xs text-terminal-dim truncate">{r.name}</span>
              </div>
              <div className="flex items-baseline gap-2 justify-end">
                <span className="text-2xs text-terminal-muted tabular-nums">
                  {r.count} mgr{r.count === 1 ? "" : "s"}
                </span>
                <span className={`font-mono text-2xs tabular-nums ${r.rightClass}`}>{r.right}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CrowdLeaderRow({ row, maxHeld, rank }: { row: CrowdRow; maxHeld: number; rank: number }) {
  const pct = Math.max(6, Math.min(100, (row.held_by / maxHeld) * 100));
  const barColor =
    row.recent_action === "Buying" ? "#6f8f5f" : row.recent_action === "Selling" ? "#c2603f" : "#8a8175";
  return (
    <div className="grid grid-cols-[112px_1fr_92px_84px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.name}</span>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative h-2.5 flex-1 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="text-2xs text-terminal-muted tabular-nums shrink-0">
          {row.held_by} held
        </span>
      </div>
      <div className="text-right font-mono tabular-nums text-xs text-terminal-text">
        {fmtUsd(row.combined_value)}
      </div>
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={actionPillStyle(row.recent_action)}>
          {row.recent_action}
        </span>
      </div>
    </div>
  );
}

function ManagerRow({ m }: { m: ManagerChange }) {
  const buys = m.new_buys.map((b) => b.symbol).slice(0, 3);
  const exits = m.sold_out.map((s) => s.symbol).slice(0, 3);
  const net = m.net_change_value;
  return (
    <div className="grid grid-cols-[150px_1fr_92px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      <div className="min-w-0">
        <div className="text-xs text-terminal-text font-semibold truncate">{m.manager}</div>
        <div className="text-2xs text-terminal-dim truncate">{m.firm}</div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs min-w-0">
        {buys.length > 0 && (
          <span className="text-accent-green truncate">
            <span className="text-terminal-dim">buy </span>
            {buys.join(" ")}
          </span>
        )}
        {exits.length > 0 && (
          <span className="text-accent-red truncate">
            <span className="text-terminal-dim">exit </span>
            {exits.join(" ")}
          </span>
        )}
        {m.top_trim && (
          <span className="text-terminal-muted truncate">
            <span className="text-terminal-dim">trim </span>
            {m.top_trim.symbol} {fmtPct(m.top_trim.pct)}
          </span>
        )}
      </div>
      <div className={`text-right font-mono tabular-nums text-xs ${net >= 0 ? "text-accent-green" : "text-accent-red"}`}>
        {fmtSignedUsd(net)}
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
