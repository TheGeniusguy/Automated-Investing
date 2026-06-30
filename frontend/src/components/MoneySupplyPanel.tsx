import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface MoneyMetric {
  key: string;
  label: string;
  latest: number;
  unit: string;
  yoy_pct: number | null;
  trend: string; // "up" | "down" | "flat"
  polarity: string; // "normal" | "inverse" | "neutral"
  note: string;
}

interface HistPoint {
  date: string;
  value: number;
}

interface MoneySupplyResponse {
  metrics: MoneyMetric[];
  m2_growth_history: HistPoint[];
  velocity_history: HistPoint[];
  read: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Palette — warm "ink" tokens consistent with the rest of the terminal.
const GREEN = "#5f9460"; // expanding / supportive
const RED = "#c2603f"; // contracting / restrictive
const NEUTRAL = "#a59c8e"; // informational
const SPARK_DIM = "#5c554b";

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend mid-2026 sample: money growing modestly, banks tightening a touch.

const FALLBACK: MoneySupplyResponse = (() => {
  const m2g: HistPoint[] = [];
  const vel: HistPoint[] = [];
  for (let i = 0; i < 24; i++) {
    const frac = i / 23;
    m2g.push({
      date: `2024-${String(1 + (i % 12)).padStart(2, "0")}-01`,
      value: Math.round((2.6 + 1.2 * frac + 0.2 * Math.sin(i / 2)) * 100) / 100,
    });
  }
  for (let i = 0; i < 16; i++) {
    const frac = i / 15;
    vel.push({
      date: `2022-${String(1 + ((i * 3) % 12)).padStart(2, "0")}-01`,
      value: Math.round((1.27 + 0.09 * frac + 0.006 * Math.sin(i)) * 1000) / 1000,
    });
  }
  return {
    metrics: [
      { key: "m2", label: "M2 Money Supply", latest: 22.1, unit: "$T", yoy_pct: 3.6, trend: "up", polarity: "normal", note: "Broad money expanding modestly" },
      { key: "velocity", label: "M2 Velocity", latest: 1.355, unit: "x", yoy_pct: 1.8, trend: "up", polarity: "neutral", note: "Each dollar turning over a touch faster" },
      { key: "credit", label: "Bank Credit", latest: 18.4, unit: "$T", yoy_pct: 3.1, trend: "up", polarity: "normal", note: "H.8 commercial-bank credit rising" },
      { key: "loans", label: "Loans & Leases", latest: 12.9, unit: "$T", yoy_pct: 2.4, trend: "up", polarity: "normal", note: "Loan books growing slowly" },
      { key: "deposits", label: "Bank Deposits", latest: 17.9, unit: "$T", yoy_pct: 2.0, trend: "up", polarity: "normal", note: "Deposit base stable, growing gently" },
      { key: "sloos", label: "SLOOS C&I Tightening", latest: 7.5, unit: "% net", yoy_pct: null, trend: "up", polarity: "inverse", note: "Net share of banks tightening — modestly restrictive" },
    ],
    m2_growth_history: m2g,
    velocity_history: vel,
    read: "Credit creation is expanding modestly while banks are tightening lending standards only modestly, so liquidity is roughly neutral.",
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Color a YoY/level reading by its TRUE economic meaning (polarity-aware).
// normal:  positive growth = expanding = green
// inverse: positive reading (more tightening) = restrictive = red
// neutral: informational, never alarmist
function readingColor(value: number, polarity: string): string {
  if (polarity === "neutral") return NEUTRAL;
  const good = polarity === "inverse" ? value < 0 : value > 0;
  if (Math.abs(value) < 0.05) return NEUTRAL;
  return good ? GREEN : RED;
}

function trendGlyph(trend: string): string {
  if (trend === "up") return "▲"; // ▲
  if (trend === "down") return "▼"; // ▼
  return "—"; // —
}

// For trend coloring we also respect polarity: a rising SLOOS (inverse) is red.
function trendColor(trend: string, polarity: string): string {
  if (trend === "flat" || polarity === "neutral") return NEUTRAL;
  const rising = trend === "up";
  const good = polarity === "inverse" ? !rising : rising;
  return good ? GREEN : RED;
}

function fmtLatest(m: MoneyMetric): string {
  if (m.unit === "$T") return `$${m.latest.toFixed(2)}T`;
  if (m.unit === "x") return `${m.latest.toFixed(3)}x`;
  if (m.unit === "% net") return `${m.latest >= 0 ? "+" : ""}${m.latest.toFixed(1)}%`;
  return `${m.latest}`;
}

function fmtYoY(v: number | null): string {
  if (v === null || v === undefined) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// Inline SVG sparkline. Robust to short/empty arrays.
function Sparkline({
  points,
  color,
  zeroLine = false,
  width = 220,
  height = 40,
}: {
  points: HistPoint[];
  color: string;
  zeroLine?: boolean;
  width?: number;
  height?: number;
}) {
  const path = useMemo(() => {
    const vals = points.map((p) => p.value).filter((v) => Number.isFinite(v));
    if (vals.length < 2) return null;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (zeroLine) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const span = hi - lo || 1;
    const pad = 3;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const x = (i: number) => pad + (i / (vals.length - 1)) * w;
    const y = (v: number) => pad + h - ((v - lo) / span) * h;
    const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const zeroY = zeroLine ? pad + h - ((0 - lo) / span) * h : null;
    return { d, zeroY };
  }, [points, zeroLine, width, height]);

  if (!path) {
    return <div className="text-2xs text-terminal-dim">no history</div>;
  }
  return (
    <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {path.zeroY !== null && (
        <line x1={0} x2={width} y1={path.zeroY} y2={path.zeroY} stroke={SPARK_DIM} strokeWidth={1} strokeDasharray="2 2" />
      )}
      <path d={path.d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Panel

export function MoneySupplyPanel() {
  const [data, setData] = useState<MoneySupplyResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/money-supply")
      .then((res) => res.json())
      .then((json: MoneySupplyResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.metrics) && json.metrics.length > 0) {
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

  const metrics = data.metrics?.length ? data.metrics : FALLBACK.metrics;
  const m2Hist = data.m2_growth_history ?? [];
  const velHist = data.velocity_history ?? [];

  const m2g = metrics.find((m) => m.key === "m2");
  const velMetric = metrics.find((m) => m.key === "velocity");
  const velLatest = velHist.length ? velHist[velHist.length - 1].value : null;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>MONEY SUPPLY &amp; BANK CREDIT</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Plain-language liquidity read */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{data.read}</p>
        </div>

        {/* Metric cards grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {metrics.map((m) => (
            <MetricCard key={m.key} m={m} />
          ))}
        </div>

        {/* Sparklines */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SparkCard
            title="M2 Growth (YoY %)"
            latest={m2g?.yoy_pct != null ? `${m2g.yoy_pct >= 0 ? "+" : ""}${m2g.yoy_pct.toFixed(1)}%` : "--"}
            latestColor={m2g?.yoy_pct != null ? readingColor(m2g.yoy_pct, "normal") : NEUTRAL}
          >
            <Sparkline
              points={m2Hist}
              color={m2g?.yoy_pct != null ? readingColor(m2g.yoy_pct, "normal") : GREEN}
              zeroLine
            />
          </SparkCard>
          <SparkCard
            title="M2 Velocity"
            latest={velLatest != null ? `${velLatest.toFixed(3)}x` : velMetric ? `${velMetric.latest.toFixed(3)}x` : "--"}
            latestColor={NEUTRAL}
          >
            <Sparkline points={velHist} color="#84934f" />
          </SparkCard>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim mt-auto pt-1">
          <div className="flex items-center gap-3">
            <LegendSwatch color={GREEN} label="Expanding / loosening" />
            <LegendSwatch color={RED} label="Contracting / tightening" />
          </div>
          <span className="uppercase tracking-wider">M2 &middot; H.8 &middot; SLOOS</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function MetricCard({ m }: { m: MoneyMetric }) {
  // SLOOS shows its level (which IS the signal); others show YoY.
  const signalValue = m.key === "sloos" ? m.latest : m.yoy_pct;
  const showYoY = m.yoy_pct !== null && m.yoy_pct !== undefined;
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate" title={m.label}>
        {m.label}
      </div>
      <div className="flex items-baseline justify-between gap-1 min-w-0">
        <span className="stat-figure text-xl tabular-nums text-terminal-text leading-none truncate">
          {fmtLatest(m)}
        </span>
        <span
          className="font-mono text-xs shrink-0"
          style={{ color: trendColor(m.trend, m.polarity) }}
          title={`trend: ${m.trend}`}
        >
          {trendGlyph(m.trend)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1 min-w-0">
        {showYoY ? (
          <span
            className="font-mono tabular-nums text-2xs"
            style={{ color: signalValue != null ? readingColor(signalValue, m.polarity) : NEUTRAL }}
          >
            {fmtYoY(m.yoy_pct)} YoY
          </span>
        ) : (
          <span
            className="font-mono tabular-nums text-2xs"
            style={{ color: readingColor(m.latest, m.polarity) }}
          >
            net tightening
          </span>
        )}
      </div>
      <div className="text-2xs text-terminal-dim leading-tight truncate" title={m.note}>
        {m.note}
      </div>
    </div>
  );
}

function SparkCard({
  title,
  latest,
  latestColor,
  children,
}: {
  title: string;
  latest: string;
  latestColor: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider">{title}</span>
        <span className="font-mono tabular-nums text-xs" style={{ color: latestColor }}>
          {latest}
        </span>
      </div>
      <div className="min-h-0">{children}</div>
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
