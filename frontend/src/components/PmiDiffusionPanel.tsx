import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface Survey {
  key: string;
  label: string;
  category: string;
  value: number;
  prior: number | null;
  change: number | null;
  center: number;
  expanding: boolean;
  heat_0_100: number;
}

interface Composite {
  diffusion_score: number;
  prior_score: number;
  momentum_delta: number;
  momentum: string;
  expanding_share: number;
}

interface Summary {
  headline: string;
  strongest: string | null;
  weakest: string | null;
  expanding_count: number;
  contracting_count: number;
}

interface PmiDiffusionResponse {
  surveys: Survey[];
  composite: Composite;
  summary: Summary;
  data_mode: string;
  as_of: string;
  source: string;
}

const CATEGORY_ORDER = ["National ISM / S&P Global", "Regional Fed Manufacturing"];

// Heat ramp: green (expanding) -> neutral -> red (contracting) on the 0-100 scale.
function heatColor(heat: number): string {
  if (heat >= 66) return "#6f8f5f"; // healthy green, broad expansion
  if (heat >= 56) return "#8aa06a"; // soft green
  if (heat >= 50) return "#a7a578"; // just above neutral
  if (heat >= 45) return "#c9a24a"; // amber, slipping
  if (heat >= 35) return "#cc8a55"; // clay-orange
  return "#c2603f"; // deep red, contracting
}

function valueTextClass(expanding: boolean): string {
  return expanding ? "text-accent-green" : "text-accent-red";
}

function changeClass(change: number | null): string {
  if (change === null) return "text-terminal-dim";
  if (change > 0) return "text-accent-green";
  if (change < 0) return "text-accent-red";
  return "text-terminal-muted";
}

function momentumGlyph(momentum: string): string {
  if (momentum === "accelerating") return "▲"; // up triangle
  if (momentum === "decelerating") return "▼"; // down triangle
  return "▬"; // flat bar
}

function momentumClass(momentum: string): string {
  if (momentum === "accelerating") return "text-accent-green";
  if (momentum === "decelerating") return "text-accent-red";
  return "text-terminal-muted";
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic mid-cycle snapshot: services holding up, manufacturing soft.

const FALLBACK: PmiDiffusionResponse = (() => {
  const seed: Array<[string, string, string, number, number, number]> = [
    ["ism_mfg", "ISM Manufacturing PMI", "National ISM / S&P Global", 48.5, 47.9, 50],
    ["ism_services", "ISM Services PMI", "National ISM / S&P Global", 52.0, 51.4, 50],
    ["spg_mfg", "S&P Global Mfg PMI", "National ISM / S&P Global", 51.2, 50.6, 50],
    ["spg_services", "S&P Global Services PMI", "National ISM / S&P Global", 53.5, 52.9, 50],
    ["spg_composite", "S&P Global Composite PMI", "National ISM / S&P Global", 52.8, 52.1, 50],
    ["empire", "Empire State (NY Fed)", "Regional Fed Manufacturing", 3.0, -6.0, 0],
    ["philly", "Philadelphia Fed", "Regional Fed Manufacturing", -2.0, 1.5, 0],
    ["dallas", "Dallas Fed (TMOS)", "Regional Fed Manufacturing", -4.5, -7.2, 0],
    ["kansas_city", "Kansas City Fed", "Regional Fed Manufacturing", -1.0, -5.0, 0],
    ["richmond", "Richmond Fed", "Regional Fed Manufacturing", -3.0, -10.0, 0],
  ];
  const heatOf = (value: number, center: number) => {
    const slope = center === 50 ? 3.2 : 2.2;
    return Math.round(Math.max(0, Math.min(100, 50 + (value - center) * slope)) * 10) / 10;
  };
  const surveys: Survey[] = seed.map(([key, label, category, value, prior, center]) => ({
    key,
    label,
    category,
    value,
    prior,
    change: Math.round((value - prior) * 10) / 10,
    center,
    expanding: value > center,
    heat_0_100: heatOf(value, center),
  }));
  const order: Record<string, number> = { [CATEGORY_ORDER[0]]: 0, [CATEGORY_ORDER[1]]: 1 };
  surveys.sort((a, b) =>
    order[a.category] - order[b.category] || b.heat_0_100 - a.heat_0_100
  );
  const expanding = surveys.filter((s) => s.expanding).length;
  const score = Math.round((surveys.reduce((s, r) => s + r.heat_0_100, 0) / surveys.length) * 10) / 10;
  const priorScore = Math.round(
    (surveys.reduce((s, r) => s + heatOf(r.prior ?? r.value, r.center), 0) / surveys.length) * 10
  ) / 10;
  const delta = Math.round((score - priorScore) * 10) / 10;
  const strongest = surveys.reduce((a, b) => (b.heat_0_100 > a.heat_0_100 ? b : a));
  const weakest = surveys.reduce((a, b) => (b.heat_0_100 < a.heat_0_100 ? b : a));
  return {
    surveys,
    composite: {
      diffusion_score: score,
      prior_score: priorScore,
      momentum_delta: delta,
      momentum: delta > 0.5 ? "accelerating" : delta < -0.5 ? "decelerating" : "stable",
      expanding_share: Math.round((expanding / surveys.length) * 1000) / 1000,
    },
    summary: {
      headline: `Business activity is near stall-speed (${expanding} of ${surveys.length} surveys above threshold); composite ${score.toFixed(0)}/100 and accelerating.`,
      strongest: strongest.label,
      weakest: weakest.label,
      expanding_count: expanding,
      contracting_count: surveys.length - expanding,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtValue(v: number): string {
  return v.toFixed(1);
}

function fmtChange(v: number | null): string {
  if (v === null) return "--";
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

// Panel

export function PmiDiffusionPanel() {
  const [data, setData] = useState<PmiDiffusionResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/pmi-diffusion")
      .then((res) => res.json())
      .then((json: PmiDiffusionResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.surveys) && json.surveys.length > 0) {
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

  const { surveys, composite, summary } = data;

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      rows: surveys.filter((s) => s.category === cat),
    })).filter((g) => g.rows.length > 0);
  }, [surveys]);

  const scoreColor = heatColor(composite.diffusion_score);
  const sharePct = Math.round(composite.expanding_share * 100);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>PMI / BUSINESS-SURVEY DIFFUSION</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Composite KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Composite Diffusion">
            <span className="stat-figure text-3xl tabular-nums leading-none" style={{ color: scoreColor }}>
              {composite.diffusion_score.toFixed(0)}
            </span>
            <span className="text-2xs text-terminal-dim">0-100 scale (50 = neutral)</span>
          </KpiCell>
          <KpiCell label="Momentum">
            <span className={`stat-figure text-3xl leading-none flex items-baseline gap-1.5 ${momentumClass(composite.momentum)}`}>
              <span className="text-xl">{momentumGlyph(composite.momentum)}</span>
              <span className="tabular-nums">{fmtChange(composite.momentum_delta)}</span>
            </span>
            <span className="text-2xs text-terminal-dim capitalize">{composite.momentum} vs prior</span>
          </KpiCell>
          <KpiCell label="Surveys Expanding">
            <span className={`stat-figure text-3xl tabular-nums leading-none ${summary.expanding_count >= summary.contracting_count ? "text-accent-green" : "text-accent-red"}`}>
              {summary.expanding_count}/{summary.expanding_count + summary.contracting_count}
            </span>
            <span className="text-2xs text-terminal-dim">{sharePct}% above threshold</span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{summary.headline}</p>
        </div>

        {/* HERO: diffusion heatmap, grouped national vs regional */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0 flex flex-col gap-2.5">
          {grouped.map((g) => (
            <div key={g.category} className="flex flex-col">
              <div className="grid grid-cols-[180px_1fr_60px_52px_64px] items-center gap-2 pb-1 mb-1 border-b border-terminal-divider">
                <SectionLabel>{g.category}</SectionLabel>
                <SectionLabel>Diffusion heat vs {g.rows[0].center === 50 ? "50" : "0"} threshold</SectionLabel>
                <SectionLabel right>Level</SectionLabel>
                <SectionLabel right>m/m</SectionLabel>
                <SectionLabel right>State</SectionLabel>
              </div>
              {g.rows.map((row) => (
                <DiffusionRow key={row.key} row={row} />
              ))}
            </div>
          ))}
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#6f8f5f" label="Expanding" />
            <LegendSwatch color="#a7a578" label="Neutral" />
            <LegendSwatch color="#c2603f" label="Contracting" />
          </div>
          <span className="uppercase tracking-wider">
            PMI &gt; 50 / regional Fed &gt; 0 = expansion
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function DiffusionRow({ row }: { row: Survey }) {
  const color = heatColor(row.heat_0_100);
  // The marker sits at the 50/0 threshold, which always maps to heat 50.
  const thresholdPct = 50;
  const fillPct = Math.max(2, Math.min(100, row.heat_0_100));
  return (
    <div className="grid grid-cols-[180px_1fr_60px_52px_64px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Label */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-mono text-xs text-terminal-text font-semibold truncate">{row.label}</span>
      </div>

      {/* Heat cell with threshold marker */}
      <div className="relative h-4 rounded bg-terminal-divider/50 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${fillPct}%`, backgroundColor: color }}
        />
        {/* 50/0 expansion-contraction threshold marker */}
        <div
          className="absolute inset-y-0 w-px bg-terminal-text/70"
          style={{ left: `${thresholdPct}%` }}
        />
        <span className="absolute inset-y-0 right-1 flex items-center text-2xs font-mono tabular-nums text-terminal-bg font-semibold">
          {row.heat_0_100.toFixed(0)}
        </span>
      </div>

      {/* Raw level */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span className={valueTextClass(row.expanding)}>{fmtValue(row.value)}</span>
      </div>

      {/* m/m change */}
      <div className="text-right font-mono tabular-nums text-2xs">
        <span className={changeClass(row.change)}>{fmtChange(row.change)}</span>
      </div>

      {/* State pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={statePillStyle(row.expanding)}>
          {row.expanding ? "Expand" : "Contract"}
        </span>
      </div>
    </div>
  );
}

function statePillStyle(expanding: boolean): CSSProperties {
  return expanding
    ? { color: "#6f8f5f", borderColor: "#6f8f5f" }
    : { color: "#c2603f", borderColor: "#c2603f" };
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
