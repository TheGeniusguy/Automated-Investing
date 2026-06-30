import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface CaptureRatiosResponse {
  portfolio_id: number | null;
  portfolio_name: string;
  benchmark: string;
  information_ratio: number | null;
  treynor: number | null;
  jensen_alpha_pct: number | null;
  tracking_error_pct: number | null;
  beta: number | null;
  up_capture: number | null;
  down_capture: number | null;
  capture_spread: number | null;
  ann_return_pct: number | null;
  ann_benchmark_pct: number | null;
  risk_free_rate_pct: number | null;
  up_days: number;
  down_days: number;
  data_points: number;
  read: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend deterministic sample so the math reads consistently with the live shape.
const FALLBACK: CaptureRatiosResponse = {
  portfolio_id: null,
  portfolio_name: "Sample Book",
  benchmark: "SPY",
  information_ratio: 1.417,
  treynor: 0.1405,
  jensen_alpha_pct: 9.3,
  tracking_error_pct: 5.92,
  beta: 1.014,
  up_capture: 104.8,
  down_capture: 95.7,
  capture_spread: 9.2,
  ann_return_pct: 19.25,
  ann_benchmark_pct: 9.88,
  risk_free_rate_pct: 5.0,
  up_days: 139,
  down_days: 113,
  data_points: 252,
  read:
    "Vs SPY, the book captures more upside than downside (convex profile); positive 9.3% annualized alpha; strong information ratio (1.42).",
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

// Formatting helpers

function fmtNum(v: number | null, digits = 2): string {
  return v === null || Number.isNaN(v) ? "--" : v.toFixed(digits);
}

function fmtPct(v: number | null, digits = 2): string {
  return v === null || Number.isNaN(v) ? "--" : `${v.toFixed(digits)}%`;
}

function signColor(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

// Panel

export function CaptureRatiosPanel() {
  const [data, setData] = useState<CaptureRatiosResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/capture-ratios")
      .then((res) => res.json())
      .then((json: CaptureRatiosResponse) => {
        if (!alive) return;
        if (json && typeof json === "object" && "up_capture" in json) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const upCap = data.up_capture;
  const downCap = data.down_capture;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CAPTURE RATIOS</span>
        <div className="flex items-center gap-2 normal-case tracking-normal">
          <span className="text-2xs text-terminal-dim truncate max-w-[160px]">
            {data.portfolio_name} vs {data.benchmark}
          </span>
          {loading && <span className="text-terminal-dim">Loading...</span>}
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {error && (
          <div className="bg-terminal-bg border border-accent-red/40 rounded p-2 text-2xs text-accent-red">
            Live feed unavailable, showing reference figures.
          </div>
        )}

        {/* Risk-adjusted metric cards */}
        <div className="grid grid-cols-3 gap-2">
          <MetricCard
            label="Information Ratio"
            value={fmtNum(data.information_ratio, 2)}
            valueClass={signColor(data.information_ratio)}
            sub="active return / tracking error"
          />
          <MetricCard
            label="Treynor"
            value={fmtNum(data.treynor, 3)}
            valueClass={signColor(data.treynor)}
            sub="excess return / beta"
          />
          <MetricCard
            label="Jensen's Alpha"
            value={fmtPct(data.jensen_alpha_pct, 1)}
            valueClass={signColor(data.jensen_alpha_pct)}
            sub="annualized CAPM residual"
          />
          <MetricCard
            label="Tracking Error"
            value={fmtPct(data.tracking_error_pct, 2)}
            valueClass="text-terminal-text"
            sub="annualized std of active"
          />
          <MetricCard
            label="Beta"
            value={fmtNum(data.beta, 2)}
            valueClass="text-terminal-text"
            sub={`vs ${data.benchmark}`}
          />
          <MetricCard
            label="Capture Spread"
            value={data.capture_spread === null ? "--" : data.capture_spread.toFixed(1)}
            valueClass={signColor(data.capture_spread)}
            sub="up minus down capture"
          />
        </div>

        {/* Up vs down capture comparison */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              Up-Market vs Down-Market Capture
            </span>
            <span className="text-2xs text-terminal-dim">
              {data.up_days} up / {data.down_days} down days
            </span>
          </div>

          <CaptureBar
            label="Up Capture"
            value={upCap}
            // Up capture > 100 = participating in MORE than the benchmark's upside (good).
            good={upCap !== null && upCap >= 100}
            days={data.up_days}
          />
          <CaptureBar
            label="Down Capture"
            value={downCap}
            // Down capture > 100 = losing MORE than the benchmark on its down days (bad).
            good={downCap !== null && downCap < 100}
            days={data.down_days}
          />

          <div className="flex items-center justify-between text-2xs pt-1 border-t border-terminal-divider/40">
            <span className="text-terminal-dim">
              Port {fmtPct(data.ann_return_pct, 1)} vs {data.benchmark}{" "}
              {fmtPct(data.ann_benchmark_pct, 1)} annualized
            </span>
            <span className="text-terminal-dim">rf {fmtPct(data.risk_free_rate_pct, 1)}</span>
          </div>
        </div>

        {/* Plain-language read */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{data.read}</p>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function MetricCard({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: string;
  valueClass: string;
  sub: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</div>
      <span className={`stat-figure text-2xl leading-none font-mono tabular-nums ${valueClass}`}>
        {value}
      </span>
      <span className="text-2xs text-terminal-dim truncate">{sub}</span>
    </div>
  );
}

function CaptureBar({
  label,
  value,
  good,
  days,
}: {
  label: string;
  value: number | null;
  good: boolean;
  days: number;
}): ReactNode {
  // Scale bar width against a 150% ceiling so 100 sits at two-thirds.
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / 150) * 100));
  const barColor = good ? "rgba(95,148,96,0.75)" : "rgba(194,96,63,0.75)";
  const valueClass = good ? "text-accent-green" : "text-accent-red";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-terminal-text">{label}</span>
        <span className={`font-mono tabular-nums text-sm font-semibold ${valueClass}`}>
          {value === null ? "--" : value.toFixed(1)}
        </span>
      </div>
      <div className="relative h-3 bg-terminal-border/30 rounded overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
        {/* 100% reference marker (benchmark parity) */}
        <div
          className="absolute inset-y-0 w-px bg-terminal-text/50"
          style={{ left: `${(100 / 150) * 100}%` }}
          title="100 = benchmark parity"
        />
      </div>
      <span className="text-2xs text-terminal-dim">{days} days in bucket</span>
    </div>
  );
}
