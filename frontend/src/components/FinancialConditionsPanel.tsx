import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface ConditionsIndex {
  key: string;
  label: string;
  value: number;
  prior: number;
  change: number;
  zscore: number;
  regime: string;
}

interface ConditionsComponent {
  key: string;
  label: string;
  value: number;
  unit?: string;
  zscore: number;
  contribution: number;
}

interface Composite {
  value: number;
  tightness_0_100: number;
  regime: string;
}

interface Verdict {
  regime: string;
  summary_line: string;
}

interface ConditionsSummary {
  headline: string;
  tightest_component: string | null;
  loosest_component: string | null;
}

interface FinancialConditionsResponse {
  indices: ConditionsIndex[];
  components: ConditionsComponent[];
  composite: Composite;
  verdict: Verdict;
  summary: ConditionsSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Regime -> color. Tight = restrictive = red, Loose = easy = green, Neutral = muted.

function regimeTextClass(regime: string): string {
  switch (regime) {
    case "Tight":
      return "text-accent-red";
    case "Loose":
      return "text-accent-green";
    default:
      return "text-terminal-muted";
  }
}

function regimePillStyle(regime: string): CSSProperties {
  switch (regime) {
    case "Tight":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "Loose":
      return { color: "#5e8c6a", borderColor: "#5e8c6a" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Gauge fill ramps green (loose) -> amber (neutral) -> red (tight).
function gaugeColor(tightness: number): string {
  if (tightness >= 70) return "#c2603f"; // tight, deep red
  if (tightness >= 58) return "#cc8a55"; // leaning tight, clay
  if (tightness >= 42) return "#c9a24a"; // neutral, amber
  if (tightness >= 30) return "#7f9b6f"; // leaning loose
  return "#5e8c6a"; // loose, green
}

// A positive z = tighter (red, extends right). Negative z = looser (green, left).
function zColor(z: number): string {
  return z >= 0 ? "#c2603f" : "#5e8c6a";
}

// Local fallback so the panel renders fully populated, even offline.
// A modestly LOOSE late-cycle print, mirroring the backend sample shape.

const FALLBACK: FinancialConditionsResponse = (() => {
  const indices: ConditionsIndex[] = [
    { key: "NFCI", label: "Chicago Fed NFCI", value: -0.42, prior: -0.4, change: -0.02, zscore: -0.55, regime: "Loose" },
    { key: "ANFCI", label: "Adjusted NFCI", value: -0.18, prior: -0.15, change: -0.03, zscore: -0.3, regime: "Loose" },
    { key: "STLFSI4", label: "St. Louis Fed Stress", value: -0.55, prior: -0.5, change: -0.05, zscore: -0.62, regime: "Loose" },
  ];
  const rawComponents: Array<[string, string, number, string, number]> = [
    ["hy_oas", "HY Credit Spread", 3.18, "%", -0.85],
    ["ig_oas", "IG Credit Spread", 0.86, "%", -0.7],
    ["equity_vol", "Equity Vol (VIX)", 15.4, "idx", -0.8],
    ["usd", "Broad US Dollar", 121.3, "idx", 0.3],
    ["real_rate", "10y Real Rate", 1.94, "%", 0.4],
  ];
  const n = rawComponents.length;
  const components: ConditionsComponent[] = rawComponents.map(([key, label, value, unit, z]) => ({
    key,
    label,
    value,
    unit,
    zscore: z,
    contribution: Math.round((z / n) * 1000) / 1000,
  }));
  const compositeValue = Math.round((components.reduce((s, c) => s + c.zscore, 0) / n) * 1000) / 1000;
  return {
    indices,
    components,
    composite: { value: compositeValue, tightness_0_100: 39.9, regime: "Loose" },
    verdict: {
      regime: "Loose",
      summary_line:
        "Financial conditions are LOOSE (40/100 tightness, composite z -0.33) - ample liquidity and calm markets are supporting risk assets.",
    },
    summary: {
      headline: "Loose regime - tightness gauge 40/100, below the neutral midpoint.",
      tightest_component: "10y Real Rate",
      loosest_component: "HY Credit Spread",
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtSigned(v: number, digits = 2): string {
  return (v >= 0 ? "+" : "") + v.toFixed(digits);
}

function fmtValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(2);
}

// Panel

export function FinancialConditionsPanel() {
  const [data, setData] = useState<FinancialConditionsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/financial-conditions")
      .then((res) => res.json())
      .then((json: FinancialConditionsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.indices) && json.indices.length > 0) {
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

  const { indices, components, composite, verdict, summary } = data;

  // Scale z-score bars so the largest absolute reading nearly fills its half-track.
  const maxAbsZ = useMemo(
    () => Math.max(1.5, ...components.map((c) => Math.abs(c.zscore))),
    [components]
  );

  const gauge = composite.tightness_0_100;
  const gColor = gaugeColor(gauge);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>FINANCIAL CONDITIONS MONITOR</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* HERO: verdict + tightness gauge */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 flex flex-col gap-2.5">
          <div className="flex items-end justify-between gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-2xs text-terminal-dim uppercase tracking-wider">Verdict</span>
              <span className={`stat-figure text-4xl leading-none ${regimeTextClass(verdict.regime)}`}>
                {verdict.regime}
              </span>
            </div>
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <span className="text-2xs text-terminal-dim uppercase tracking-wider">Tightness</span>
              <span className="stat-figure text-4xl tabular-nums leading-none" style={{ color: gColor }}>
                {gauge.toFixed(0)}
              </span>
              <span className="text-2xs text-terminal-dim">/ 100</span>
            </div>
          </div>

          {/* Gauge track: 0 (loose) -> 50 (neutral) -> 100 (tight) */}
          <div>
            <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${Math.max(2, Math.min(100, gauge))}%`, backgroundColor: gColor }}
              />
              {/* neutral midpoint marker */}
              <div className="absolute inset-y-0 w-px bg-terminal-muted/70" style={{ left: "50%" }} />
            </div>
            <div className="flex justify-between text-2xs text-terminal-dim mt-1 uppercase tracking-wider">
              <span className="text-accent-green">Loose</span>
              <span>Neutral</span>
              <span className="text-accent-red">Tight</span>
            </div>
          </div>

          <p className="text-sm text-terminal-text font-serif leading-snug">
            {verdict.summary_line}
          </p>
        </div>

        {/* Official indices row */}
        <div>
          <SectionLabel>Official Indices (positive = tighter)</SectionLabel>
          <div className="grid grid-cols-3 gap-2 mt-1.5">
            {indices.map((idx) => (
              <IndexCell key={idx.key} idx={idx} />
            ))}
          </div>
        </div>

        {/* Homemade component breakdown */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          <div className="grid grid-cols-[124px_1fr_58px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Sub-component</SectionLabel>
            <SectionLabel>Looser &larr;&nbsp;&nbsp;z-score&nbsp;&nbsp;&rarr; Tighter</SectionLabel>
            <SectionLabel right>Contrib</SectionLabel>
          </div>
          <div className="flex flex-col">
            {components.map((c) => (
              <ComponentRow key={c.key} comp={c} maxAbsZ={maxAbsZ} />
            ))}
          </div>
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-terminal-divider">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">Homemade composite z</span>
            <span
              className="font-mono tabular-nums text-xs font-semibold"
              style={{ color: zColor(composite.value) }}
            >
              {fmtSigned(composite.value)}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#5e8c6a" label="Loose / easing" />
            <LegendSwatch color="#c9a24a" label="Neutral" />
            <LegendSwatch color="#c2603f" label="Tight / restrictive" />
          </div>
          <span className="uppercase tracking-wider">
            NFCI + ANFCI + STLFSI + homemade sub-index (spreads, vol, USD, real rates)
          </span>
        </div>

        {/* One-line summary read */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <span className="truncate">
            Tightest: <span className="text-accent-red">{summary.tightest_component ?? "--"}</span>
            <span className="mx-2 text-terminal-divider">|</span>
            Loosest: <span className="text-accent-green">{summary.loosest_component ?? "--"}</span>
          </span>
          <span className="uppercase tracking-wider">Source: FRED</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function IndexCell({ idx }: { idx: ConditionsIndex }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-1 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate" title={idx.label}>
        {idx.label}
      </div>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`stat-figure text-2xl tabular-nums leading-none ${regimeTextClass(idx.regime)}`}>
          {fmtSigned(idx.value, 2)}
        </span>
        <span className="pill uppercase tracking-wider shrink-0" style={regimePillStyle(idx.regime)}>
          {idx.regime}
        </span>
      </div>
      <div className="flex items-center justify-between text-2xs text-terminal-dim font-mono tabular-nums">
        <span>z {fmtSigned(idx.zscore, 1)}</span>
        <span style={{ color: zColor(idx.change) }}>&Delta; {fmtSigned(idx.change, 2)}</span>
      </div>
    </div>
  );
}

function ComponentRow({ comp, maxAbsZ }: { comp: ConditionsComponent; maxAbsZ: number }) {
  const z = comp.zscore;
  const color = zColor(z);
  // Half-width fraction (0..50% of the track) on the correct side of center.
  const half = Math.min(50, (Math.abs(z) / maxAbsZ) * 50);
  return (
    <div className="grid grid-cols-[124px_1fr_58px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Label + raw value */}
      <div className="flex flex-col min-w-0">
        <span className="font-mono text-xs text-terminal-text font-semibold truncate">{comp.label}</span>
        <span className="text-2xs text-terminal-dim tabular-nums">
          {fmtValue(comp.value)}
          {comp.unit ? ` ${comp.unit}` : ""}
        </span>
      </div>

      {/* Centered z-score bar */}
      <div className="relative h-3 rounded-sm bg-terminal-divider/40 overflow-hidden">
        {/* center axis */}
        <div className="absolute inset-y-0 w-px bg-terminal-muted/70" style={{ left: "50%" }} />
        <div
          className="absolute inset-y-0"
          style={
            z >= 0
              ? { left: "50%", width: `${half}%`, backgroundColor: color }
              : { right: "50%", width: `${half}%`, backgroundColor: color }
          }
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 text-2xs font-mono tabular-nums text-terminal-bg font-semibold px-1"
          style={z >= 0 ? { left: "calc(50% + 2px)" } : { right: "calc(50% + 2px)" }}
        >
          {fmtSigned(z, 1)}
        </span>
      </div>

      {/* Contribution to composite */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span style={{ color }}>{fmtSigned(comp.contribution, 2)}</span>
      </div>
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
