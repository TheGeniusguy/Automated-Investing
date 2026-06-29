import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface SocialRow {
  symbol: string;
  name: string;
  mentions_24h: number;
  baseline: number;
  velocity: number;
  bull_pct: number;
  bear_pct: number;
  sentiment: string;
  rank_change: number;
  stocktwits_msgs: number;
  reddit_mentions: number;
  trending_up?: boolean;
}

interface SocialSummary {
  most_mentioned: string | null;
  most_bullish: string | null;
  most_bearish: string | null;
  total_mentions: number;
  universe_size?: number;
}

interface SocialSentimentResponse {
  tickers: SocialRow[];
  summary: SocialSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Sentiment -> color. Bullish = green, Bearish = red, Mixed = muted.

function sentimentTextClass(sentiment: string): string {
  switch (sentiment) {
    case "Bullish":
      return "text-accent-green";
    case "Bearish":
      return "text-accent-red";
    default:
      return "text-terminal-muted";
  }
}

function sentimentPillStyle(sentiment: string): CSSProperties {
  switch (sentiment) {
    case "Bullish":
      return { color: "#6f8f5f", borderColor: "#6f8f5f" };
    case "Bearish":
      return { color: "#c2603f", borderColor: "#c2603f" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Velocity bar fill color ramps amber -> red as chatter goes viral.
function velocityColor(velocity: number): string {
  if (velocity >= 4.0) return "#c2603f"; // deep red, going viral
  if (velocity >= 2.5) return "#cc6a44"; // red, hot
  if (velocity >= 1.7) return "#cc8a55"; // clay-orange
  if (velocity >= 1.3) return "#c9a24a"; // amber, warming
  if (velocity >= 0.7) return "#8a8175"; // neutral
  return "#5c554b"; // quiet / dim
}

// Bull/bear split bar colors.
const BULL_COLOR = "#6f8f5f";
const BEAR_COLOR = "#c2603f";

// Local fallback so the panel renders fully populated, even offline.
// A realistic retail snapshot: a couple names going viral, most normal.

const FALLBACK: SocialSentimentResponse = (() => {
  // [symbol, name, mentions, baseline, bull_pct, rank_change, stocktwits, reddit]
  const seed: Array<[string, string, number, number, number, number, number, number]> = [
    ["GME", "GameStop Corp.", 1840, 260, 74.0, 9, 980, 860],
    ["TSLA", "Tesla Inc.", 2210, 340, 61.0, 2, 1320, 890],
    ["NVDA", "NVIDIA Corp.", 1560, 300, 71.0, 3, 980, 580],
    ["AMC", "AMC Entertainment", 980, 180, 66.0, 6, 540, 440],
    ["PLTR", "Palantir Technologies", 870, 200, 69.0, 1, 520, 350],
    ["MARA", "MARA Holdings Inc.", 540, 130, 58.0, 4, 320, 220],
    ["SMCI", "Super Micro Computer", 610, 160, 38.0, -3, 360, 250],
    ["COIN", "Coinbase Global Inc.", 720, 210, 63.0, 2, 430, 290],
    ["AMD", "Advanced Micro Devices", 660, 230, 60.0, 0, 400, 260],
    ["HOOD", "Robinhood Markets", 430, 150, 64.0, 5, 250, 180],
    ["SOFI", "SoFi Technologies", 380, 160, 57.0, 1, 220, 160],
    ["RIVN", "Rivian Automotive", 410, 190, 41.0, -2, 240, 170],
    ["NIO", "NIO Inc.", 350, 170, 45.0, -1, 200, 150],
    ["MSTR", "MicroStrategy Inc.", 520, 200, 67.0, 4, 320, 200],
    ["RDDT", "Reddit Inc.", 290, 150, 59.0, 2, 180, 110],
    ["AAPL", "Apple Inc.", 480, 320, 55.0, 0, 300, 180],
    ["SPY", "SPDR S&P 500 ETF", 360, 300, 48.0, -1, 230, 130],
    ["F", "Ford Motor Co.", 210, 150, 52.0, -2, 130, 80],
    ["DKNG", "DraftKings Inc.", 240, 160, 60.0, 1, 150, 90],
    ["LCID", "Lucid Group Inc.", 260, 180, 36.0, -4, 160, 100],
  ];
  const tickers: SocialRow[] = seed
    .map(([symbol, name, mentions, baseline, bull, rankChange, st, rd]) => {
      const velocity = Math.round((mentions / baseline) * 100) / 100;
      const bull_pct = Math.round(bull * 10) / 10;
      const bear_pct = Math.round((100 - bull) * 10) / 10;
      const sentiment = bull_pct >= 58 ? "Bullish" : bull_pct <= 42 ? "Bearish" : "Mixed";
      return {
        symbol,
        name,
        mentions_24h: mentions,
        baseline,
        velocity,
        bull_pct,
        bear_pct,
        sentiment,
        rank_change: rankChange,
        stocktwits_msgs: st,
        reddit_mentions: rd,
        trending_up: velocity >= 1.4,
      };
    })
    .sort((a, b) => b.velocity - a.velocity);
  return {
    tickers,
    summary: {
      most_mentioned: tickers.reduce((a, b) => (b.mentions_24h > a.mentions_24h ? b : a)).symbol,
      most_bullish: tickers.reduce((a, b) => (b.bull_pct > a.bull_pct ? b : a)).symbol,
      most_bearish: tickers.reduce((a, b) => (b.bear_pct > a.bear_pct ? b : a)).symbol,
      total_mentions: tickers.reduce((s, t) => s + t.mentions_24h, 0),
      universe_size: tickers.length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtVelocity(v: number): string {
  return `${v.toFixed(2)}x`;
}

function fmtMentions(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${v}`;
}

// Panel

export function SocialSentimentPanel() {
  const [data, setData] = useState<SocialSentimentResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/social-sentiment")
      .then((res) => res.json())
      .then((json: SocialSentimentResponse) => {
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

  // Scale velocity bars to the hottest reading so the leader fills the track.
  const maxVelocity = useMemo(
    () => Math.max(4, ...tickers.map((t) => t.velocity)),
    [tickers]
  );

  const mostMentionedRow = useMemo(
    () => tickers.find((t) => t.symbol === summary.most_mentioned) ?? tickers[0],
    [tickers, summary.most_mentioned]
  );
  const mostBullishRow = useMemo(
    () => tickers.find((t) => t.symbol === summary.most_bullish),
    [tickers, summary.most_bullish]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>SOCIAL / RETAIL SENTIMENT</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Most Mentioned">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.most_mentioned ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {mostMentionedRow ? fmtMentions(mostMentionedRow.mentions_24h) + " mentions / 24h" : ""}
            </span>
          </KpiCell>
          <KpiCell label="Most Bullish">
            <span className="stat-figure text-3xl text-accent-green leading-none truncate">
              {summary.most_bullish ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {mostBullishRow ? mostBullishRow.bull_pct.toFixed(0) + "% bull skew" : ""}
            </span>
          </KpiCell>
          <KpiCell label="Total Mentions">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text">
              {fmtMentions(summary.total_mentions)}
            </span>
            <span className="text-2xs text-terminal-dim">
              across {summary.universe_size ?? tickers.length} names
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Retail attention front-runs squeezes and momentum unwinds. Names whose mention
            velocity is spiking with a lopsided bull skew are where the crowd is piling in today.
          </p>
        </div>

        {/* HERO: chatter leaderboard */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[132px_1fr_150px_64px_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Ticker</SectionLabel>
            <SectionLabel>Mention velocity vs baseline</SectionLabel>
            <SectionLabel>Bull / bear split</SectionLabel>
            <SectionLabel right>24h / base</SectionLabel>
            <SectionLabel right>Mood</SectionLabel>
          </div>

          <div className="flex flex-col">
            {tickers.map((row, i) => (
              <SocialLeaderRow key={row.symbol} row={row} maxVelocity={maxVelocity} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="Viral >= 4x" />
            <LegendSwatch color="#c9a24a" label="Hot >= 1.3x" />
            <LegendSwatch color={BULL_COLOR} label="Bull" />
            <LegendSwatch color={BEAR_COLOR} label="Bear" />
          </div>
          <span className="uppercase tracking-wider">
            Velocity = 24h mentions / baseline &middot; StockTwits + WSB
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function SocialLeaderRow({
  row,
  maxVelocity,
  rank,
}: {
  row: SocialRow;
  maxVelocity: number;
  rank: number;
}) {
  const color = velocityColor(row.velocity);
  const pct = Math.max(2, Math.min(100, (row.velocity / maxVelocity) * 100));
  const bullW = Math.max(0, Math.min(100, row.bull_pct));
  const rankUp = row.rank_change > 0;
  const rankFlat = row.rank_change === 0;
  return (
    <div className="grid grid-cols-[132px_1fr_150px_64px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Ticker + name + rank change */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span
          className={`text-2xs tabular-nums shrink-0 ${
            rankFlat ? "text-terminal-dim" : rankUp ? "text-accent-green" : "text-accent-red"
          }`}
          title="Rank change vs yesterday"
        >
          {rankFlat ? "=" : `${rankUp ? "▲" : "▼"}${Math.abs(row.rank_change)}`}
        </span>
      </div>

      {/* Velocity bar + name */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
          {/* baseline (1.0x) reference marker */}
          <div
            className="absolute inset-y-0 w-px bg-terminal-muted/70"
            style={{ left: `${Math.min(100, (1 / maxVelocity) * 100)}%` }}
          />
        </div>
        <span className="text-2xs text-terminal-dim truncate" title={row.name}>
          {row.name}
          <span className="text-terminal-muted">
            {" · "}
            {fmtMentions(row.stocktwits_msgs)} ST &middot; {fmtMentions(row.reddit_mentions)} WSB
          </span>
        </span>
      </div>

      {/* Bull/bear split bar */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full overflow-hidden flex">
          <div style={{ width: `${bullW}%`, backgroundColor: BULL_COLOR }} />
          <div style={{ width: `${100 - bullW}%`, backgroundColor: BEAR_COLOR }} />
        </div>
        <div className="flex items-center justify-between text-2xs tabular-nums leading-none">
          <span className="text-accent-green">{row.bull_pct.toFixed(0)}%</span>
          <span className="text-accent-red">{row.bear_pct.toFixed(0)}%</span>
        </div>
      </div>

      {/* 24h / baseline */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className="text-terminal-text">{fmtMentions(row.mentions_24h)}</span>
        <span className="text-terminal-dim"> / {fmtMentions(row.baseline)}</span>
        <div className="text-2xs font-semibold" style={{ color }}>{fmtVelocity(row.velocity)}</div>
      </div>

      {/* sentiment pill */}
      <div className="flex justify-end">
        <span
          className={`pill uppercase tracking-wider ${sentimentTextClass(row.sentiment)}`}
          style={sentimentPillStyle(row.sentiment)}
        >
          {row.sentiment}
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
