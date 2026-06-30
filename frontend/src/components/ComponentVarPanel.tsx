import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface VarPosition {
  symbol: string;
  weight: number;          // % of total portfolio value
  standalone_vol: number;  // annualized %
  marginal_var: number;    // sensitivity of VaR to weight (return-space)
  component_var: number;   // dollars; sums to total_var95
  pct_of_var: number;      // % of total VaR contributed by this name
  beta_to_port: number;
}

interface VarSummary {
  top_risk_contributor: string | null;
  diversification_ratio: number | null;
  reconciles_pct: number;
}

interface ComponentVarResponse {
  portfolio_id: number | null;
  total_var95: number;
  total_cvar95: number;
  portfolio_value: number;
  positions: VarPosition[];
  summary: VarSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Red intensity ramps with how much of total tail risk a name drives.
function riskColor(pct: number): string {
  if (pct >= 30) return "#c2603f"; // deep red - dominant tail driver
  if (pct >= 18) return "#cc6a44"; // red
  if (pct >= 10) return "#cc8a55"; // clay-orange
  if (pct >= 5) return "#c9a24a";  // amber
  if (pct >= 0) return "#8a8175";  // neutral
  return "#5c554b";                // diversifier (negative contribution)
}

// Local fallback so the panel renders fully populated, even offline.
// A concentrated mega-cap tech book where a few names carry the tail.

const FALLBACK: ComponentVarResponse = (() => {
  const positions: VarPosition[] = [
    { symbol: "NVDA", weight: 19.16, standalone_vol: 52.0, marginal_var: 0.048, component_var: 8736.53, pct_of_var: 39.68, beta_to_port: 2.03 },
    { symbol: "TSLA", weight: 10.11, standalone_vol: 58.0, marginal_var: 0.0371, component_var: 3563.12, pct_of_var: 16.19, beta_to_port: 1.57 },
    { symbol: "AAPL", weight: 14.74, standalone_vol: 27.0, marginal_var: 0.0178, component_var: 2498.70, pct_of_var: 11.35, beta_to_port: 0.75 },
    { symbol: "AMZN", weight: 9.26, standalone_vol: 33.0, marginal_var: 0.0241, component_var: 2125.40, pct_of_var: 9.65, beta_to_port: 1.02 },
    { symbol: "MSFT", weight: 13.47, standalone_vol: 25.0, marginal_var: 0.0152, component_var: 1948.30, pct_of_var: 8.85, beta_to_port: 0.64 },
    { symbol: "GOOGL", weight: 7.58, standalone_vol: 30.0, marginal_var: 0.0205, component_var: 1476.90, pct_of_var: 6.71, beta_to_port: 0.87 },
    { symbol: "JPM", weight: 6.74, standalone_vol: 22.0, marginal_var: 0.0123, component_var: 786.40, pct_of_var: 3.57, beta_to_port: 0.52 },
    { symbol: "XOM", weight: 5.26, standalone_vol: 24.0, marginal_var: 0.0095, component_var: 474.10, pct_of_var: 2.15, beta_to_port: 0.40 },
    { symbol: "UNH", weight: 4.84, standalone_vol: 23.0, marginal_var: 0.0089, component_var: 405.31, pct_of_var: 1.84, beta_to_port: 0.38 },
  ].sort((a, b) => b.component_var - a.component_var);
  return {
    portfolio_id: null,
    total_var95: 22014.76,
    total_cvar95: 28236.45,
    portfolio_value: 950000.0,
    positions,
    summary: {
      top_risk_contributor: "NVDA",
      diversification_ratio: 1.407,
      reconciles_pct: 100.0,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(1)}%`;
}

// Panel

export function ComponentVarPanel() {
  const [data, setData] = useState<ComponentVarResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/component-var")
      .then((res) => res.json())
      .then((json: ComponentVarResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.positions) && json.positions.length > 0) {
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

  const { positions, summary, total_var95, total_cvar95, portfolio_value } = data;

  // Scale risk bars to the largest single contribution.
  const maxPct = useMemo(
    () => Math.max(1, ...positions.map((p) => Math.abs(p.pct_of_var))),
    [positions]
  );

  const componentSum = useMemo(
    () => positions.reduce((s, p) => s + p.component_var, 0),
    [positions]
  );

  // Reconciliation % derived from the rows actually rendered (not a trusted
  // payload field), so the footer can never show a green 100% that the
  // visible component VaRs contradict.
  const reconcilesPct = useMemo(
    () => (total_var95 > 0 ? (componentSum / total_var95) * 100 : 0),
    [componentSum, total_var95]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>COMPONENT VAR ATTRIBUTION</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Total VaR (95%, 1d)">
            <span className="stat-figure text-2xl tabular-nums text-accent-red leading-none">
              {fmtUsd(total_var95)}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              CVaR {fmtUsd(total_cvar95)} · {fmtPct((total_var95 / Math.max(portfolio_value, 1)) * 100)} of book
            </span>
          </KpiCell>
          <KpiCell label="Top Risk Driver">
            <span className="stat-figure text-2xl text-accent-amber leading-none truncate">
              {summary.top_risk_contributor ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {positions[0] ? `${positions[0].pct_of_var.toFixed(1)}% of tail risk` : ""}
            </span>
          </KpiCell>
          <KpiCell label="Diversification">
            <span className="stat-figure text-2xl tabular-nums text-accent-green leading-none">
              {summary.diversification_ratio != null ? summary.diversification_ratio.toFixed(2) : "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">vol benefit ratio</span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Weight tells you size; component VaR tells you where the downside actually concentrates.
            Names with the longest red bars drive your tail risk and would hurt most in a sell-off.
          </p>
        </div>

        {/* HERO: per-position component VaR table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[104px_1fr_72px_84px_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Holding</SectionLabel>
            <SectionLabel>Share of total tail risk</SectionLabel>
            <SectionLabel right>Marg. VaR</SectionLabel>
            <SectionLabel right>Comp. VaR</SectionLabel>
            <SectionLabel right>β-port</SectionLabel>
          </div>

          <div className="flex flex-col">
            {positions.map((p, i) => (
              <VarRow key={p.symbol} row={p} maxPct={maxPct} rank={i + 1} />
            ))}
          </div>

          {/* Reconciliation footer line — derive the % from the rows actually
              shown so the displayed reconciliation can never contradict them. */}
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-terminal-divider text-2xs">
            <span className="text-terminal-muted uppercase tracking-wider">
              Σ component VaR reconciles to total
            </span>
            <span className="font-mono tabular-nums text-terminal-text">
              {fmtUsd(componentSum)} / {fmtUsd(total_var95)}
              <span className={`ml-1.5 ${reconcilesPct >= 99 ? "text-accent-green" : "text-accent-amber"}`}>
                ({reconcilesPct.toFixed(1)}%)
              </span>
            </span>
          </div>
        </div>

        {/* Footer explainer */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="Tail driver" />
            <LegendSwatch color="#c9a24a" label="Moderate" />
            <LegendSwatch color="#8a8175" label="Diversifier" />
          </div>
          <span className="uppercase tracking-wider">
            Marginal VaR = ∂VaR/∂weight · Component VaR = weight × marginal (Euler-additive)
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function VarRow({ row, maxPct, rank }: { row: VarPosition; maxPct: number; rank: number }) {
  const color = riskColor(row.pct_of_var);
  const pct = Math.max(2, Math.min(100, (Math.abs(row.pct_of_var) / maxPct) * 100));
  return (
    <div className="grid grid-cols-[104px_1fr_72px_84px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Holding + weight */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.symbol}</span>
        <span className="text-2xs text-terminal-dim truncate">{row.weight.toFixed(1)}%</span>
      </div>

      {/* Risk-share bar + standalone vol caption */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-2xs text-terminal-muted truncate">
          <span className="font-mono tabular-nums" style={{ color }}>
            {row.pct_of_var.toFixed(1)}%
          </span>
          <span className="text-terminal-dim"> of VaR · standalone vol {row.standalone_vol.toFixed(0)}%</span>
        </span>
      </div>

      {/* Marginal VaR */}
      <div className="text-right font-mono tabular-nums text-xs text-terminal-muted">
        {row.marginal_var.toFixed(4)}
      </div>

      {/* Component VaR ($ + %) */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className="text-terminal-text">{fmtUsd(row.component_var)}</span>
        <div className="text-2xs font-semibold" style={{ color }}>{row.pct_of_var.toFixed(1)}%</div>
      </div>

      {/* Beta to portfolio */}
      <div className="text-right font-mono tabular-nums text-xs">
        <span className={row.beta_to_port >= 1 ? "text-accent-amber" : "text-terminal-muted"}>
          {row.beta_to_port.toFixed(2)}
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
