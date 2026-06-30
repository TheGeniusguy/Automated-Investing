import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface EmCountry {
  country: string;
  code: string;
  flag_label: string;
  fx_reserves_usd: number;
  import_cover_months: number;
  embi_spread_bps: number;
  cds_5y_proxy_bps: number;
  external_debt_pct_gdp: number;
  reserves_to_debt: number;
  risk_score: number;
  risk_band: string;
}

interface EmRef {
  country: string;
  code: string;
  flag_label: string;
  risk_score: number;
  risk_band: string;
  embi_spread_bps: number;
}

interface EmSummary {
  most_vulnerable: EmRef | null;
  safest: EmRef | null;
  avg_spread: number;
  count: number;
}

interface EmSovereignResponse {
  countries: EmCountry[];
  summary: EmSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Risk score -> heatmap color, ramping green (safe) -> amber -> red (crisis).
function riskColor(score: number): string {
  if (score >= 60) return "#c2603f"; // deep red - critical
  if (score >= 48) return "#cc6a44"; // red - high
  if (score >= 36) return "#cc8a55"; // clay-orange - elevated
  if (score >= 24) return "#c9a24a"; // amber - moderate
  return "#6f8f5f"; // muted green - low
}

function bandTextClass(band: string): string {
  switch (band) {
    case "Critical":
    case "High":
      return "text-accent-red";
    case "Elevated":
    case "Moderate":
      return "text-accent-amber";
    default:
      return "text-accent-green";
  }
}

function bandPillStyle(band: string): CSSProperties {
  switch (band) {
    case "Critical":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "High":
      return { color: "#cc6a44", borderColor: "#cc6a44" };
    case "Elevated":
      return { color: "#cc8a55", borderColor: "#cc8a55" };
    case "Moderate":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    default:
      return { color: "#6f8f5f", borderColor: "#4f6347" };
  }
}

// Color the import-cover figure: thin cover is the stress signal.
function coverColor(months: number): string {
  if (months < 4) return "#c2603f";
  if (months < 6) return "#cc8a55";
  return "#a59c8e";
}

// Color the external-debt figure by stress.
function debtColor(pct: number): string {
  if (pct >= 60) return "#cc6a44";
  if (pct >= 45) return "#cc8a55";
  return "#a59c8e";
}

// Local fallback so the panel renders fully populated, even offline.
// Deterministic, monotonic-by-score EM grid (riskiest first).

const FALLBACK: EmSovereignResponse = (() => {
  // [country, code, flag, reserves(B), cover(mo), spread, ext-debt%, res/debt, score, band]
  const seed: Array<[string, string, string, number, number, number, number, number, number, string]> = [
    ["Egypt", "EG", "\u{1F1EA}\u{1F1EC}", 46, 6.6, 560, 43, 0.27, 66.8, "Critical"],
    ["Turkey", "TR", "\u{1F1F9}\u{1F1F7}", 150, 5.0, 380, 50, 0.27, 61.6, "Critical"],
    ["Hungary", "HU", "\u{1F1ED}\u{1F1FA}", 45, 3.8, 200, 60, 0.34, 55.2, "High"],
    ["Chile", "CL", "\u{1F1E8}\u{1F1F1}", 46, 6.1, 150, 70, 0.19, 55.0, "High"],
    ["South Africa", "ZA", "\u{1F1FF}\u{1F1E6}", 62, 6.9, 320, 42, 0.37, 48.5, "High"],
    ["Colombia", "CO", "\u{1F1E8}\u{1F1F4}", 60, 10.0, 290, 55, 0.30, 47.3, "Elevated"],
    ["Malaysia", "MY", "\u{1F1F2}\u{1F1FE}", 115, 5.8, 100, 65, 0.41, 45.2, "Elevated"],
    ["Mexico", "MX", "\u{1F1F2}\u{1F1FD}", 215, 4.8, 210, 35, 0.34, 44.1, "Elevated"],
    ["Poland", "PL", "\u{1F1F5}\u{1F1F1}", 200, 7.1, 120, 50, 0.49, 36.0, "Elevated"],
    ["Indonesia", "ID", "\u{1F1EE}\u{1F1E9}", 145, 8.1, 175, 30, 0.35, 33.2, "Moderate"],
    ["Brazil", "BR", "\u{1F1E7}\u{1F1F7}", 350, 16.7, 240, 38, 0.44, 30.2, "Moderate"],
    ["Philippines", "PH", "\u{1F1F5}\u{1F1ED}", 105, 9.5, 130, 28, 0.80, 15.6, "Low"],
    ["India", "IN", "\u{1F1EE}\u{1F1F3}", 645, 11.7, 110, 19, 0.87, 4.8, "Low"],
  ];
  const countries: EmCountry[] = seed
    .map(([country, code, flag, reservesB, cover, spread, debt, rtd, score, band]) => ({
      country,
      code,
      flag_label: flag,
      fx_reserves_usd: reservesB * 1e9,
      import_cover_months: cover,
      embi_spread_bps: spread,
      cds_5y_proxy_bps: Math.round(spread * 0.95),
      external_debt_pct_gdp: debt,
      reserves_to_debt: rtd,
      risk_score: score,
      risk_band: band,
    }))
    .sort((a, b) => b.risk_score - a.risk_score);
  const toRef = (c: EmCountry): EmRef => ({
    country: c.country,
    code: c.code,
    flag_label: c.flag_label,
    risk_score: c.risk_score,
    risk_band: c.risk_band,
    embi_spread_bps: c.embi_spread_bps,
  });
  const avg = Math.round(countries.reduce((s, c) => s + c.embi_spread_bps, 0) / countries.length);
  return {
    countries,
    summary: {
      most_vulnerable: toRef(countries[0]),
      safest: toRef(countries[countries.length - 1]),
      avg_spread: avg,
      count: countries.length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtReserves(usd: number): string {
  const b = usd / 1e9;
  if (b >= 1000) return `$${(b / 1000).toFixed(2)}T`;
  return `$${b.toFixed(0)}B`;
}

function fmtBps(v: number): string {
  return `${Math.round(v)}`;
}

// Panel

export function EmSovereignPanel() {
  const [data, setData] = useState<EmSovereignResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/em-sovereign")
      .then((res) => res.json())
      .then((json: EmSovereignResponse) => {
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

  // Scale risk bars to the worst reading so the leader fills the track.
  const maxScore = useMemo(
    () => Math.max(60, ...countries.map((c) => c.risk_score)),
    [countries]
  );
  // Scale spread chips to the widest spread for a quick relative read.
  const maxSpread = useMemo(
    () => Math.max(400, ...countries.map((c) => c.embi_spread_bps)),
    [countries]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>EM SOVEREIGN RISK & RESERVES</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Most Vulnerable">
            <span className="stat-figure text-2xl text-accent-red leading-none truncate">
              {summary.most_vulnerable
                ? `${summary.most_vulnerable.flag_label} ${summary.most_vulnerable.code}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.most_vulnerable
                ? `score ${summary.most_vulnerable.risk_score.toFixed(0)} - ${summary.most_vulnerable.risk_band}`
                : ""}
            </span>
          </KpiCell>
          <KpiCell label="Safest">
            <span className="stat-figure text-2xl text-accent-green leading-none truncate">
              {summary.safest
                ? `${summary.safest.flag_label} ${summary.safest.code}`
                : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {summary.safest
                ? `score ${summary.safest.risk_score.toFixed(0)} - ${summary.safest.risk_band}`
                : ""}
            </span>
          </KpiCell>
          <KpiCell label="Avg EMBI Spread">
            <span className="stat-figure text-2xl tabular-nums text-accent-amber leading-none">
              {fmtBps(summary.avg_spread)}
              <span className="text-sm text-terminal-dim ml-1">bps</span>
            </span>
            <span className="text-2xs text-terminal-dim">
              across {summary.count} sovereigns
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Crisis vulnerability rises with wider hard-currency spreads, heavier external debt,
            thinner import cover, and weaker reserve buffers. The riskiest sovereigns sit at the
            top - where an external-financing squeeze would bite first.
          </p>
        </div>

        {/* HERO: crisis-vulnerability heatmap grid */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[150px_1fr_72px_64px_64px_60px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Sovereign</SectionLabel>
            <SectionLabel>Crisis-vulnerability score</SectionLabel>
            <SectionLabel right>EMBI / CDS</SectionLabel>
            <SectionLabel right>Cover (mo)</SectionLabel>
            <SectionLabel right>Ext-debt</SectionLabel>
            <SectionLabel right>Band</SectionLabel>
          </div>

          <div className="flex flex-col">
            {countries.map((row, i) => (
              <RiskRow
                key={row.code}
                row={row}
                maxScore={maxScore}
                maxSpread={maxSpread}
                rank={i + 1}
              />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="Critical >= 60" />
            <LegendSwatch color="#cc8a55" label="Elevated >= 36" />
            <LegendSwatch color="#c9a24a" label="Moderate >= 24" />
            <LegendSwatch color="#6f8f5f" label="Low" />
          </div>
          <span className="uppercase tracking-wider">
            EMBI = country long-term yield over US 10Y; CDS 5y is a recovery-adjusted proxy
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function RiskRow({
  row,
  maxScore,
  maxSpread,
  rank,
}: {
  row: EmCountry;
  maxScore: number;
  maxSpread: number;
  rank: number;
}) {
  const color = riskColor(row.risk_score);
  const pct = Math.max(3, Math.min(100, (row.risk_score / maxScore) * 100));
  const spreadPct = Math.max(2, Math.min(100, (row.embi_spread_bps / maxSpread) * 100));
  return (
    <div className="grid grid-cols-[150px_1fr_72px_64px_64px_60px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Rank + flag + country */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="text-sm shrink-0">{row.flag_label}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold truncate">{row.country}</span>
      </div>

      {/* Risk bar + reserves / import-cover sub-line */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
          {/* spread overlay marker - a thin tick at the relative spread position */}
          <div
            className="absolute inset-y-0 w-px bg-terminal-text/50"
            style={{ left: `${spreadPct}%` }}
          />
        </div>
        <span className="text-2xs text-terminal-muted truncate">
          <span className="font-mono tabular-nums text-terminal-text">{row.risk_score.toFixed(1)}</span>
          <span className="text-terminal-dim"> score - </span>
          <span className="tabular-nums">{fmtReserves(row.fx_reserves_usd)}</span>
          <span className="text-terminal-dim"> reserves, res/debt </span>
          <span className="tabular-nums">{row.reserves_to_debt.toFixed(2)}x</span>
        </span>
      </div>

      {/* EMBI spread / CDS proxy */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span style={{ color }}>{fmtBps(row.embi_spread_bps)}</span>
        <div className="text-2xs text-terminal-dim">cds {fmtBps(row.cds_5y_proxy_bps)}</div>
      </div>

      {/* Import cover months */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span style={{ color: coverColor(row.import_cover_months) }}>
          {row.import_cover_months.toFixed(1)}
        </span>
      </div>

      {/* External debt % GDP */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span style={{ color: debtColor(row.external_debt_pct_gdp) }}>
          {row.external_debt_pct_gdp.toFixed(0)}%
        </span>
      </div>

      {/* Risk band pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={bandPillStyle(row.risk_band)}>
          <span className={bandTextClass(row.risk_band)}>{row.risk_band}</span>
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
