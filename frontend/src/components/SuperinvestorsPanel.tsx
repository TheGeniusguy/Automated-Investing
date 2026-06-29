import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface Position {
  symbol: string;
  name: string;
  weight: number;
  market_value: number;
  shares: number;
  move: string;
  move_pct: number;
}

interface Manager {
  name: string;
  firm: string;
  cik: string;
  manager: string;
  portfolio_value: number;
  position_count: number;
  top_positions: Position[];
  top_buy: string | null;
  top_sell: string | null;
}

interface ConsensusRow {
  symbol: string;
  name: string;
  held_by: number;
  total_value: number;
}

interface Summary {
  manager_count: number;
  total_aum: number;
  most_held: string | null;
}

interface SuperinvestorsResponse {
  managers: Manager[];
  consensus: ConsensusRow[];
  summary: Summary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Move -> color. New/Add = green, Trim = amber, Sold = red.

function moveTextClass(move: string): string {
  switch (move) {
    case "New":
    case "Add":
      return "text-accent-green";
    case "Trim":
      return "text-accent-amber";
    case "Sold":
      return "text-accent-red";
    default:
      return "text-terminal-muted";
  }
}

function movePillStyle(move: string): CSSProperties {
  switch (move) {
    case "New":
      return { color: "#5f8a5a", borderColor: "#5f8a5a" };
    case "Add":
      return { color: "#6f9a64", borderColor: "#4f6a48" };
    case "Trim":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    case "Sold":
      return { color: "#c2603f", borderColor: "#c2603f" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Weight bar color: clay accent for the heaviest, cooling as weight drops.
function weightColor(weight: number): string {
  if (weight >= 30) return "#c2603f";
  if (weight >= 18) return "#cc8a55";
  if (weight >= 10) return "#c9a24a";
  if (weight >= 4) return "#8a8175";
  return "#5c554b";
}

// Local fallback so the panel renders fully populated, even offline.

const FALLBACK: SuperinvestorsResponse = (() => {
  type Seed = [string, string, string, string, Array<[string, string, number, number, string, number]>];
  const seeds: Seed[] = [
    ["Berkshire Hathaway", "Berkshire Hathaway Inc.", "0001067983", "Warren Buffett", [
      ["AAPL", "Apple Inc.", 69_900_000_000, 300_000_000, "Trim", -13.0],
      ["AXP", "American Express Co.", 41_100_000_000, 151_610_700, "Add", 0.0],
      ["BAC", "Bank of America Corp.", 30_600_000_000, 766_300_000, "Trim", -18.0],
      ["KO", "Coca-Cola Co.", 28_700_000_000, 400_000_000, "Add", 0.0],
      ["CVX", "Chevron Corp.", 18_800_000_000, 118_610_500, "Add", 3.2],
      ["OXY", "Occidental Petroleum", 13_100_000_000, 255_281_500, "Add", 2.9],
      ["MCO", "Moody's Corp.", 11_200_000_000, 24_669_778, "Add", 0.0],
      ["KHC", "Kraft Heinz Co.", 11_000_000_000, 325_634_818, "Add", 0.0],
    ]],
    ["Pershing Square", "Pershing Square Capital Mgmt", "0001336528", "Bill Ackman", [
      ["UBER", "Uber Technologies Inc.", 2_270_000_000, 30_300_000, "New", 100.0],
      ["BN", "Brookfield Corp.", 1_840_000_000, 35_280_000, "Add", 12.0],
      ["HLT", "Hilton Worldwide Holdings", 1_690_000_000, 7_350_000, "Add", 4.0],
      ["CMG", "Chipotle Mexican Grill", 1_530_000_000, 28_880_000, "Trim", -9.0],
      ["QSR", "Restaurant Brands Intl", 1_220_000_000, 17_240_000, "Add", 0.0],
      ["HHH", "Howard Hughes Holdings", 980_000_000, 13_650_000, "Add", 0.0],
      ["CP", "Canadian Pacific Kansas City", 870_000_000, 9_840_000, "Trim", -6.0],
      ["GOOGL", "Alphabet Inc. Class A", 760_000_000, 4_720_000, "Add", 8.0],
    ]],
    ["Scion Asset Management", "Scion Asset Management LLC", "0001649339", "Michael Burry", [
      ["BABA", "Alibaba Group Holding", 16_900_000, 155_000, "Add", 45.0],
      ["JD", "JD.com Inc.", 13_600_000, 340_000, "Add", 60.0],
      ["BIDU", "Baidu Inc.", 8_500_000, 80_000, "New", 100.0],
      ["MOH", "Molina Healthcare Inc.", 4_700_000, 14_000, "New", 100.0],
      ["HCA", "HCA Healthcare Inc.", 4_200_000, 12_000, "New", 100.0],
      ["BRKR", "Bruker Corp.", 3_300_000, 55_000, "New", 100.0],
      ["ACGL", "Arch Capital Group", 2_900_000, 31_000, "Trim", -20.0],
      ["REAL", "The RealReal Inc.", 1_600_000, 600_000, "Sold", -100.0],
    ]],
    ["Appaloosa Management", "Appaloosa LP", "0001656456", "David Tepper", [
      ["BABA", "Alibaba Group Holding", 720_000_000, 6_600_000, "Add", 18.0],
      ["AMZN", "Amazon.com Inc.", 540_000_000, 3_000_000, "Add", 8.0],
      ["META", "Meta Platforms Inc.", 510_000_000, 900_000, "Trim", -6.0],
      ["NVDA", "NVIDIA Corp.", 430_000_000, 3_900_000, "Trim", -14.0],
      ["MSFT", "Microsoft Corp.", 360_000_000, 860_000, "Add", 0.0],
      ["PDD", "PDD Holdings Inc.", 340_000_000, 3_200_000, "Add", 25.0],
      ["GOOG", "Alphabet Inc. Class C", 290_000_000, 1_750_000, "Add", 0.0],
      ["UBER", "Uber Technologies Inc.", 240_000_000, 3_200_000, "New", 100.0],
    ]],
    ["Third Point", "Third Point LLC", "0001040273", "Dan Loeb", [
      ["PCG", "PG&E Corp.", 720_000_000, 35_000_000, "Add", 10.0],
      ["AMZN", "Amazon.com Inc.", 610_000_000, 3_400_000, "Add", 5.0],
      ["META", "Meta Platforms Inc.", 560_000_000, 980_000, "Add", 8.0],
      ["MSFT", "Microsoft Corp.", 430_000_000, 1_030_000, "Trim", -7.0],
      ["KKR", "KKR & Co. Inc.", 380_000_000, 3_100_000, "New", 100.0],
      ["BSX", "Boston Scientific Corp.", 340_000_000, 4_100_000, "Add", 0.0],
      ["TSM", "Taiwan Semiconductor ADR", 300_000_000, 1_650_000, "Add", 22.0],
      ["DHR", "Danaher Corp.", 260_000_000, 1_080_000, "Trim", -12.0],
    ]],
    ["Duquesne Family Office", "Duquesne Family Office LLC", "0001536411", "Stanley Druckenmiller", [
      ["NTRA", "Natera Inc.", 430_000_000, 3_100_000, "Add", 16.0],
      ["MSFT", "Microsoft Corp.", 300_000_000, 720_000, "Add", 0.0],
      ["CPNG", "Coupang Inc.", 280_000_000, 12_900_000, "Add", 30.0],
      ["WMT", "Walmart Inc.", 250_000_000, 3_560_000, "New", 100.0],
      ["TEVA", "Teva Pharmaceutical ADR", 230_000_000, 12_700_000, "Add", 5.0],
      ["FLUT", "Flutter Entertainment plc", 210_000_000, 910_000, "New", 100.0],
      ["WFC", "Wells Fargo & Co.", 190_000_000, 2_900_000, "Trim", -18.0],
      ["AGCO", "AGCO Corp.", 150_000_000, 1_550_000, "Sold", -100.0],
    ]],
    ["Greenlight Capital", "Greenlight Capital Inc.", "0001079114", "David Einhorn", [
      ["GRBK", "Green Brick Partners Inc.", 450_000_000, 7_400_000, "Add", 0.0],
      ["BHF", "Brighthouse Financial Inc.", 210_000_000, 4_100_000, "Add", 6.0],
      ["CNXC", "Concentrix Corp.", 180_000_000, 3_300_000, "Add", 12.0],
      ["CNX", "CNX Resources Corp.", 160_000_000, 5_600_000, "Trim", -8.0],
      ["HPQ", "HP Inc.", 140_000_000, 4_300_000, "New", 100.0],
      ["KD", "Kyndryl Holdings Inc.", 120_000_000, 3_900_000, "Add", 9.0],
      ["ALIT", "Alight Inc.", 95_000_000, 14_000_000, "Add", 0.0],
      ["SLVM", "Sylvamo Corp.", 78_000_000, 980_000, "Trim", -15.0],
    ]],
    ["Bridgewater Associates", "Bridgewater Associates LP", "0001350694", "Ray Dalio (founder)", [
      ["IVV", "iShares Core S&P 500 ETF", 1_510_000_000, 2_640_000, "Trim", -7.0],
      ["VWO", "Vanguard FTSE Emerging Mkts", 980_000_000, 22_100_000, "Add", 14.0],
      ["GOOGL", "Alphabet Inc. Class A", 640_000_000, 3_980_000, "Add", 5.0],
      ["PG", "Procter & Gamble Co.", 520_000_000, 3_140_000, "Add", 2.0],
      ["NVDA", "NVIDIA Corp.", 480_000_000, 4_360_000, "Trim", -22.0],
      ["KO", "Coca-Cola Co.", 430_000_000, 6_000_000, "Add", 9.0],
      ["JNJ", "Johnson & Johnson", 390_000_000, 2_530_000, "Add", 0.0],
      ["META", "Meta Platforms Inc.", 360_000_000, 640_000, "Trim", -11.0],
    ]],
  ];

  const managers: Manager[] = seeds.map(([name, firm, cik, manager, rows]) => {
    const total = rows.reduce((s, r) => s + r[2], 0) || 1;
    const positions: Position[] = rows
      .map(([symbol, posName, mv, shares, move, movePct]) => ({
        symbol,
        name: posName,
        weight: Math.round((mv / total) * 10000) / 100,
        market_value: mv,
        shares,
        move,
        move_pct: movePct,
      }))
      .sort((a, b) => b.weight - a.weight);
    const buys = positions.filter((p) => p.move === "New" || p.move === "Add");
    const sells = positions.filter((p) => p.move === "Trim" || p.move === "Sold");
    return {
      name,
      firm,
      cik,
      manager,
      portfolio_value: total,
      position_count: positions.length,
      top_positions: positions,
      top_buy: buys[0]?.symbol ?? null,
      top_sell: sells[0]?.symbol ?? null,
    };
  }).sort((a, b) => b.portfolio_value - a.portfolio_value);

  const bucket = new Map<string, ConsensusRow>();
  for (const m of managers) {
    for (const p of m.top_positions) {
      const b = bucket.get(p.symbol) ?? { symbol: p.symbol, name: p.name, held_by: 0, total_value: 0 };
      b.held_by += 1;
      b.total_value += p.market_value;
      bucket.set(p.symbol, b);
    }
  }
  const consensus = [...bucket.values()]
    .sort((a, b) => b.held_by - a.held_by || b.total_value - a.total_value)
    .slice(0, 10);

  return {
    managers,
    consensus,
    summary: {
      manager_count: managers.length,
      total_aum: managers.reduce((s, m) => s + m.portfolio_value, 0),
      most_held: consensus[0]?.symbol ?? null,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtUSD(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtShares(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${v}`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;
}

// Panel

export function SuperinvestorsPanel() {
  const [data, setData] = useState<SuperinvestorsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [activeCik, setActiveCik] = useState<string>(FALLBACK.managers[0]?.cik ?? "");

  useEffect(() => {
    let alive = true;
    fetch("/api/superinvestors")
      .then((res) => res.json())
      .then((json: SuperinvestorsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.managers) && json.managers.length > 0) {
          setData(json);
          setActiveCik(json.managers[0].cik);
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

  const { managers, consensus, summary } = data;

  const active = useMemo(
    () => managers.find((m) => m.cik === activeCik) ?? managers[0],
    [managers, activeCik]
  );

  const maxWeight = useMemo(
    () => Math.max(10, ...(active?.top_positions.map((p) => p.weight) ?? [10])),
    [active]
  );

  const maxHeld = useMemo(
    () => Math.max(1, ...consensus.map((c) => c.held_by)),
    [consensus]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>SUPERINVESTOR TRACKER</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Managers Tracked">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text">
              {summary.manager_count}
            </span>
            <span className="text-2xs text-terminal-dim">13F filers</span>
          </KpiCell>
          <KpiCell label="Combined 13F AUM">
            <span className="stat-figure text-3xl text-accent-amber leading-none">
              {fmtUSD(summary.total_aum)}
            </span>
            <span className="text-2xs text-terminal-dim">reported long book</span>
          </KpiCell>
          <KpiCell label="Most Held">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.most_held ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {consensus[0] ? `held by ${consensus[0].held_by} managers` : ""}
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Clone the smart money. These are the latest reported 13F books of famous
            managers, weighted by position value, with this quarter's new buys, adds,
            trims and sold-out names flagged. The consensus board shows where the crowd overlaps.
          </p>
        </div>

        {/* Manager selector */}
        <div className="flex flex-wrap gap-1.5">
          {managers.map((m) => (
            <button
              key={m.cik}
              onClick={() => setActiveCik(m.cik)}
              className={`pill uppercase tracking-wider ${
                m.cik === active?.cik ? "text-terminal-text" : "text-terminal-dim"
              }`}
              style={{
                borderColor: m.cik === active?.cik ? "#c2603f" : "#5c554b",
                color: m.cik === active?.cik ? "#c2603f" : undefined,
              }}
            >
              {m.name}
            </button>
          ))}
        </div>

        {/* Active manager portfolio */}
        {active && (
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-2">
            {/* Manager header */}
            <div className="flex items-end justify-between gap-2 pb-1.5 border-b border-terminal-divider">
              <div className="min-w-0">
                <div className="font-mono text-sm text-terminal-text font-semibold truncate">
                  {active.name}
                </div>
                <div className="text-2xs text-terminal-dim truncate">
                  {active.manager} &middot; {active.firm} &middot; CIK {active.cik}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 text-right">
                <div>
                  <div className="text-2xs text-terminal-dim uppercase tracking-wider">Top Buy</div>
                  <div className="font-mono text-xs text-accent-green">{active.top_buy ?? "--"}</div>
                </div>
                <div>
                  <div className="text-2xs text-terminal-dim uppercase tracking-wider">Top Sell</div>
                  <div className="font-mono text-xs text-accent-red">{active.top_sell ?? "--"}</div>
                </div>
                <div>
                  <div className="text-2xs text-terminal-dim uppercase tracking-wider">Book</div>
                  <div className="font-mono text-xs text-terminal-text tabular-nums">
                    {fmtUSD(active.portfolio_value)}
                  </div>
                </div>
              </div>
            </div>

            {/* Column header */}
            <div className="grid grid-cols-[120px_1fr_70px_64px_56px] items-center gap-2 pb-1 border-b border-terminal-divider">
              <SectionLabel>Position</SectionLabel>
              <SectionLabel>Portfolio weight</SectionLabel>
              <SectionLabel right>Value</SectionLabel>
              <SectionLabel right>Shares</SectionLabel>
              <SectionLabel right>Move</SectionLabel>
            </div>

            <div className="flex flex-col">
              {active.top_positions.map((p, i) => (
                <PositionRow key={`${p.symbol}-${i}`} pos={p} maxWeight={maxWeight} rank={i + 1} />
              ))}
            </div>
          </div>
        )}

        {/* Smart-money consensus */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider pb-1.5 mb-1 border-b border-terminal-divider">
            Smart-Money Consensus &middot; most widely held names
          </div>
          <div className="flex flex-col">
            {consensus.map((c, i) => (
              <ConsensusRowView key={c.symbol} row={c} maxHeld={maxHeld} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#6f9a64" label="New / Add" />
            <LegendSwatch color="#c9a24a" label="Trim" />
            <LegendSwatch color="#c2603f" label="Sold" />
          </div>
          <span className="uppercase tracking-wider">Weights from latest reported 13F-HR market values</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function PositionRow({ pos, maxWeight, rank }: { pos: Position; maxWeight: number; rank: number }) {
  const color = weightColor(pos.weight);
  const pct = Math.max(2, Math.min(100, (pos.weight / maxWeight) * 100));
  return (
    <div className="grid grid-cols-[120px_1fr_70px_64px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Symbol + name */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{pos.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{pos.name}</span>
      </div>

      {/* Weight bar */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative h-2.5 flex-1 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-2xs font-semibold tabular-nums shrink-0 w-10 text-right" style={{ color }}>
          {pos.weight.toFixed(1)}%
        </span>
      </div>

      {/* Value */}
      <div className="text-right font-mono tabular-nums text-xs text-terminal-text">
        {fmtUSD(pos.market_value)}
      </div>

      {/* Shares */}
      <div className="text-right font-mono tabular-nums text-2xs text-terminal-muted">
        {fmtShares(pos.shares)}
      </div>

      {/* Move pill + pct */}
      <div className="flex flex-col items-end gap-0.5">
        <span className="pill uppercase tracking-wider" style={movePillStyle(pos.move)}>
          {pos.move}
        </span>
        {pos.move_pct !== 0 && pos.move !== "New" && pos.move !== "Sold" && (
          <span className={`text-2xs tabular-nums ${moveTextClass(pos.move)}`}>
            {fmtPct(pos.move_pct)}
          </span>
        )}
      </div>
    </div>
  );
}

function ConsensusRowView({ row, maxHeld, rank }: { row: ConsensusRow; maxHeld: number; rank: number }) {
  const pct = Math.max(8, Math.min(100, (row.held_by / maxHeld) * 100));
  return (
    <div className="grid grid-cols-[120px_1fr_64px_70px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.name}</span>
      </div>
      <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, backgroundColor: "#cc8a55" }}
        />
      </div>
      <div className="text-right font-mono tabular-nums text-xs">
        <span className="text-accent-amber font-semibold">{row.held_by}</span>
        <span className="text-terminal-dim text-2xs"> mgrs</span>
      </div>
      <div className="text-right font-mono tabular-nums text-xs text-terminal-muted">
        {fmtUSD(row.total_value)}
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
