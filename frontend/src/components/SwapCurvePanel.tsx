import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface CurveRow {
  tenor_label: string;
  tenor_years: number;
  swap_rate: number | null;
  treasury_yield: number | null;
  swap_spread_bps: number | null;
  discount_factor: number | null;
}

interface Pricer {
  tenor_years: number;
  notional: number;
  fixed_rate: number;
  par_rate: number;
  pv: number;
  annuity: number;
  dv01: number;
  direction: string;
}

interface WidestSpread {
  tenor_label: string | null;
  spread_bps: number | null;
}

interface SwapSummary {
  curve_shape: string;
  widest_spread: WidestSpread;
  par_5y: number | null;
}

interface SwapCurveResponse {
  curve: CurveRow[];
  pricer: Pricer;
  summary: SwapSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Curve-shape -> color. Inverted = red, flat = amber, normal/steep = green.
function shapeTextClass(shape: string): string {
  switch (shape) {
    case "inverted":
      return "text-accent-red";
    case "flat":
      return "text-accent-amber";
    case "steep":
    case "normal":
      return "text-accent-green";
    default:
      return "text-terminal-muted";
  }
}

// Spread sign -> color. Negative (swaps through Treasuries) reads clay/amber;
// positive reads green. The magnitude drives the bar length.
function spreadColor(bps: number): string {
  if (bps <= -20) return "#c2603f"; // deep negative
  if (bps < 0) return "#cc8a55"; // mild negative (clay)
  if (bps >= 20) return "#5b8a72"; // notably positive
  return "#c9a24a"; // ~flat
}

function spreadTextClass(bps: number | null): string {
  if (bps === null) return "text-terminal-dim";
  if (bps <= -10) return "text-accent-red";
  if (bps < 0) return "text-accent-amber";
  return "text-accent-green";
}

// Local fallback so the panel renders fully populated, even offline.
// Mirrors the backend SAMPLE SOFR swap curve + bootstrapped discount factors.
const FALLBACK: SwapCurveResponse = {
  curve: [
    { tenor_label: "1Y", tenor_years: 1, swap_rate: 4.25, treasury_yield: 4.3, swap_spread_bps: -5.0, discount_factor: 0.959233 },
    { tenor_label: "2Y", tenor_years: 2, swap_rate: 4.0, treasury_yield: 4.07, swap_spread_bps: -7.0, discount_factor: 0.924645 },
    { tenor_label: "3Y", tenor_years: 3, swap_rate: 3.92, treasury_yield: 4.0, swap_spread_bps: -8.0, discount_factor: 0.891216 },
    { tenor_label: "5Y", tenor_years: 5, swap_rate: 3.9, treasury_yield: 4.02, swap_spread_bps: -12.0, discount_factor: 0.826094 },
    { tenor_label: "7Y", tenor_years: 7, swap_rate: 3.98, treasury_yield: 4.12, swap_spread_bps: -14.0, discount_factor: 0.760687 },
    { tenor_label: "10Y", tenor_years: 10, swap_rate: 4.08, treasury_yield: 4.24, swap_spread_bps: -16.0, discount_factor: 0.669101 },
    { tenor_label: "20Y", tenor_years: 20, swap_rate: 4.28, treasury_yield: 4.52, swap_spread_bps: -24.0, discount_factor: 0.426407 },
    { tenor_label: "30Y", tenor_years: 30, swap_rate: 4.22, treasury_yield: 4.46, swap_spread_bps: -24.0, discount_factor: 0.288617 },
  ],
  pricer: {
    tenor_years: 5,
    notional: 10000000,
    fixed_rate: 3.9,
    par_rate: 3.9,
    pv: 0.0,
    annuity: 44591356.08,
    dv01: 4459.14,
    direction: "pay-fixed",
  },
  summary: {
    curve_shape: "flat",
    widest_spread: { tenor_label: "20Y", spread_bps: -24.0 },
    par_5y: 3.9,
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Formatting helpers

function fmtPct(v: number | null): string {
  return v === null ? "--" : `${v.toFixed(2)}%`;
}

function fmtBps(v: number | null): string {
  if (v === null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(0)} bps`;
}

function fmtDF(v: number | null): string {
  return v === null ? "--" : v.toFixed(4);
}

function fmtUsd0(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtNotional(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(0)}mm`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

// Panel

export function SwapCurvePanel() {
  const [data, setData] = useState<SwapCurveResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/swap-curve")
      .then((res) => res.json())
      .then((json: SwapCurveResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.curve) && json.curve.length > 0) {
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

  const { curve, pricer, summary } = data;

  // Scale spread bars to the widest absolute spread on the curve.
  const maxAbsSpread = useMemo(
    () => Math.max(1, ...curve.map((r) => Math.abs(r.swap_spread_bps ?? 0))),
    [curve]
  );

  const pvNearZero = Math.abs(pricer.pv) < 1;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>IRS SWAP CURVE &amp; PRICER</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="5Y Par Swap">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text leading-none">
              {fmtPct(summary.par_5y)}
            </span>
            <span className="text-2xs text-terminal-dim">SOFR fixed rate</span>
          </KpiCell>
          <KpiCell label="Widest Spread">
            <span
              className={`stat-figure text-3xl tabular-nums leading-none ${spreadTextClass(
                summary.widest_spread.spread_bps
              )}`}
            >
              {fmtBps(summary.widest_spread.spread_bps)}
            </span>
            <span className="text-2xs text-terminal-dim">
              at {summary.widest_spread.tenor_label ?? "--"} vs UST
            </span>
          </KpiCell>
          <KpiCell label="Curve Shape">
            <span
              className={`stat-figure text-2xl capitalize leading-none ${shapeTextClass(
                summary.curve_shape
              )}`}
            >
              {summary.curve_shape}
            </span>
            <span className="text-2xs text-terminal-dim">2s10s swap</span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Discount factors are bootstrapped so every par swap reprices to par. The swap
            spread - the SOFR fixed rate over the matched Treasury - is the price of bank
            credit and balance-sheet over govvies; deeply negative long-end spreads signal
            heavy receiving and constrained dealer balance sheets.
          </p>
        </div>

        {/* HERO: swap-vs-treasury curve table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          {/* Column header */}
          <div className="grid grid-cols-[56px_64px_64px_1fr_92px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Tenor</SectionLabel>
            <SectionLabel right>Swap</SectionLabel>
            <SectionLabel right>UST</SectionLabel>
            <SectionLabel>Swap spread (bps)</SectionLabel>
            <SectionLabel right>Disc. factor</SectionLabel>
          </div>

          <div className="flex flex-col">
            {curve.map((row) => (
              <CurveRowView key={row.tenor_label} row={row} maxAbsSpread={maxAbsSpread} />
            ))}
          </div>
        </div>

        {/* Swap-pricer card */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-terminal-divider">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              Vanilla Swap Pricer
            </span>
            <span className="text-2xs text-terminal-dim font-mono">
              {pricer.tenor_years}Y &middot; {fmtNotional(pricer.notional)} &middot;{" "}
              <span className="uppercase">{pricer.direction}</span>
            </span>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <PricerStat label="Par Rate">
              <span className="font-mono tabular-nums text-base text-terminal-text">
                {fmtPct(pricer.par_rate)}
              </span>
              <span className="text-2xs text-terminal-dim">struck at-market</span>
            </PricerStat>
            <PricerStat label="PV (NPV)">
              <span
                className={`font-mono tabular-nums text-base ${
                  pvNearZero ? "text-accent-green" : "text-terminal-text"
                }`}
              >
                ${fmtUsd0(pricer.pv)}
              </span>
              <span className="text-2xs text-terminal-dim">
                {pvNearZero ? "fair / at par" : "mark-to-market"}
              </span>
            </PricerStat>
            <PricerStat label="DV01">
              <span className="font-mono tabular-nums text-base text-accent-amber">
                ${fmtUsd0(pricer.dv01)}
              </span>
              <span className="text-2xs text-terminal-dim">per 1bp</span>
            </PricerStat>
            <PricerStat label="Annuity">
              <span className="font-mono tabular-nums text-base text-terminal-text">
                ${fmtUsd0(pricer.annuity)}
              </span>
              <span className="text-2xs text-terminal-dim">fixed-leg PV01</span>
            </PricerStat>
          </div>
        </div>

        {/* Footer note */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <span className="uppercase tracking-wider">
            SOFR swaps &middot; Treasury DGS &middot; annual par bootstrap
          </span>
          <span className="uppercase tracking-wider">
            Spread = swap rate - UST yield &middot; DF in (0,1], decreasing
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function CurveRowView({ row, maxAbsSpread }: { row: CurveRow; maxAbsSpread: number }) {
  const bps = row.swap_spread_bps ?? 0;
  const color = spreadColor(bps);
  const pct = Math.max(2, Math.min(100, (Math.abs(bps) / maxAbsSpread) * 100));
  const negative = bps < 0;
  return (
    <div className="grid grid-cols-[56px_64px_64px_1fr_92px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Tenor */}
      <span className="font-mono text-xs text-terminal-text font-semibold">{row.tenor_label}</span>

      {/* Swap rate */}
      <span className="text-right font-mono tabular-nums text-xs text-terminal-text">
        {fmtPct(row.swap_rate)}
      </span>

      {/* Treasury yield */}
      <span className="text-right font-mono tabular-nums text-xs text-terminal-muted">
        {fmtPct(row.treasury_yield)}
      </span>

      {/* Spread bar, anchored at a center axis (left = negative, right = positive) */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative h-2.5 flex-1 rounded-full bg-terminal-divider/40 overflow-hidden">
          {/* zero axis */}
          <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-muted/60" />
          <div
            className="absolute inset-y-0 rounded-full"
            style={
              negative
                ? ({ right: "50%", width: `${pct / 2}%`, backgroundColor: color } as CSSProperties)
                : ({ left: "50%", width: `${pct / 2}%`, backgroundColor: color } as CSSProperties)
            }
          />
        </div>
        <span
          className={`text-2xs font-mono tabular-nums w-12 text-right shrink-0 ${spreadTextClass(
            row.swap_spread_bps
          )}`}
        >
          {fmtBps(row.swap_spread_bps)}
        </span>
      </div>

      {/* Discount factor */}
      <span className="text-right font-mono tabular-nums text-xs text-terminal-dim">
        {fmtDF(row.discount_factor)}
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

function PricerStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
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
