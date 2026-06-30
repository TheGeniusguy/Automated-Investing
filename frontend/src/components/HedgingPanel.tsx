import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface BetaHedge {
  instrument: string;
  hedge_ratio: number;
  units: number;
  notional: number;
  residual_beta: number;
  var_reduction_pct: number;
}

interface ProtectivePut {
  strike: number;
  premium: number;
  cost_pct: number;
  floor: number;
}

interface Collar {
  put_strike: number;
  call_strike: number;
  net_cost: number;
  capped_upside_pct: number;
}

interface HedgeSummary {
  recommended: string;
  unhedged_var: number;
  hedged_var: number;
  note: string;
}

interface HedgingResponse {
  portfolio_id: number | null;
  portfolio_value: number;
  beta: number;
  beta_hedge: BetaHedge;
  protective_put: ProtectivePut;
  collar: Collar;
  summary: HedgeSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline.
// A concentrated, high-beta mega-cap book - the kind a hedge is built for.

const FALLBACK: HedgingResponse = {
  portfolio_id: null,
  portfolio_value: 250000,
  beta: 1.31,
  beta_hedge: {
    instrument: "SPY",
    hedge_ratio: 1.31,
    units: 600.92,
    notional: 327500,
    residual_beta: 0.0,
    var_reduction_pct: 86.49,
  },
  protective_put: {
    strike: 530,
    premium: 8.52,
    cost_pct: 1.56,
    floor: 239213,
  },
  collar: {
    put_strike: 520,
    call_strike: 585.62,
    net_cost: 0,
    capped_upside_pct: 7.45,
  },
  summary: {
    recommended:
      "Short 601 SPY (~$327,500 notional) to flatten beta to ~0, then layer a zero-cost collar (520p / 586c) for tail protection at no premium.",
    unhedged_var: -5875,
    hedged_var: -2159.41,
    note: "Beta hedge cuts portfolio variance ~86% and daily 95% VaR from $5,875 to $2,159. The protective put (strike 530) floors the book at $239,213 for 1.56% of NAV; the collar trades capped upside above 7.5% for ~zero premium. Overlays priced with Black-Scholes. No orders are placed.",
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Formatting helpers

function fmtUSD(v: number, dp = 0): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

function fmtNum(v: number, dp = 0): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtPct(v: number, dp = 1): string {
  return `${v.toFixed(dp)}%`;
}

// Panel

export function HedgingPanel() {
  const [data, setData] = useState<HedgingResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/hedging")
      .then((res) => res.json())
      .then((json: HedgingResponse) => {
        if (!alive) return;
        if (json && json.beta_hedge && json.collar) {
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

  const { beta, beta_hedge, protective_put, collar, summary } = data;
  const netCostNearZero = Math.abs(collar.net_cost) < 1;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>HEDGING &amp; OVERLAY DESIGNER</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Residual Beta">
            <span className="stat-figure text-3xl tabular-nums text-accent-green leading-none">
              {beta_hedge.residual_beta.toFixed(2)}
            </span>
            <span className="text-2xs text-terminal-dim">
              from {beta.toFixed(2)} after hedge
            </span>
          </KpiCell>
          <KpiCell label="Variance Cut">
            <span className="stat-figure text-3xl tabular-nums text-accent-green leading-none">
              {Math.round(beta_hedge.var_reduction_pct)}%
            </span>
            <span className="text-2xs text-terminal-dim">via beta hedge</span>
          </KpiCell>
          <KpiCell label="Collar Net Cost">
            <span
              className={`stat-figure text-3xl tabular-nums leading-none ${
                netCostNearZero ? "text-accent-green" : "text-terminal-text"
              }`}
            >
              {netCostNearZero ? "$0" : fmtUSD(collar.net_cost)}
            </span>
            <span className="text-2xs text-terminal-dim">zero-cost by design</span>
          </KpiCell>
        </div>

        {/* Plain-language recommendation */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            {summary.recommended}
          </p>
        </div>

        {/* HERO: three overlay cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 flex-1 min-h-0">
          {/* Beta hedge card */}
          <OverlayCard title="Min-Variance Beta Hedge" accent="#c2603f">
            <Stat label="Instrument" value={beta_hedge.instrument} mono />
            <Stat label="Units to short" value={fmtNum(beta_hedge.units, 0)} mono danger />
            <Stat label="Hedge notional" value={fmtUSD(beta_hedge.notional)} mono />
            <Stat label="Hedge ratio (h*)" value={`${beta_hedge.hedge_ratio.toFixed(2)}x`} mono />
            <div className="mt-1.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-2xs text-terminal-dim uppercase tracking-wider">
                  Residual beta
                </span>
                <span className="font-mono text-2xs text-accent-green tabular-nums">
                  {beta_hedge.residual_beta.toFixed(2)} (neutral)
                </span>
              </div>
              <BetaGauge beta={beta} residual={beta_hedge.residual_beta} />
            </div>
          </OverlayCard>

          {/* Protective put card */}
          <OverlayCard title="Protective Put Overlay" accent="#c9a24a">
            <Stat label="Put strike" value={fmtNum(protective_put.strike, 0)} mono />
            <Stat label="Premium / share" value={fmtUSD(protective_put.premium, 2)} mono />
            <Stat label="Cost of book" value={fmtPct(protective_put.cost_pct, 2)} mono amber />
            <Stat label="Protected floor" value={fmtUSD(protective_put.floor)} mono />
            <p className="text-2xs text-terminal-dim leading-snug mt-1">
              Caps downside below the strike for a known, one-time premium.
            </p>
          </OverlayCard>

          {/* Zero-cost collar card */}
          <OverlayCard title="Zero-Cost Collar" accent="#6f8f6a">
            <Stat label="Put strike (buy)" value={fmtNum(collar.put_strike, 0)} mono />
            <Stat label="Call strike (sell)" value={fmtNum(collar.call_strike, 0)} mono />
            <Stat
              label="Net cost"
              value={netCostNearZero ? "~$0" : fmtUSD(collar.net_cost)}
              mono
              good={netCostNearZero}
            />
            <Stat
              label="Capped upside"
              value={`+${fmtPct(collar.capped_upside_pct, 1)}`}
              mono
            />
            <p className="text-2xs text-terminal-dim leading-snug mt-1">
              Sold call finances the protective put - tail cover at no premium.
            </p>
          </OverlayCard>
        </div>

        {/* VaR before/after strip */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 grid grid-cols-2 gap-2">
          <VarCell label="Unhedged daily VaR (95%)" value={summary.unhedged_var} muted />
          <VarCell label="Hedged daily VaR (95%)" value={summary.hedged_var} good />
        </div>

        {/* Footer note */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <span className="uppercase tracking-wider">
            Overlays priced with Black-Scholes
          </span>
          <span className="uppercase tracking-wider">
            h* = cov(p,h) / var(h) - residual beta ~ 0
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function BetaGauge({ beta, residual }: { beta: number; residual: number }) {
  // Track spans 0 .. max(beta, 1.5). Markers show the original beta (clay) and the
  // hedged residual (green, pinned near zero).
  const max = Math.max(1.5, Math.abs(beta) * 1.15);
  const betaPct = Math.max(2, Math.min(100, (beta / max) * 100));
  const resPct = Math.max(0, Math.min(100, (Math.abs(residual) / max) * 100));
  return (
    <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
      {/* original beta fill */}
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${betaPct}%`, backgroundColor: "#c2603f" }}
      />
      {/* residual marker (post-hedge) */}
      <div
        className="absolute inset-y-0 w-1 rounded-full"
        style={{ left: `${resPct}%`, backgroundColor: "#6f8f6a" }}
      />
    </div>
  );
}

function OverlayCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 pb-1.5 mb-1 border-b border-terminal-divider">
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: accent }} />
        <span className="text-2xs text-terminal-muted uppercase tracking-wider truncate">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  danger,
  amber,
  good,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
  amber?: boolean;
  good?: boolean;
}) {
  const valueClass = danger
    ? "text-accent-red"
    : amber
    ? "text-accent-amber"
    : good
    ? "text-accent-green"
    : "text-terminal-text";
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="text-2xs text-terminal-dim truncate">{label}</span>
      <span
        className={`text-xs tabular-nums shrink-0 ${mono ? "font-mono" : ""} ${valueClass}`}
      >
        {value}
      </span>
    </div>
  );
}

function VarCell({
  label,
  value,
  muted,
  good,
}: {
  label: string;
  value: number;
  muted?: boolean;
  good?: boolean;
}) {
  const color = good ? "text-accent-green" : muted ? "text-terminal-muted" : "text-terminal-text";
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</span>
      <span className={`stat-figure text-xl tabular-nums leading-none ${color}`}>
        {fmtUSD(value)}
      </span>
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
