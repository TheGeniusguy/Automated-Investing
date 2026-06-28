import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface FGComponent {
  name: string;
  value: number;
  label: string;
  note: string;
}

interface FGHistoryPoint {
  date: string;
  score: number;
}

interface FGComparison {
  previous_close: number | null;
  week_ago: number | null;
  month_ago: number | null;
  year_ago: number | null;
}

interface FearGreedResponse {
  score: number;
  label: string;
  summary: string;
  components: FGComponent[];
  history: FGHistoryPoint[];
  comparison: FGComparison;
  data_mode: string;
  as_of: string;
  source: string;
}

// Classification bands (mirror the backend) for labels + colors.

function classify(score: number): string {
  if (score >= 75) return "Extreme Greed";
  if (score >= 56) return "Greed";
  if (score >= 45) return "Neutral";
  if (score >= 25) return "Fear";
  return "Extreme Fear";
}

// Warm-palette gauge color ramp: red fear -> amber neutral -> green greed.
function scoreColor(score: number): string {
  if (score >= 75) return "#5a9a6f"; // deep green
  if (score >= 56) return "#7faf7a"; // green
  if (score >= 45) return "#c9a24a"; // amber
  if (score >= 25) return "#cc8a55"; // clay-orange
  return "#c2603f"; // red
}

function scoreTextClass(score: number): string {
  if (score >= 56) return "text-accent-green";
  if (score >= 45) return "text-accent-amber";
  return "text-accent-red";
}

// Local fallback so the panel renders fully populated, even offline.
// Mirrors the backend story: a year that ran hot into greed, then cooled to
// a balanced reading. Seven sub-indicators, ~1y composite history.

const FALLBACK: FearGreedResponse = (() => {
  const history: FGHistoryPoint[] = [];
  const n = 252;
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - Math.round(i * 1.4));
    const frac = (n - 1 - i) / (n - 1);
    const wave = Math.sin(frac * 7.5 + 0.4) * 16 + Math.sin(frac * 23) * 6;
    const drift = 78 - 26 * frac;
    const score = Math.max(6, Math.min(94, drift + wave));
    history.push({ date: d.toISOString().slice(0, 10), score: Math.round(score * 10) / 10 });
  }
  const cur = 52;
  history[history.length - 1] = { date: history[history.length - 1].date, score: cur };
  return {
    score: cur,
    label: classify(cur),
    summary: "Sentiment is balanced; the market is neither fearful nor greedy.",
    components: [
      { name: "Market Momentum", value: 64, label: "Greed", note: "S&P 500 is +3.1% vs its 125-day average" },
      { name: "Stock Price Strength", value: 58, label: "Greed", note: "20-day return ranks in the 58th percentile of the past year" },
      { name: "Market Volatility", value: 61, label: "Greed", note: "VIX 15.8, -8% vs its 50-day average" },
      { name: "Safe-Haven Demand", value: 55, label: "Neutral", note: "Stocks vs 20Y bonds spread +1.2% over 20 days" },
      { name: "Junk Bond Demand", value: 47, label: "Neutral", note: "High-yield vs investment-grade spread +0.1% over 20 days" },
      { name: "Put/Call Options", value: 49, label: "Neutral", note: "Implied put/call proxy 0.71" },
      { name: "Market Breadth", value: 30, label: "Fear", note: "Equal-weight vs cap-weight spread -1.4% over 20 days" },
    ],
    history,
    comparison: { previous_close: 60, week_ago: 64, month_ago: 71, year_ago: 78 },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtScore(v: number | null | undefined): string {
  if (v == null) return "--";
  return String(Math.round(v));
}

function deltaColor(now: number, prev: number | null | undefined): string {
  if (prev == null) return "text-terminal-muted";
  if (now > prev) return "text-accent-green";
  if (now < prev) return "text-accent-red";
  return "text-terminal-muted";
}

// Semicircular gauge geometry

const GW = 320;
const GH = 178;
const CX = GW / 2;
const CY = 158;
const R = 132;
const ARC_W = 22;

function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  // 180deg = left (score 0), 0deg = right (score 100). Sweep over the top.
  return { x: CX + radius * Math.cos(a), y: CY - radius * Math.sin(a) };
}

function arcPath(startScore: number, endScore: number, radius: number): string {
  const a0 = 180 - (startScore / 100) * 180;
  const a1 = 180 - (endScore / 100) * 180;
  const p0 = polar(a0, radius);
  const p1 = polar(a1, radius);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  // sweep flag 1 = clockwise over the top
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

// Five colored band segments across the semicircle.
const GAUGE_BANDS: { from: number; to: number; color: string }[] = [
  { from: 0, to: 25, color: "#c2603f" },
  { from: 25, to: 45, color: "#cc8a55" },
  { from: 45, to: 56, color: "#c9a24a" },
  { from: 56, to: 75, color: "#7faf7a" },
  { from: 75, to: 100, color: "#5a9a6f" },
];

// History sparkline geometry

const SVW = 520;
const SVH = 84;
const SPAD = 6;

function sparkPath(history: FGHistoryPoint[]): { line: string; area: string } {
  const n = history.length;
  if (n < 2) return { line: "", area: "" };
  const innerW = SVW - SPAD * 2;
  const innerH = SVH - SPAD * 2;
  const x = (i: number) => SPAD + (i / (n - 1)) * innerW;
  const y = (v: number) => SPAD + (1 - v / 100) * innerH;
  const line = history.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(SVH - SPAD).toFixed(1)} L${x(0).toFixed(1)},${(SVH - SPAD).toFixed(1)} Z`;
  return { line, area };
}

// Panel

export function FearGreedPanel() {
  const [data, setData] = useState<FearGreedResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/fear-greed")
      .then((res) => res.json())
      .then((json: FearGreedResponse) => {
        if (!alive) return;
        if (json && typeof json.score === "number" && Array.isArray(json.components)) {
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

  const { score, components, history, comparison, summary } = data;
  const label = data.label || classify(score);
  const color = scoreColor(score);
  const needleAngle = 180 - (Math.max(0, Math.min(100, score)) / 100) * 180;
  const needleTip = polar(needleAngle, R - 6);
  const needleBaseL = polar(needleAngle + 90, 7);
  const needleBaseR = polar(needleAngle - 90, 7);

  const spark = useMemo(() => sparkPath(history), [history]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>FEAR &amp; GREED INDEX</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Hero: gauge + comparison */}
        <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-4 items-center">
          {/* Gauge */}
          <div className="flex flex-col items-center">
            <svg viewBox={`0 0 ${GW} ${GH}`} className="w-full max-w-[320px]" style={{ height: "auto" }}>
              {/* band track */}
              {GAUGE_BANDS.map((b, i) => (
                <path
                  key={i}
                  d={arcPath(b.from, b.to, R)}
                  fill="none"
                  stroke={b.color}
                  strokeWidth={ARC_W}
                  strokeLinecap="butt"
                  opacity={0.92}
                />
              ))}
              {/* tick labels */}
              <text x={polar(180, R + 16).x} y={polar(180, R + 16).y} className="fill-terminal-dim" fontSize="10" textAnchor="start">0</text>
              <text x={CX} y={CY - R - ARC_W / 2 - 6} className="fill-terminal-dim" fontSize="10" textAnchor="middle">50</text>
              <text x={polar(0, R + 16).x} y={polar(0, R + 16).y} className="fill-terminal-dim" fontSize="10" textAnchor="end">100</text>

              {/* needle */}
              <polygon
                points={`${needleTip.x.toFixed(1)},${needleTip.y.toFixed(1)} ${needleBaseL.x.toFixed(1)},${needleBaseL.y.toFixed(1)} ${needleBaseR.x.toFixed(1)},${needleBaseR.y.toFixed(1)}`}
                fill={color}
              />
              <circle cx={CX} cy={CY} r={9} fill={color} />
              <circle cx={CX} cy={CY} r={4} className="fill-terminal-bg" />
            </svg>

            <div className="-mt-2 flex flex-col items-center">
              <div className="stat-figure text-5xl tabular-nums leading-none" style={{ color }}>{score}</div>
              <div className="pill mt-1.5 uppercase tracking-wider" style={{ color, borderColor: color }}>{label}</div>
            </div>
          </div>

          {/* Comparison */}
          <div className="grid grid-cols-2 gap-2 self-stretch content-center">
            <CompareCell label="Previous Close" value={comparison.previous_close} now={score} />
            <CompareCell label="1 Week Ago" value={comparison.week_ago} now={score} />
            <CompareCell label="1 Month Ago" value={comparison.month_ago} now={score} />
            <CompareCell label="1 Year Ago" value={comparison.year_ago} now={score} />
          </div>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{summary}</p>
        </div>

        {/* Components breakdown */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>What is driving sentiment</SectionLabel>
            <span className="text-2xs text-terminal-dim uppercase tracking-wider">7 indicators</span>
          </div>
          <div className="flex flex-col gap-2">
            {components.map((c) => (
              <ComponentRow key={c.name} c={c} />
            ))}
          </div>
        </div>

        {/* History sparkline */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <SectionLabel>1-Year Trend</SectionLabel>
            <div className="flex items-center gap-3 text-2xs">
              <LegendDot cls="bg-accent-red" label="Fear" />
              <LegendDot cls="bg-accent-amber" label="Neutral" />
              <LegendDot cls="bg-accent-green" label="Greed" />
            </div>
          </div>
          <svg viewBox={`0 0 ${SVW} ${SVH}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
            <defs>
              <linearGradient id="fg-spark-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.20" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* neutral band 45-55 reference */}
            <rect
              x={SPAD}
              y={SPAD + (1 - 0.56) * (SVH - SPAD * 2)}
              width={SVW - SPAD * 2}
              height={(0.56 - 0.45) * (SVH - SPAD * 2)}
              className="fill-terminal-divider/30"
            />
            <line x1={SPAD} x2={SVW - SPAD} y1={SPAD + 0.5 * (SVH - SPAD * 2)} y2={SPAD + 0.5 * (SVH - SPAD * 2)}
              className="stroke-terminal-divider" strokeWidth={0.75} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
            <path d={spark.area} fill="url(#fg-spark-fill)" />
            <path d={spark.line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <div className="flex justify-between text-2xs text-terminal-dim mt-1">
            <span>1 year ago: {fmtScore(comparison.year_ago)}</span>
            <span className="font-mono tabular-nums">Now: {fmtScore(score)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function CompareCell({ label, value, now }: { label: string; value: number | null; now: number }) {
  const sub = value == null ? "" : classify(value);
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`stat-figure text-2xl tabular-nums ${deltaColor(now, value)}`}>{fmtScore(value)}</span>
        {value != null && <span className="text-2xs text-terminal-dim truncate">{sub}</span>}
      </div>
    </div>
  );
}

function ComponentRow({ c }: { c: FGComponent }) {
  const color = scoreColor(c.value);
  const pct = Math.max(0, Math.min(100, c.value));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-terminal-text truncate">{c.name}</span>
        <span className="flex items-baseline gap-1.5 shrink-0">
          <span className={`text-2xs uppercase tracking-wider ${scoreTextClass(c.value)}`}>{c.label}</span>
          <span className="font-mono tabular-nums text-xs text-terminal-text w-7 text-right">{Math.round(c.value)}</span>
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-terminal-divider/50 overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
        <div className="absolute inset-y-0 w-px bg-terminal-muted/60" style={{ left: "50%" }} />
      </div>
      <div className="text-2xs text-terminal-dim truncate" title={c.note}>{c.note}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs text-terminal-muted uppercase tracking-wider">{children}</div>;
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className={`w-2 h-2 rounded-sm inline-block ${cls}`} />
      {label}
    </span>
  );
}
