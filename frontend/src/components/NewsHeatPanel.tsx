import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface HeatRow {
  symbol: string;
  name: string;
  articles_24h: number;
  baseline: number;
  heat_ratio: number;
  z_score: number;
  status: string;
  latest_headline: string;
  sentiment_hint?: string;
}

interface HeatSummary {
  hot_count: number;
  hottest: string | null;
  total_articles: number;
  universe_size?: number;
}

interface NewsHeatResponse {
  tickers: HeatRow[];
  summary: HeatSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Status -> color. Hot = red, Warm = amber, Normal = neutral, Quiet = dim.

function statusTextClass(status: string): string {
  switch (status) {
    case "Hot":
      return "text-accent-red";
    case "Warm":
      return "text-accent-amber";
    case "Quiet":
      return "text-terminal-dim";
    default:
      return "text-terminal-muted";
  }
}

function statusPillStyle(status: string): CSSProperties {
  switch (status) {
    case "Hot":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "Warm":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    case "Quiet":
      return { color: "#8a8175", borderColor: "#5c554b" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Heat bar fill color ramps amber -> red as the ratio climbs.
function heatColor(ratio: number): string {
  if (ratio >= 3.2) return "#c2603f"; // deep red, very hot
  if (ratio >= 2.2) return "#cc6a44"; // red
  if (ratio >= 1.7) return "#cc8a55"; // clay-orange
  if (ratio >= 1.3) return "#c9a24a"; // amber
  if (ratio >= 0.7) return "#8a8175"; // neutral
  return "#5c554b"; // quiet / dim
}

function sentimentClass(hint?: string): string {
  if (hint === "Positive") return "text-accent-green";
  if (hint === "Negative") return "text-accent-red";
  return "text-terminal-dim";
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic desk snapshot: a handful of names running hot, most normal.

const FALLBACK: NewsHeatResponse = (() => {
  const seed: Array<[string, string, number, number, string, string]> = [
    ["NVDA", "NVIDIA Corp.", 19, 4.6, "NVIDIA unveils next-gen accelerator as data-center demand stays red hot", "Positive"],
    ["TSLA", "Tesla Inc.", 16, 5.1, "Tesla robotaxi timeline draws fresh scrutiny from analysts and regulators", "Negative"],
    ["SMCI", "Super Micro Computer", 12, 3.2, "Super Micro slides as auditor questions linger over filing delay", "Negative"],
    ["COIN", "Coinbase Global Inc.", 14, 4.0, "Coinbase rallies with crypto majors as spot ETF inflows accelerate", "Positive"],
    ["GME", "GameStop Corp.", 11, 3.4, "GameStop spikes again on options-fueled retail buying wave", "Neutral"],
    ["PLTR", "Palantir Technologies", 9, 3.1, "Palantir lands expanded government AI contract, shares jump", "Positive"],
    ["AAPL", "Apple Inc.", 13, 8.4, "Apple reportedly accelerates AI roadmap ahead of fall hardware cycle", "Positive"],
    ["AMD", "Advanced Micro Devices", 8, 4.8, "AMD guidance lifted on AI GPU traction versus incumbent", "Positive"],
    ["BA", "Boeing Co.", 7, 5.2, "Boeing faces renewed FAA review over production quality controls", "Negative"],
    ["META", "Meta Platforms Inc.", 9, 6.7, "Meta ad revenue beats as Reels monetization closes the gap", "Positive"],
    ["MSFT", "Microsoft Corp.", 8, 7.1, "Microsoft expands Copilot enterprise tier amid cloud reacceleration", "Neutral"],
    ["AMZN", "Amazon.com Inc.", 7, 6.9, "Amazon Web Services margins expand on AI workload demand", "Positive"],
    ["LLY", "Eli Lilly & Co.", 6, 5.4, "Eli Lilly GLP-1 supply expands as demand keeps outrunning capacity", "Positive"],
    ["INTC", "Intel Corp.", 6, 5.5, "Intel foundry losses widen, turnaround timeline pushed out", "Negative"],
    ["JPM", "JPMorgan Chase & Co.", 5, 6.1, "JPMorgan flags resilient consumer but cautious credit outlook", "Neutral"],
    ["DIS", "Walt Disney Co.", 5, 5.8, "Disney streaming swings to profit, parks demand holds", "Positive"],
    ["NFLX", "Netflix Inc.", 4, 5.7, "Netflix ad tier scales faster than the Street modeled", "Positive"],
    ["XOM", "Exxon Mobil Corp.", 4, 6.2, "Exxon weighs new buyback as crude holds a tight range", "Neutral"],
    ["WMT", "Walmart Inc.", 3, 6.4, "Walmart raises outlook as grocery share gains continue", "Positive"],
    ["KO", "Coca-Cola Co.", 2, 5.9, "Coca-Cola pricing offsets soft volumes in key markets", "Neutral"],
  ];
  const tickers: HeatRow[] = seed
    .map(([symbol, name, articles, baseline, headline, sent]) => {
      const ratio = Math.round((articles / baseline) * 100) / 100;
      const sigma = Math.sqrt(Math.max(baseline, 1));
      const z = Math.round(((articles - baseline) / sigma) * 100) / 100;
      const status = ratio >= 2.2 ? "Hot" : ratio >= 1.4 ? "Warm" : ratio <= 0.6 ? "Quiet" : "Normal";
      return {
        symbol,
        name,
        articles_24h: articles,
        baseline,
        heat_ratio: ratio,
        z_score: z,
        status,
        latest_headline: headline,
        sentiment_hint: sent,
      };
    })
    .sort((a, b) => b.heat_ratio - a.heat_ratio);
  const hot = tickers.filter((t) => t.status === "Hot");
  return {
    tickers,
    summary: {
      hot_count: hot.length,
      hottest: tickers[0]?.symbol ?? null,
      total_articles: tickers.reduce((s, t) => s + t.articles_24h, 0),
      universe_size: tickers.length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtRatio(v: number): string {
  return `${v.toFixed(2)}x`;
}

function fmtZ(v: number): string {
  return (v >= 0 ? "+" : "") + v.toFixed(1);
}

// Panel

export function NewsHeatPanel() {
  const [data, setData] = useState<NewsHeatResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/news-heat")
      .then((res) => res.json())
      .then((json: NewsHeatResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.tickers) && json.tickers.length > 0) {
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

  const { tickers, summary } = data;

  // Scale heat bars to the hottest reading so the leader fills the track.
  const maxRatio = useMemo(
    () => Math.max(3, ...tickers.map((t) => t.heat_ratio)),
    [tickers]
  );

  const hottestRow = tickers[0];

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>NEWS HEAT MONITOR</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Hot Names">
            <span className={`stat-figure text-3xl tabular-nums ${summary.hot_count > 0 ? "text-accent-red" : "text-terminal-muted"}`}>
              {summary.hot_count}
            </span>
            <span className="text-2xs text-terminal-dim">spiking now</span>
          </KpiCell>
          <KpiCell label="Hottest">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.hottest ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {hottestRow ? fmtRatio(hottestRow.heat_ratio) + " vs baseline" : ""}
            </span>
          </KpiCell>
          <KpiCell label="Articles Scanned">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text">
              {summary.total_articles}
            </span>
            <span className="text-2xs text-terminal-dim">
              across {summary.universe_size ?? tickers.length} names
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Spikes in news volume often precede or accompany big price moves. Names running
            well above their normal coverage are where attention, and risk, is concentrating today.
          </p>
        </div>

        {/* HERO: heat leaderboard */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[112px_1fr_64px_56px_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Ticker</SectionLabel>
            <SectionLabel>Heat vs baseline / latest headline</SectionLabel>
            <SectionLabel right>24h / base</SectionLabel>
            <SectionLabel right>z-score</SectionLabel>
            <SectionLabel right>Status</SectionLabel>
          </div>

          <div className="flex flex-col">
            {tickers.map((row, i) => (
              <HeatLeaderRow key={row.symbol} row={row} maxRatio={maxRatio} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="Hot >= 2.2x" />
            <LegendSwatch color="#c9a24a" label="Warm >= 1.4x" />
            <LegendSwatch color="#8a8175" label="Normal" />
            <LegendSwatch color="#5c554b" label="Quiet <= 0.6x" />
          </div>
          <span className="uppercase tracking-wider">Heat ratio = 48h headline count / rolling daily baseline</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function HeatLeaderRow({ row, maxRatio, rank }: { row: HeatRow; maxRatio: number; rank: number }) {
  const color = heatColor(row.heat_ratio);
  const pct = Math.max(2, Math.min(100, (row.heat_ratio / maxRatio) * 100));
  return (
    <div className="grid grid-cols-[112px_1fr_64px_56px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Ticker + name */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.name}</span>
      </div>

      {/* Heat bar + headline */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
          {/* baseline (1.0x) reference marker */}
          <div
            className="absolute inset-y-0 w-px bg-terminal-muted/70"
            style={{ left: `${Math.min(100, (1 / maxRatio) * 100)}%` }}
          />
        </div>
        <span className="text-2xs text-terminal-muted truncate" title={row.latest_headline}>
          <span className={`mr-1 ${sentimentClass(row.sentiment_hint)}`}>&bull;</span>
          {row.latest_headline}
        </span>
      </div>

      {/* 24h / baseline */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className="text-terminal-text">{row.articles_24h}</span>
        <span className="text-terminal-dim"> / {row.baseline.toFixed(1)}</span>
        <div className="text-2xs font-semibold" style={{ color }}>{fmtRatio(row.heat_ratio)}</div>
      </div>

      {/* z-score */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span className={statusTextClass(row.status)}>{fmtZ(row.z_score)}</span>
      </div>

      {/* status pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={statusPillStyle(row.status)}>
          {row.status}
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
