import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface ScoreCell {
  indicator: string;
  value: number;
  heat: number; // 0-100, 100 = good/green, 0 = bad/red
  direction: string; // "higher_better" | "higher_worse" | "target_2pct" (CPI tent)
}

interface CountryRow {
  country: string;
  code: string;
  flag_label: string;
  cells: ScoreCell[];
  composite: number;
}

interface ScoreRef {
  country: string;
  code: string;
  flag_label: string;
  composite: number;
  cpi?: number | null;
}

interface ScorecardSummary {
  strongest: ScoreRef | null;
  weakest: ScoreRef | null;
  hottest_inflation: ScoreRef | null;
  count: number;
}

interface ScorecardResponse {
  indicators: string[];
  indicator_meta?: Record<string, { label: string; unit: string }>;
  countries: CountryRow[];
  summary: ScorecardSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Column order + short labels for the heatmap header.
const INDICATORS = ["GDP", "CPI", "Unemployment", "PolicyRate", "PMI", "CurrentAccount"];

const SHORT_LABEL: Record<string, string> = {
  GDP: "GDP",
  CPI: "CPI",
  Unemployment: "Unemp",
  PolicyRate: "Rate",
  PMI: "PMI",
  CurrentAccount: "C/A",
};

const DIRECTION: Record<string, string> = {
  GDP: "higher_better",
  CPI: "target_2pct", // non-monotone tent peaked at the 2% target
  Unemployment: "higher_worse",
  PolicyRate: "higher_worse",
  PMI: "higher_better",
  CurrentAccount: "higher_better",
};

// Composite weights: real-economy momentum (GDP growth + PMI activity) at 2x, the
// nominal / stability legs at 1x. Mirrors backend macro_scorecard.COMPOSITE_WEIGHTS.
const COMPOSITE_WEIGHTS: Record<string, number> = {
  GDP: 2,
  PMI: 2,
  CPI: 1,
  Unemployment: 1,
  PolicyRate: 1,
  CurrentAccount: 1,
};

// Human-readable direction hint for the cell tooltip / legend.
function directionHint(direction: string): string {
  if (direction === "higher_better") return "higher = better";
  if (direction === "target_2pct") return "closer to 2% target = better";
  return "higher = worse";
}

// Heat scoring (mirrors backend macro_scorecard._heat) so the offline fallback
// is internally consistent with the live payload.
function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function heatFor(indicator: string, v: number): number {
  if (indicator === "GDP") return Math.round(clamp((v + 2) / 8 * 100) * 10) / 10;
  if (indicator === "CPI")
    return Math.round(clamp(v <= 2 ? 100 - (2 - v) * 8 : 100 - (v - 2) * 9) * 10) / 10;
  if (indicator === "Unemployment") return Math.round(clamp(100 - (v - 3) / 9 * 100) * 10) / 10;
  if (indicator === "PolicyRate") return Math.round(clamp(100 - v / 15 * 100) * 10) / 10;
  if (indicator === "PMI") return Math.round(clamp(50 + (v - 50) * 6.25) * 10) / 10;
  if (indicator === "CurrentAccount") return Math.round(clamp((v + 6) / 14 * 100) * 10) / 10;
  return 50;
}

// Diverging heat fill: green (good) above neutral, red (bad) below. Alpha ramps
// with distance from the neutral midpoint so strong readings read loud.
function cellStyle(heat: number): CSSProperties {
  const t = clamp(Math.abs(heat - 50) / 50, 0, 1);
  const alpha = (0.1 + t * 0.5).toFixed(3);
  const rgb = heat >= 50 ? "95,148,96" : "194,96,63"; // ink-green / clay-red
  return {
    backgroundColor: `rgba(${rgb},${alpha})`,
    color: t > 0.42 ? "#ece6da" : "#a59c8e",
  };
}

function compositeColor(c: number): string {
  if (c >= 65) return "#5f9460"; // green, strong
  if (c >= 55) return "#84934f"; // olive
  if (c >= 45) return "#c9a24a"; // amber, middling
  if (c >= 35) return "#cc6a44"; // clay-orange
  return "#c2603f"; // red, weak
}

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend curated mid-2026 grid; heats are derived so the math stays consistent.

const FALLBACK: ScorecardResponse = (() => {
  // country, code, flag, gdp, cpi, unemp, policy, pmi, currentAccount
  const raw: Array<[string, string, string, number, number, number, number, number, number]> = [
    ["United States", "US", "\u{1F1FA}\u{1F1F8}", 2.1, 2.6, 4.2, 4.5, 51.5, -3.2],
    ["Euro Area / Germany", "EA", "\u{1F1EA}\u{1F1FA}", 0.8, 2.1, 6.3, 2.15, 50.2, 2.6],
    ["United Kingdom", "GB", "\u{1F1EC}\u{1F1E7}", 1.1, 3.1, 4.5, 4.0, 50.8, -2.8],
    ["Japan", "JP", "\u{1F1EF}\u{1F1F5}", 0.9, 2.8, 2.5, 0.75, 49.5, 3.4],
    ["China", "CN", "\u{1F1E8}\u{1F1F3}", 4.7, 0.6, 5.1, 2.9, 49.8, 1.4],
    ["India", "IN", "\u{1F1EE}\u{1F1F3}", 6.5, 3.2, 7.8, 5.5, 56.2, -1.2],
    ["Brazil", "BR", "\u{1F1E7}\u{1F1F7}", 2.2, 4.6, 6.6, 14.25, 51.0, -2.3],
    ["Canada", "CA", "\u{1F1E8}\u{1F1E6}", 1.4, 2.3, 6.1, 2.75, 50.5, -0.8],
    ["Australia", "AU", "\u{1F1E6}\u{1F1FA}", 1.7, 2.9, 4.1, 3.6, 50.9, 1.1],
    ["Mexico", "MX", "\u{1F1F2}\u{1F1FD}", 1.2, 3.8, 2.8, 7.75, 49.2, -0.9],
    ["South Korea", "KR", "\u{1F1F0}\u{1F1F7}", 2.0, 2.2, 2.9, 2.5, 49.7, 3.8],
    ["Turkiye", "TR", "\u{1F1F9}\u{1F1F7}", 3.0, 33.5, 8.7, 43.0, 47.5, -3.5],
  ];

  const countries: CountryRow[] = raw
    .map(([country, code, flag, gdp, cpi, unemp, policy, pmi, ca]) => {
      const values: Record<string, number> = {
        GDP: gdp,
        CPI: cpi,
        Unemployment: unemp,
        PolicyRate: policy,
        PMI: pmi,
        CurrentAccount: ca,
      };
      const cells: ScoreCell[] = INDICATORS.map((ind) => ({
        indicator: ind,
        value: values[ind],
        heat: heatFor(ind, values[ind]),
        direction: DIRECTION[ind],
      }));
      const wSum = cells.reduce((s, c) => s + c.heat * (COMPOSITE_WEIGHTS[c.indicator] ?? 1), 0);
      const wTot = cells.reduce((s, c) => s + (COMPOSITE_WEIGHTS[c.indicator] ?? 1), 0);
      const composite = Math.round((wSum / wTot) * 10) / 10;
      return { country, code, flag_label: flag, cells, composite };
    })
    .sort((a, b) => b.composite - a.composite);

  const cpiOf = (r: CountryRow) => r.cells.find((c) => c.indicator === "CPI")?.value ?? -Infinity;
  const hottest = countries.reduce((m, r) => (cpiOf(r) > cpiOf(m) ? r : m), countries[0]);
  const toRef = (r: CountryRow, withCpi = false): ScoreRef => ({
    country: r.country,
    code: r.code,
    flag_label: r.flag_label,
    composite: r.composite,
    ...(withCpi ? { cpi: cpiOf(r) } : {}),
  });

  return {
    indicators: [...INDICATORS],
    countries,
    summary: {
      strongest: toRef(countries[0]),
      weakest: toRef(countries[countries.length - 1]),
      hottest_inflation: toRef(hottest, true),
      count: countries.length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated cross-country macro grid",
  };
})();

// Formatting

function fmtVal(indicator: string, v: number): string {
  if (indicator === "PMI") return v.toFixed(1);
  return v.toFixed(1);
}

// Panel

export function MacroScorecardPanel() {
  const [data, setData] = useState<ScorecardResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/macro-scorecard")
      .then((res) => res.json())
      .then((json: ScorecardResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.countries) && json.countries.length > 0) {
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

  const { countries, summary } = data;
  const indicators = data.indicators?.length ? data.indicators : INDICATORS;
  const meta = data.indicator_meta;

  const gridCols = useMemo(
    () => `132px repeat(${indicators.length}, 1fr) 58px`,
    [indicators.length]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>GLOBAL MACRO SCORECARD</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Strongest Economy">
            <span className="stat-figure text-2xl text-accent-green leading-none truncate">
              {summary.strongest ? `${summary.strongest.flag_label} ${summary.strongest.code}` : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.strongest ? `${summary.strongest.composite.toFixed(0)}/100 composite` : ""}
            </span>
          </KpiCell>
          <KpiCell label="Weakest Economy">
            <span className="stat-figure text-2xl text-accent-red leading-none truncate">
              {summary.weakest ? `${summary.weakest.flag_label} ${summary.weakest.code}` : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.weakest ? `${summary.weakest.composite.toFixed(0)}/100 composite` : ""}
            </span>
          </KpiCell>
          <KpiCell label="Hottest Inflation">
            <span className="stat-figure text-2xl text-accent-amber leading-none truncate">
              {summary.hottest_inflation
                ? `${summary.hottest_inflation.flag_label} ${summary.hottest_inflation.code}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.hottest_inflation?.cpi != null
                ? `CPI ${summary.hottest_inflation.cpi.toFixed(1)}% YoY`
                : ""}
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Each cell is scored 0-100 in the economically correct direction, faster growth,
            inflation near the 2% target, fuller employment and a healthier external balance all
            read green. The composite weights growth and activity most, ranking where momentum, and
            fragility, sit across the world right now.
          </p>
        </div>

        {/* HERO: cross-country heatmap */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div
            className="grid items-end gap-1 pb-1.5 mb-1 border-b border-terminal-divider"
            style={{ gridTemplateColumns: gridCols }}
          >
            <SectionLabel>Country</SectionLabel>
            {indicators.map((ind) => (
              <div key={ind} className="flex flex-col items-center">
                <span className="text-2xs text-terminal-muted uppercase tracking-wider">
                  {SHORT_LABEL[ind] ?? ind}
                </span>
                <span className="text-2xs text-terminal-dim normal-case tracking-normal">
                  {meta?.[ind]?.unit ?? ""}
                </span>
              </div>
            ))}
            <SectionLabel right>Score</SectionLabel>
          </div>

          <div className="flex flex-col">
            {countries.map((row) => (
              <ScoreRowView key={row.code} row={row} indicators={indicators} gridCols={gridCols} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="rgba(95,148,96,0.6)" label="Good / supportive" />
            <LegendSwatch color="rgba(138,129,117,0.35)" label="Neutral" />
            <LegendSwatch color="rgba(194,96,63,0.6)" label="Bad / fragile" />
          </div>
          <span className="uppercase tracking-wider">
            Composite = growth-weighted mean of the 6 scores
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function ScoreRowView({
  row,
  indicators,
  gridCols,
}: {
  row: CountryRow;
  indicators: string[];
  gridCols: string;
}) {
  const byInd = useMemo(() => {
    const m: Record<string, ScoreCell> = {};
    for (const c of row.cells) m[c.indicator] = c;
    return m;
  }, [row.cells]);

  return (
    <div
      className="grid items-stretch gap-1 py-1 border-b border-terminal-divider/40 last:border-0"
      style={{ gridTemplateColumns: gridCols }}
    >
      {/* Country */}
      <div className="flex items-center gap-1.5 min-w-0 pr-1">
        <span className="text-sm shrink-0">{row.flag_label}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">
          {row.code}
        </span>
        <span className="text-2xs text-terminal-dim truncate">{row.country}</span>
      </div>

      {/* Indicator cells */}
      {indicators.map((ind) => {
        const cell = byInd[ind];
        if (!cell) {
          return (
            <div
              key={ind}
              className="flex items-center justify-center rounded text-2xs text-terminal-dim"
            >
              --
            </div>
          );
        }
        return (
          <div
            key={ind}
            className="flex items-center justify-center rounded font-mono tabular-nums text-xs py-1"
            style={cellStyle(cell.heat)}
            title={`${ind} ${fmtVal(ind, cell.value)} (score ${cell.heat.toFixed(0)}/100, ${directionHint(
              cell.direction ?? DIRECTION[ind]
            )})`}
          >
            {fmtVal(ind, cell.value)}
          </div>
        );
      })}

      {/* Composite */}
      <div className="flex items-center justify-end">
        <span
          className="font-mono tabular-nums text-xs font-semibold"
          style={{ color: compositeColor(row.composite) }}
        >
          {row.composite.toFixed(0)}
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
