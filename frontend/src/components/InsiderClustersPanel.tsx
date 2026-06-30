import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// Insider Cluster-Buy Signal (Bloomberg INSI). Flags names where MULTIPLE insiders
// bought on the open market inside a short window, scored by buyer count + aggregate
// dollars + role weight. Fetches /api/insider-clusters. Local types on purpose.

interface ClusterBuyer {
  name: string;
  role: string;
  date: string | null;
  value: number;
}

interface InsiderCluster {
  symbol: string;
  company?: string | null;
  buyer_count: number;
  distinct_roles: number;
  total_dollar_value: number;
  first_date: string | null;
  last_date: string | null;
  conviction_score: number;
  signal: string;
  buyers: ClusterBuyer[];
}

interface ClusterSummary {
  cluster_count: number;
  total_buyers: number;
  total_dollar_value: number;
  strongest: {
    symbol: string;
    buyer_count: number;
    total_dollar_value: number;
    conviction_score: number;
  } | null;
}

interface ClustersResponse {
  clusters: InsiderCluster[];
  summary: ClusterSummary;
  window_days: number;
  min_buyers: number;
  data_mode: string;
  as_of: string;
  source: string;
}

// Deterministic local fallback so the panel renders fully populated even offline.
// Mirrors the backend sample board shape (conviction pre-computed, buy-side only).
const FALLBACK: ClustersResponse = (() => {
  const mk = (
    symbol: string,
    company: string,
    score: number,
    buyers: ClusterBuyer[]
  ): InsiderCluster => {
    const total = buyers.reduce((s, b) => s + b.value, 0);
    const dates = buyers.map((b) => b.date).filter(Boolean).sort() as string[];
    return {
      symbol,
      company,
      buyer_count: buyers.length,
      distinct_roles: new Set(buyers.map((b) => b.role)).size,
      total_dollar_value: total,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      conviction_score: score,
      signal: score >= 75 ? "high_conviction" : score >= 55 ? "strong" : "notable",
      buyers: [...buyers].sort((a, b) => b.value - a.value),
    };
  };

  const clusters = [
    mk("CRGY", "Crescent Energy", 84.6, [
      { name: "John C. Goff", role: "Chairman", date: "", value: 2_350_000 },
      { name: "David C. Rockecharlie", role: "CEO", date: "", value: 1_480_000 },
      { name: "Brandi Kendall", role: "CFO", date: "", value: 612_000 },
      { name: "Andrew L. Cozby", role: "Director", date: "", value: 188_000 },
    ]),
    mk("AVAV", "AeroVironment", 71.2, [
      { name: "Wahid Nawabi", role: "Chairman & CEO", date: "", value: 1_120_000 },
      { name: "Kevin P. McDonnell", role: "CFO", date: "", value: 305_000 },
      { name: "Catharine Merigold", role: "Director", date: "", value: 142_000 },
    ]),
    mk("BKU", "BankUnited", 68.4, [
      { name: "Rajinder P. Singh", role: "Chairman & CEO", date: "", value: 1_050_000 },
      { name: "Leslie N. Lunak", role: "CFO", date: "", value: 222_000 },
      { name: "Lynne Patterson", role: "Director", date: "", value: 88_000 },
    ]),
    mk("MGEE", "MGE Energy", 66.1, [
      { name: "Jeffrey M. Keebler", role: "President & CEO", date: "", value: 845_000 },
      { name: "Charles Schrock", role: "Director", date: "", value: 410_000 },
      { name: "Lynn K. Hobbie", role: "EVP", date: "", value: 226_000 },
    ]),
  ];

  const top = clusters[0];
  return {
    clusters,
    summary: {
      cluster_count: clusters.length,
      total_buyers: clusters.reduce((s, c) => s + c.buyer_count, 0),
      total_dollar_value: clusters.reduce((s, c) => s + c.total_dollar_value, 0),
      strongest: {
        symbol: top.symbol,
        buyer_count: top.buyer_count,
        total_dollar_value: top.total_dollar_value,
        conviction_score: top.conviction_score,
      },
    },
    window_days: 30,
    min_buyers: 2,
    data_mode: "sample",
    as_of: "",
    source: "sample",
  };
})();

// Formatting helpers.
function fmtDollars(v: number): string {
  if (!v) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDate(s: string | null): string {
  if (!s) return "--";
  const d = new Date(s + (s.length <= 10 ? "T00:00:00Z" : ""));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function dateWindow(first: string | null, last: string | null): string {
  if (!first && !last) return "--";
  if (first === last || !last) return fmtDate(first);
  return `${fmtDate(first)} – ${fmtDate(last)}`;
}

// Conviction is a buy signal: hotter = greener / brighter. Scale alpha with score.
function convictionStyle(score: number): CSSProperties {
  const t = Math.max(0, Math.min(1, score / 100));
  const alpha = (0.12 + t * 0.55).toFixed(3);
  return {
    backgroundColor: `rgba(91,185,127,${alpha})`, // accent-green
    color: t > 0.5 ? "#0f1310" : "#9fb8a6",
  };
}

const SIGNAL_LABEL: Record<string, string> = {
  high_conviction: "HIGH CONVICTION",
  strong: "STRONG",
  notable: "NOTABLE",
  emerging: "EMERGING",
};

export function InsiderClustersPanel() {
  const [data, setData] = useState<ClustersResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/insider-clusters")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: ClustersResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.clusters) && json.clusters.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        // Keep the FALLBACK board on screen; note the error quietly.
        setError(e instanceof Error ? e.message : "fetch failed");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const { clusters, summary } = data;
  const topCluster = clusters[0];

  // Auto-expand the strongest cluster so individual buyers are visible by default.
  const openSymbol = expanded ?? topCluster?.symbol ?? null;

  const readLine = useMemo(() => {
    if (!topCluster) return "No insider clusters in the current window.";
    const roles = topCluster.distinct_roles > 1 ? `${topCluster.distinct_roles} roles` : "single role";
    return `Strongest cluster buy: ${topCluster.buyer_count} insiders (${roles}) bought ${topCluster.symbol} for ${fmtDollars(
      topCluster.total_dollar_value
    )} — conviction ${topCluster.conviction_score.toFixed(0)}/100.`;
  }, [topCluster]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>INSIDER CLUSTER BUYS</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Active Clusters">
            <span className="stat-figure text-2xl text-accent-green leading-none">
              {summary.cluster_count}
            </span>
            <span className="text-2xs text-terminal-dim">{`>=${data.min_buyers} buyers / ${data.window_days}d`}</span>
          </KpiCell>
          <KpiCell label="Insiders Buying">
            <span className="stat-figure text-2xl text-terminal-text leading-none">
              {summary.total_buyers}
            </span>
            <span className="text-2xs text-terminal-dim">across all clusters</span>
          </KpiCell>
          <KpiCell label="Total Committed">
            <span className="stat-figure text-2xl text-accent-green leading-none truncate">
              {fmtDollars(summary.total_dollar_value)}
            </span>
            <span className="text-2xs text-terminal-dim">open-market buys</span>
          </KpiCell>
        </div>

        {/* Strongest-cluster read line */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">{readLine}</p>
        </div>

        {/* Ranked cluster table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          <div
            className="grid items-end gap-2 pb-1.5 mb-1 border-b border-terminal-divider"
            style={{ gridTemplateColumns: "minmax(96px,1.4fr) 52px 84px 92px minmax(96px,1fr) 56px" }}
          >
            <ColLabel>Symbol</ColLabel>
            <ColLabel right>Buyers</ColLabel>
            <ColLabel right>Total $</ColLabel>
            <ColLabel right>Window</ColLabel>
            <ColLabel>Signal</ColLabel>
            <ColLabel right>Score</ColLabel>
          </div>

          <div className="flex flex-col">
            {clusters.map((c) => {
              const isOpen = c.symbol === openSymbol;
              return (
                <div key={c.symbol} className="border-b border-terminal-divider/40 last:border-0">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? "" : c.symbol)}
                    className="w-full grid items-center gap-2 py-1.5 text-left hover:bg-terminal-border/20 rounded"
                    style={{ gridTemplateColumns: "minmax(96px,1.4fr) 52px 84px 92px minmax(96px,1fr) 56px" }}
                  >
                    {/* Symbol + company */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-terminal-dim text-2xs w-2 shrink-0">{isOpen ? "▾" : "▸"}</span>
                      <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">
                        {c.symbol}
                      </span>
                      <span className="text-2xs text-terminal-dim truncate">{c.company ?? ""}</span>
                    </div>
                    {/* Buyer count */}
                    <div className="text-right font-mono tabular-nums text-xs text-accent-green">
                      {c.buyer_count}
                    </div>
                    {/* Total dollars */}
                    <div className="text-right font-mono tabular-nums text-xs text-terminal-text">
                      {fmtDollars(c.total_dollar_value)}
                    </div>
                    {/* Date window */}
                    <div className="text-right font-mono tabular-nums text-2xs text-terminal-dim">
                      {dateWindow(c.first_date, c.last_date)}
                    </div>
                    {/* Signal */}
                    <div className="min-w-0">
                      <span className="text-2xs uppercase tracking-wider text-terminal-muted truncate">
                        {SIGNAL_LABEL[c.signal] ?? c.signal}
                      </span>
                    </div>
                    {/* Conviction score chip */}
                    <div className="flex justify-end">
                      <span
                        className="font-mono tabular-nums text-xs font-semibold rounded px-1.5 py-0.5"
                        style={convictionStyle(c.conviction_score)}
                      >
                        {c.conviction_score.toFixed(0)}
                      </span>
                    </div>
                  </button>

                  {/* Expanded buyer detail */}
                  {isOpen && (
                    <div className="pb-2 pl-5 pr-1 flex flex-col gap-0.5">
                      {c.buyers.map((b, i) => (
                        <div
                          key={`${b.name}-${i}`}
                          className="grid items-center gap-2 py-0.5"
                          style={{ gridTemplateColumns: "1.6fr 1fr 64px 84px" }}
                        >
                          <span className="text-2xs text-terminal-text truncate">{b.name}</span>
                          <span className="text-2xs text-terminal-dim truncate">{b.role}</span>
                          <span className="text-2xs font-mono tabular-nums text-terminal-dim text-right">
                            {fmtDate(b.date)}
                          </span>
                          <span className="text-2xs font-mono tabular-nums text-accent-green text-right">
                            {fmtDollars(b.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <span className="uppercase tracking-wider">
            Conviction = buyers + aggregate $ + role weight
          </span>
          {error ? (
            <span className="text-terminal-muted normal-case tracking-normal">offline board</span>
          ) : (
            <span className="uppercase tracking-wider">Open-market buys (Form 4 code P)</span>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex flex-col gap-0.5 min-w-0">{children}</div>
    </div>
  );
}

function ColLabel({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <div className={`text-2xs text-terminal-muted uppercase tracking-wider ${right ? "text-right" : ""}`}>
      {children}
    </div>
  );
}
