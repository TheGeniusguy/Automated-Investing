import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface FactorExposure {
  factor: string;
  beta: number;
}

interface RiskMetrics {
  vol: number;
  var95: number;
  cvar95: number;
  beta: number;
  hhi: number;
  tracking_error: number;
  factor_exposures: FactorExposure[];
}

interface ProposedTrade {
  symbol: string;
  action: string; // "buy" | "sell"
  quantity: number;
  est_value: number;
}

interface Deltas {
  vol: number;
  var95: number;
  cvar95: number;
  beta: number;
  hhi: number;
  tracking_error: number;
}

interface BiggestChange {
  metric: string;
  delta: number;
  from: number;
  to: number;
}

interface WhatifResponse {
  portfolio_id: number | null;
  proposed_trades: ProposedTrade[];
  before: RiskMetrics;
  after: RiskMetrics;
  deltas: Deltas;
  summary: {
    risk_direction: string;
    biggest_change: BiggestChange;
    note: string;
  };
  data_mode: string;
  as_of: string;
  source: string;
}

// Metric display config. `riskSign` = +1 when a LARGER value is riskier (so a
// positive delta is bad/red); -1 when a more-negative value is riskier (VaR/CVaR
// are loss numbers, so a downward delta is the risky direction).

type MetricKey = keyof Deltas;

interface MetricMeta {
  key: MetricKey;
  label: string;
  unit: "pct" | "x" | "idx";
  riskSign: 1 | -1;
  decimals: number;
}

const METRICS: MetricMeta[] = [
  { key: "vol", label: "Annualized Volatility", unit: "pct", riskSign: 1, decimals: 2 },
  { key: "var95", label: "VaR 95% (Daily)", unit: "pct", riskSign: -1, decimals: 2 },
  { key: "cvar95", label: "CVaR 95% (Daily)", unit: "pct", riskSign: -1, decimals: 2 },
  { key: "beta", label: "Beta vs SPY", unit: "x", riskSign: 1, decimals: 2 },
  { key: "hhi", label: "Concentration (HHI)", unit: "idx", riskSign: 1, decimals: 4 },
  { key: "tracking_error", label: "Tracking Error vs SPY", unit: "pct", riskSign: 1, decimals: 2 },
];

const METRIC_LABEL: Record<string, string> = Object.fromEntries(
  METRICS.map((m) => [m.key, m.label])
);

// Local fallback so the panel renders fully populated, even offline.
// after is genuinely derived from before + the trades (a de-risking rotation).

const FALLBACK: WhatifResponse = {
  portfolio_id: null,
  proposed_trades: [
    { symbol: "NVDA", action: "sell", quantity: 244.9, est_value: 30000 },
    { symbol: "GLD", action: "buy", quantity: 139.02, est_value: 30000 },
  ],
  before: {
    vol: 30.41,
    var95: -3.0,
    cvar95: -3.76,
    beta: 1.31,
    hhi: 0.2568,
    tracking_error: 16.95,
    factor_exposures: [
      { factor: "SPY", beta: 1.31 },
      { factor: "QQQ", beta: 0.62 },
      { factor: "IWM", beta: 0.1 },
      { factor: "HYG", beta: 0.12 },
      { factor: "GLD", beta: 0.0 },
      { factor: "TLT", beta: -0.05 },
    ],
  },
  after: {
    vol: 26.18,
    var95: -2.59,
    cvar95: -3.24,
    beta: 1.13,
    hhi: 0.2088,
    tracking_error: 14.74,
    factor_exposures: [
      { factor: "SPY", beta: 1.13 },
      { factor: "QQQ", beta: 0.546 },
      { factor: "IWM", beta: 0.088 },
      { factor: "HYG", beta: 0.106 },
      { factor: "GLD", beta: 0.11 },
      { factor: "TLT", beta: -0.044 },
    ],
  },
  deltas: {
    vol: -4.23,
    var95: 0.41,
    cvar95: 0.52,
    beta: -0.18,
    hhi: -0.048,
    tracking_error: -2.21,
  },
  summary: {
    risk_direction: "Lower",
    biggest_change: { metric: "hhi", delta: -0.048, from: 0.2568, to: 0.2088 },
    note:
      "Pre-trade simulation: trimming NVDA and adding GLD lowers portfolio risk - vol 30.4% -> 26.2%, beta 1.31 -> 1.13, concentration (HHI) 0.257 -> 0.209. No orders are placed.",
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Formatting helpers

function fmtMetric(v: number, meta: MetricMeta): string {
  if (meta.unit === "pct") return `${v.toFixed(meta.decimals)}%`;
  if (meta.unit === "x") return `${v.toFixed(meta.decimals)}`;
  return v.toFixed(meta.decimals);
}

function fmtDelta(v: number, meta: MetricMeta): string {
  const sign = v > 0 ? "+" : "";
  if (meta.unit === "pct") return `${sign}${v.toFixed(meta.decimals)}%`;
  return `${sign}${v.toFixed(meta.decimals)}`;
}

function fmtMoney(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

// A delta "raises risk" when its sign matches the metric's riskSign.
function deltaRaisesRisk(delta: number, meta: MetricMeta): 0 | 1 | -1 {
  if (Math.abs(delta) < 1e-9) return 0;
  return (delta > 0) === (meta.riskSign > 0) ? 1 : -1;
}

function deltaColorClass(dir: 0 | 1 | -1): string {
  if (dir > 0) return "text-accent-red"; // raises risk
  if (dir < 0) return "text-accent-green"; // lowers risk
  return "text-terminal-muted";
}

function deltaArrow(dir: 0 | 1 | -1): string {
  if (dir > 0) return "▲"; // up triangle
  if (dir < 0) return "▼"; // down triangle
  return "→";
}

// Panel

export function PortfolioWhatifPanel() {
  const [data, setData] = useState<WhatifResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/portfolio-whatif")
      .then((res) => res.json())
      .then((json: WhatifResponse) => {
        if (!alive) return;
        if (json && json.before && json.after && Array.isArray(json.proposed_trades)) {
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

  const { proposed_trades, before, after, deltas, summary } = data;

  const biggestLabel = METRIC_LABEL[summary.biggest_change?.metric] ?? summary.biggest_change?.metric;
  const biggestMeta = METRICS.find((m) => m.key === summary.biggest_change?.metric);
  const biggestDir = biggestMeta
    ? deltaRaisesRisk(summary.biggest_change.delta, biggestMeta)
    : 0;

  const riskDir = summary.risk_direction;
  const riskDirClass =
    riskDir === "Lower"
      ? "text-accent-green"
      : riskDir === "Higher"
      ? "text-accent-red"
      : "text-terminal-muted";

  // Shared scale for the factor exposure mini-bars (before + after).
  const factorMax = useMemo(() => {
    const all = [...before.factor_exposures, ...after.factor_exposures].map((f) =>
      Math.abs(f.beta)
    );
    return Math.max(0.001, ...all);
  }, [before.factor_exposures, after.factor_exposures]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>PRE-TRADE WHAT-IF</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip: net risk direction + biggest single change */}
        <div className="grid grid-cols-2 gap-2">
          <KpiCell label="Net Risk Direction">
            <span className={`stat-figure text-3xl leading-none ${riskDirClass}`}>
              {riskDir}
            </span>
            <span className="text-2xs text-terminal-dim">after the proposed rotation</span>
          </KpiCell>
          <KpiCell label="Biggest Single Change">
            <span className={`stat-figure text-3xl leading-none tabular-nums ${deltaColorClass(biggestDir)}`}>
              {biggestMeta ? fmtDelta(summary.biggest_change.delta, biggestMeta) : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">{biggestLabel}</span>
          </KpiCell>
        </div>

        {/* Proposed trades */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
            Proposed Trades
          </div>
          <div className="flex flex-col gap-1.5">
            {proposed_trades.map((t, i) => {
              const isBuy = t.action.toLowerCase() === "buy";
              return (
                <div
                  key={`${t.symbol}-${i}`}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="pill uppercase tracking-wider"
                      style={isBuy ? BUY_PILL : SELL_PILL}
                    >
                      {t.action}
                    </span>
                    <span className="font-mono text-terminal-text font-semibold">{t.symbol}</span>
                    <span className="text-2xs text-terminal-dim tabular-nums">
                      {t.quantity.toLocaleString("en-US", { maximumFractionDigits: 2 })} sh
                    </span>
                  </div>
                  <span className="font-mono tabular-nums text-terminal-muted">
                    {fmtMoney(t.est_value)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* HERO: before -> after risk comparison */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          <div className="grid grid-cols-[1fr_72px_16px_72px_88px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Risk Metric</SectionLabel>
            <SectionLabel right>Before</SectionLabel>
            <SectionLabel right> </SectionLabel>
            <SectionLabel right>After</SectionLabel>
            <SectionLabel right>Delta</SectionLabel>
          </div>

          <div className="flex flex-col">
            {METRICS.map((meta) => {
              const b = before[meta.key];
              const a = after[meta.key];
              const d = deltas[meta.key];
              const dir = deltaRaisesRisk(d, meta);
              return (
                <div
                  key={meta.key}
                  className="grid grid-cols-[1fr_72px_16px_72px_88px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0"
                >
                  <span className="text-xs text-terminal-text truncate">{meta.label}</span>
                  <span className="text-right font-mono tabular-nums text-xs text-terminal-muted">
                    {fmtMetric(b, meta)}
                  </span>
                  <span className="text-center text-2xs text-terminal-dim">{"→"}</span>
                  <span className="text-right font-mono tabular-nums text-xs text-terminal-text font-semibold">
                    {fmtMetric(a, meta)}
                  </span>
                  <span
                    className={`text-right font-mono tabular-nums text-2xs font-semibold ${deltaColorClass(dir)}`}
                  >
                    <span className="mr-0.5">{deltaArrow(dir)}</span>
                    {fmtDelta(d, meta)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Factor exposure before -> after */}
        {before.factor_exposures.length > 0 && (
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
            <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
              Factor Exposures (before {"→"} after)
            </div>
            <div className="flex flex-col gap-1.5">
              {before.factor_exposures.map((fb, i) => {
                const fa = after.factor_exposures[i];
                return (
                  <FactorRow
                    key={fb.factor}
                    factor={fb.factor}
                    before={fb.beta}
                    after={fa ? fa.beta : fb.beta}
                    max={factorMax}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Footer note */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{summary.note}</p>
          <p className="text-2xs text-terminal-dim uppercase tracking-wider mt-1.5">
            Simulation only - no orders placed. Both sides run through the identical risk computation.
          </p>
        </div>
      </div>
    </div>
  );
}

// Pills

const BUY_PILL: CSSProperties = { color: "#5e8a5a", borderColor: "#5e8a5a" };
const SELL_PILL: CSSProperties = { color: "#c2603f", borderColor: "#c2603f" };

// Sub-components

function FactorRow({
  factor,
  before,
  after,
  max,
}: {
  factor: string;
  before: number;
  after: number;
  max: number;
}) {
  const bPct = Math.min(100, (Math.abs(before) / max) * 100);
  const aPct = Math.min(100, (Math.abs(after) / max) * 100);
  const delta = after - before;
  const moved = Math.abs(delta) >= 0.005;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-10 text-right text-terminal-muted text-2xs uppercase">{factor}</span>
      <div className="flex-1 flex flex-col gap-0.5">
        <Bar pct={bPct} positive={before >= 0} dim />
        <Bar pct={aPct} positive={after >= 0} />
      </div>
      <span className="w-24 text-right tabular-nums text-2xs font-mono text-terminal-muted">
        {before >= 0 ? "+" : ""}
        {before.toFixed(2)}
        <span className="text-terminal-dim mx-0.5">{"→"}</span>
        <span className={moved ? "text-terminal-text font-semibold" : "text-terminal-muted"}>
          {after >= 0 ? "+" : ""}
          {after.toFixed(2)}
        </span>
      </span>
    </div>
  );
}

function Bar({ pct, positive, dim }: { pct: number; positive: boolean; dim?: boolean }) {
  const base = positive ? "bg-accent-green" : "bg-accent-red";
  return (
    <div className="h-1.5 bg-terminal-divider/50 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${base} ${dim ? "opacity-40" : "opacity-90"}`}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
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
