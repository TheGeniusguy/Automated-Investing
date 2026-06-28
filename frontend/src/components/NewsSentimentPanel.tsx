import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface NSArticle {
  title: string;
  publisher: string;
  date: string;
  url: string;
  score: number;
  tone: "positive" | "negative" | "neutral";
}
interface NSTrendPoint {
  date: string;
  score: number;
}
interface NewsSentimentResponse {
  symbol: string;
  sentiment_score: number;
  label: string;
  positive_count: number;
  negative_count: number;
  neutral_count: number;
  trend: NSTrendPoint[];
  articles: NSArticle[];
  most_positive: NSArticle | null;
  most_negative: NSArticle | null;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: NewsSentimentResponse = {
  symbol: "AAPL",
  sentiment_score: 28.4,
  label: "Bullish",
  positive_count: 5,
  negative_count: 2,
  neutral_count: 2,
  trend: [
    { date: "2026-06-20", score: 12.0 },
    { date: "2026-06-22", score: 35.0 },
    { date: "2026-06-24", score: -18.0 },
    { date: "2026-06-26", score: 44.0 },
    { date: "2026-06-28", score: 30.0 },
  ],
  articles: [
    { title: "AAPL beats quarterly estimates as revenue surges to record high", publisher: "MarketWatch", date: "2026-06-28T14:10:00+00:00", url: "#", score: 1.0, tone: "positive" },
    { title: "Analysts upgrade AAPL on strong demand and robust margin growth", publisher: "Barron's", date: "2026-06-27T18:30:00+00:00", url: "#", score: 0.6, tone: "positive" },
    { title: "AAPL announces $10B buyback program, dividend boost", publisher: "Bloomberg", date: "2026-06-26T11:05:00+00:00", url: "#", score: 1.0, tone: "positive" },
    { title: "Wall Street mixed on AAPL as macro picture stays uncertain", publisher: "Reuters", date: "2026-06-25T09:40:00+00:00", url: "#", score: 0.0, tone: "neutral" },
    { title: "AAPL faces regulatory probe, stock slides on the news", publisher: "Financial Times", date: "2026-06-24T16:20:00+00:00", url: "#", score: -1.0, tone: "negative" },
    { title: "AAPL holds steady ahead of earnings as investors weigh outlook", publisher: "Yahoo Finance", date: "2026-06-23T13:00:00+00:00", url: "#", score: 0.0, tone: "neutral" },
    { title: "AAPL warns of slowdown, announces layoffs amid cost cuts", publisher: "CNBC", date: "2026-06-22T10:15:00+00:00", url: "#", score: -1.0, tone: "negative" },
  ],
  most_positive: { title: "AAPL beats quarterly estimates as revenue surges to record high", publisher: "MarketWatch", date: "2026-06-28T14:10:00+00:00", url: "#", score: 1.0, tone: "positive" },
  most_negative: { title: "AAPL faces regulatory probe, stock slides on the news", publisher: "Financial Times", date: "2026-06-24T16:20:00+00:00", url: "#", score: -1.0, tone: "negative" },
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function toneColor(tone: string): string {
  if (tone === "positive") return "text-accent-green";
  if (tone === "negative") return "text-accent-red";
  return "text-terminal-muted";
}
function toneDot(tone: string): string {
  if (tone === "positive") return "bg-accent-green";
  if (tone === "negative") return "bg-accent-red";
  return "bg-terminal-dim";
}
function labelColor(label: string): string {
  if (label === "Bullish") return "text-accent-green";
  if (label === "Bearish") return "text-accent-red";
  return "text-accent-amber";
}
function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}
function fmtScore(n: number): string {
  const v = Math.round(n * 100) / 100;
  return (v >= 0 ? "+" : "") + v.toFixed(2);
}
function fmtBig(n: number): string {
  const r = Math.round(n * 10) / 10;
  return (r > 0 ? "+" : "") + r.toFixed(1);
}

// ── Inline SVG trend sparkline (zero line, green above / red below) ───────────
function TrendSparkline({ trend }: { trend: NSTrendPoint[] }) {
  const W = 320;
  const H = 64;
  const pad = 4;
  if (!trend.length) {
    return <div className="text-terminal-dim text-xs">No trend data</div>;
  }
  const scores = trend.map((t) => t.score);
  const max = Math.max(20, ...scores.map((s) => Math.abs(s)));
  const n = trend.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (s: number) => H / 2 - (s / max) * (H / 2 - pad);
  const zeroY = H / 2;

  const path = trend.map((t, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(t.score).toFixed(1)}`).join(" ");
  // Area split by sign for a subtle fill.
  const areaUp = `M ${x(0).toFixed(1)} ${zeroY} ` + trend.map((t, i) => `L ${x(i).toFixed(1)} ${y(Math.max(0, t.score)).toFixed(1)}`).join(" ") + ` L ${x(n - 1).toFixed(1)} ${zeroY} Z`;
  const areaDown = `M ${x(0).toFixed(1)} ${zeroY} ` + trend.map((t, i) => `L ${x(i).toFixed(1)} ${y(Math.min(0, t.score)).toFixed(1)}`).join(" ") + ` L ${x(n - 1).toFixed(1)} ${zeroY} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none">
      <path d={areaUp} fill="#00ff88" opacity={0.1} />
      <path d={areaDown} fill="#f87171" opacity={0.1} />
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="currentColor" className="text-terminal-divider" strokeWidth={1} strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="#9ca3af" strokeWidth={1.5} />
      {trend.map((t, i) => (
        <circle key={i} cx={x(i)} cy={y(t.score)} r={2} fill={t.score >= 0 ? "#00ff88" : "#f87171"} />
      ))}
    </svg>
  );
}

export function NewsSentimentPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<NewsSentimentResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/news-sentiment/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: NewsSentimentResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.articles) && json.articles.length) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = input.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  const total = data.positive_count + data.negative_count + data.neutral_count;
  const posPct = total ? Math.round((data.positive_count / total) * 100) : 0;
  const negPct = total ? Math.round((data.negative_count / total) * 100) : 0;

  const oneLiner = useMemo(() => {
    const s = data.sentiment_score;
    const dir = s > 15 ? "leaning bullish" : s < -15 ? "leaning bearish" : "broadly neutral";
    return `Across ${total} recent ${data.symbol} headlines, news tone is ${dir} (${fmtBig(s)} on a -100 to +100 scale): ${data.positive_count} positive, ${data.negative_count} negative, ${data.neutral_count} neutral.`;
  }, [data, total]);

  // Gauge fill 0..100 across the -100..+100 range.
  const gaugePct = Math.max(0, Math.min(100, (data.sentiment_score + 100) / 2));

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>NEWS SENTIMENT</span>
        <span className="flex items-center gap-2 text-[10px] font-mono">
          <span className={`pill ${data.data_mode === "live" ? "text-accent-green" : "text-accent-amber"}`}>
            {data.data_mode === "live" ? "LIVE" : "SAMPLE"}
          </span>
          <span className="text-terminal-dim">{data.source}</span>
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ticker"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase w-28 text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={submit}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Score
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between col-span-1">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Sentiment</div>
            <div className={`stat-figure ${labelColor(data.label)} leading-none`}>{fmtBig(data.sentiment_score)}</div>
            <div className={`text-xs font-mono uppercase ${labelColor(data.label)}`}>{data.label}</div>
            {/* gauge bar -100..+100 */}
            <div className="mt-2 h-1.5 w-full bg-terminal-panel rounded-full relative overflow-hidden">
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-terminal-divider" />
              <div
                className={`absolute top-0 bottom-0 rounded-full ${data.sentiment_score >= 0 ? "bg-accent-green" : "bg-accent-red"}`}
                style={
                  data.sentiment_score >= 0
                    ? { left: "50%", width: `${gaugePct - 50}%` }
                    : { right: "50%", width: `${50 - gaugePct}%` }
                }
              />
            </div>
          </div>

          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Positive</div>
            <div className="stat-figure text-accent-green leading-none">{data.positive_count}</div>
            <div className="text-xs font-mono text-terminal-muted">{posPct}% of feed</div>
          </div>

          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Negative</div>
            <div className="stat-figure text-accent-red leading-none">{data.negative_count}</div>
            <div className="text-xs font-mono text-terminal-muted">{negPct}% of feed</div>
          </div>

          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Neutral</div>
            <div className="stat-figure text-terminal-muted leading-none">{data.neutral_count}</div>
            <div className="text-xs font-mono text-terminal-muted">{total} total</div>
          </div>
        </div>

        {/* Trend sparkline */}
        <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Daily Sentiment Trend</span>
            <span className="text-[10px] font-mono text-terminal-dim">
              <span className="text-accent-green">above 0 = bullish</span> / <span className="text-accent-red">below = bearish</span>
            </span>
          </div>
          <div className="text-terminal-muted">
            <TrendSparkline trend={data.trend} />
          </div>
        </div>

        {/* Plain-language one-liner */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3">
          {oneLiner}
        </div>

        {/* Most positive / most negative */}
        <div className="grid grid-cols-2 gap-2">
          {data.most_positive && (
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5">
              <div className="text-[10px] font-mono uppercase text-accent-green tracking-wider mb-1">Most Positive</div>
              <div className="text-xs text-terminal-text font-sans leading-snug line-clamp-2">{data.most_positive.title}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-1 flex justify-between">
                <span>{data.most_positive.publisher}</span>
                <span className="text-accent-green tabular-nums">{fmtScore(data.most_positive.score)}</span>
              </div>
            </div>
          )}
          {data.most_negative && (
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5">
              <div className="text-[10px] font-mono uppercase text-accent-red tracking-wider mb-1">Most Negative</div>
              <div className="text-xs text-terminal-text font-sans leading-snug line-clamp-2">{data.most_negative.title}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-1 flex justify-between">
                <span>{data.most_negative.publisher}</span>
                <span className="text-accent-red tabular-nums">{fmtScore(data.most_negative.score)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Headlines feed */}
        <div className="flex-1">
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Headlines ({data.articles.length})</span>
            <span>Score</span>
          </div>
          <div className="divide-y divide-terminal-divider border-t border-terminal-divider">
            {data.articles.map((a, i) => (
              <a
                key={i}
                href={a.url && a.url !== "#" ? a.url : undefined}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 py-1.5 group hover:bg-terminal-bg transition-colors"
              >
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${toneDot(a.tone)}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-terminal-text font-sans leading-snug truncate group-hover:text-accent">
                    {a.title}
                  </span>
                  <span className="text-[10px] font-mono text-terminal-dim">
                    {a.publisher || "Unknown"} - {fmtDate(a.date)}
                  </span>
                </span>
                <span className={`shrink-0 w-14 text-right font-mono tabular-nums text-xs ${toneColor(a.tone)}`}>
                  {fmtScore(a.score)}
                </span>
              </a>
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center gap-4 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-green" /> Bullish</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-terminal-dim" /> Neutral</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-red" /> Bearish</span>
          <span className="ml-auto">NLP lexicon scoring - scores -1 to +1 per headline</span>
        </div>
      </div>
    </div>
  );
}
