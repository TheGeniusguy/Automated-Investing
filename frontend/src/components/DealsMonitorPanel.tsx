import { useEffect, useMemo, useState } from "react";

// ── Local types (decoupled from api/types.ts on purpose) ──────────────────────

interface Deal {
  acquirer: string;
  acquirer_ticker: string;
  target: string;
  target_ticker: string;
  sector: string;
  deal_value_b: number;
  premium_pct: number;
  consideration: string;
  status: string;
  announce_date: string;
  expected_close: string;
  target_price: number;
  headline: string;
}

interface SectorRollup {
  sector: string;
  count: number;
  value_b: number;
}

interface DealsSummary {
  total_value_b: number;
  deal_count: number;
  count_by_status: Record<string, number>;
  avg_premium_pct: number;
  largest_deal: {
    headline: string | null;
    value_b: number;
    acquirer: string | null;
    target: string | null;
  } | null;
  by_sector: SectorRollup[];
}

interface DealsResponse {
  deals: Deal[];
  summary: DealsSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Local fallback so the panel renders fully populated, even offline ─────────

const FALLBACK: DealsResponse = {
  deals: [
    { acquirer: "Pfizer", acquirer_ticker: "PFE", target: "Arena Oncology", target_ticker: "ARNO", sector: "Health Care", deal_value_b: 14.7, premium_pct: 36.5, consideration: "Cash", status: "Announced", announce_date: "2026-06-25", expected_close: "2027-01-20", target_price: 52.4, headline: "Pfizer to buy Arena Oncology for $14.7B." },
    { acquirer: "Novo Nordisk", acquirer_ticker: "NVO", target: "Cardior Bio", target_ticker: "CRDB", sector: "Health Care", deal_value_b: 11.4, premium_pct: 41.8, consideration: "Cash", status: "Announced", announce_date: "2026-06-24", expected_close: "2026-11-30", target_price: 88.75, headline: "Novo Nordisk buys Cardior Bio for $11.4B." },
    { acquirer: "Caterpillar", acquirer_ticker: "CAT", target: "Komatsu Mining Sys", target_ticker: "KMSY", sector: "Industrials", deal_value_b: 9.3, premium_pct: 22.7, consideration: "Cash", status: "Announced", announce_date: "2026-06-17", expected_close: "2027-02-10", target_price: 0, headline: "Caterpillar to buy Komatsu Mining Systems for $9.3B." },
    { acquirer: "Cisco Systems", acquirer_ticker: "CSCO", target: "Arista Edge", target_ticker: "AEDG", sector: "Technology", deal_value_b: 9.8, premium_pct: 33.1, consideration: "Cash", status: "Announced", announce_date: "2026-06-22", expected_close: "2026-12-05", target_price: 64.2, headline: "Cisco to acquire Arista Edge for $9.8B." },
    { acquirer: "ExxonMobil", acquirer_ticker: "XOM", target: "Permian Basin Resources", target_ticker: "PBR", sector: "Energy", deal_value_b: 28.6, premium_pct: 18.2, consideration: "Stock", status: "Pending", announce_date: "2026-06-19", expected_close: "2027-01-31", target_price: 142.5, headline: "ExxonMobil expands Permian with $28.6B all-stock deal." },
    { acquirer: "Salesforce", acquirer_ticker: "CRM", target: "Informatica", target_ticker: "INFA", sector: "Technology", deal_value_b: 8.0, premium_pct: 30.2, consideration: "Cash", status: "Pending", announce_date: "2026-05-27", expected_close: "2026-11-20", target_price: 25.0, headline: "Salesforce to buy Informatica for $8B." },
    { acquirer: "Synopsys", acquirer_ticker: "SNPS", target: "Ansys", target_ticker: "ANSS", sector: "Technology", deal_value_b: 35.0, premium_pct: 29.4, consideration: "Cash & Stock", status: "Pending", announce_date: "2026-05-28", expected_close: "2026-12-15", target_price: 390.0, headline: "Synopsys to acquire Ansys in $35B tie-up." },
    { acquirer: "Capital One", acquirer_ticker: "COF", target: "Discover Financial", target_ticker: "DFS", sector: "Financials", deal_value_b: 35.3, premium_pct: 26.6, consideration: "Stock", status: "Completed", announce_date: "2026-02-14", expected_close: "2026-05-20", target_price: 142.2, headline: "Capital One closes $35.3B Discover acquisition." },
    { acquirer: "Adobe", acquirer_ticker: "ADBE", target: "Figma", target_ticker: "FIGM", sector: "Technology", deal_value_b: 20.0, premium_pct: 0, consideration: "Cash & Stock", status: "Terminated", announce_date: "2026-01-05", expected_close: "2026-07-01", target_price: 0, headline: "Adobe-Figma $20B merger terminated on regulatory pushback." },
  ],
  summary: {
    total_value_b: 161.1,
    deal_count: 9,
    count_by_status: { Announced: 4, Pending: 3, Completed: 1, Terminated: 1 },
    avg_premium_pct: 27.6,
    largest_deal: { headline: "Capital One closes $35.3B Discover acquisition.", value_b: 35.3, acquirer: "Capital One", target: "Discover Financial" },
    by_sector: [
      { sector: "Technology", count: 4, value_b: 72.8 },
      { sector: "Financials", count: 1, value_b: 35.3 },
      { sector: "Energy", count: 1, value_b: 28.6 },
      { sector: "Health Care", count: 2, value_b: 26.1 },
      { sector: "Industrials", count: 1, value_b: 9.3 },
    ],
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtValB(v: number): string {
  if (v == null) return "--";
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}T`;
  return `$${v.toFixed(1)}B`;
}

function fmtPremium(v: number): string {
  if (!v) return "--";
  return `+${v.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  if (!iso) return "--";
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = parseInt(m, 10) - 1;
  if (Number.isNaN(mi) || mi < 0 || mi > 11) return iso;
  return `${months[mi]} ${parseInt(d, 10)}, ${y.slice(2)}`;
}

function statusPill(status: string): string {
  switch (status) {
    case "Completed":
      return "bg-accent-green/15 text-accent-green";
    case "Pending":
      return "bg-accent-amber/15 text-accent-amber";
    case "Announced":
      return "bg-accent-blue/15 text-accent-blue";
    case "Terminated":
      return "bg-accent-red/15 text-accent-red";
    default:
      return "bg-terminal-divider text-terminal-muted";
  }
}

function considerationColor(c: string): string {
  if (c === "Cash") return "text-accent-green";
  if (c === "Stock") return "text-accent-blue";
  return "text-accent-amber";
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function DealsMonitorPanel() {
  const [data, setData] = useState<DealsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("All");

  useEffect(() => {
    let alive = true;
    fetch("/api/deals")
      .then((res) => res.json())
      .then((json: DealsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.deals) && json.deals.length > 0) {
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

  const { deals, summary } = data;

  const statuses = useMemo(() => {
    const set = new Set<string>();
    deals.forEach((d) => set.add(d.status));
    return ["All", ...Array.from(set)];
  }, [deals]);

  const visibleDeals = useMemo(
    () => (statusFilter === "All" ? deals : deals.filter((d) => d.status === statusFilter)),
    [deals, statusFilter],
  );

  const maxSectorValue = useMemo(
    () => Math.max(1, ...summary.by_sector.map((s) => s.value_b)),
    [summary],
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>M&amp;A / Deals Monitor</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi label="Total Deal Value" value={fmtValB(summary.total_value_b)} accent="text-accent-amber" />
          <Kpi label="Deals Tracked" value={String(summary.deal_count)} accent="text-terminal-text" />
          <Kpi label="Avg Premium" value={`+${summary.avg_premium_pct.toFixed(1)}%`} accent="text-accent-green" />
          <Kpi
            label="Largest Deal"
            value={summary.largest_deal ? fmtValB(summary.largest_deal.value_b) : "--"}
            sub={summary.largest_deal ? `${summary.largest_deal.acquirer} / ${summary.largest_deal.target}` : undefined}
            accent="text-accent-blue"
          />
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-2xs text-terminal-dim uppercase mr-1 tracking-wider">Status:</span>
          {statuses.map((s) => {
            const n = s === "All" ? deals.length : summary.count_by_status[s] ?? 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`pill ${
                  statusFilter === s
                    ? "bg-accent text-terminal-bg"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {s} {n}
              </button>
            );
          })}
        </div>

        {/* Deals table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                <th className="text-left py-1.5 px-2 font-medium">Target</th>
                <th className="text-left py-1.5 px-2 font-medium">Acquirer</th>
                <th className="text-left py-1.5 px-2 font-medium">Sector</th>
                <th className="text-right py-1.5 px-2 font-medium">Value</th>
                <th className="text-right py-1.5 px-2 font-medium">Premium</th>
                <th className="text-left py-1.5 px-2 font-medium">Terms</th>
                <th className="text-left py-1.5 px-2 font-medium">Status</th>
                <th className="text-right py-1.5 px-2 font-medium">Announced</th>
                <th className="text-right py-1.5 px-2 font-medium">Exp. Close</th>
              </tr>
            </thead>
            <tbody>
              {visibleDeals.map((d, i) => (
                <tr
                  key={`${d.target_ticker}-${i}`}
                  className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                  title={d.headline}
                >
                  <td className="py-1.5 px-2">
                    <div className="text-terminal-text font-medium leading-tight">{d.target}</div>
                    <div className="font-mono text-2xs text-terminal-dim">{d.target_ticker}</div>
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="text-terminal-muted leading-tight">{d.acquirer}</div>
                    <div className="font-mono text-2xs text-terminal-dim">{d.acquirer_ticker}</div>
                  </td>
                  <td className="py-1.5 px-2 text-terminal-muted whitespace-nowrap">{d.sector}</td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">
                    {fmtValB(d.deal_value_b)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-green">
                    {fmtPremium(d.premium_pct)}
                  </td>
                  <td className={`py-1.5 px-2 whitespace-nowrap ${considerationColor(d.consideration)}`}>
                    {d.consideration}
                  </td>
                  <td className="py-1.5 px-2">
                    <span className={`pill ${statusPill(d.status)}`}>{d.status}</span>
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">
                    {fmtDate(d.announce_date)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim whitespace-nowrap">
                    {fmtDate(d.expected_close)}
                  </td>
                </tr>
              ))}
              {visibleDeals.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-4 text-center text-terminal-dim text-2xs">
                    No deals match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* By-sector mini breakdown */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
            Deal Value by Sector
          </div>
          <div className="flex flex-col gap-1.5">
            {summary.by_sector.map((s) => (
              <div key={s.sector} className="flex items-center gap-2">
                <span className="text-2xs text-terminal-muted w-36 truncate">{s.sector}</span>
                <div className="flex-1 h-3 bg-terminal-panel rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-accent/70 rounded-sm"
                    style={{ width: `${(s.value_b / maxSectorValue) * 100}%` }}
                  />
                </div>
                <span className="text-2xs font-mono tabular-nums text-terminal-dim w-8 text-right">
                  {s.count}
                </span>
                <span className="text-2xs font-mono tabular-nums text-terminal-text w-16 text-right">
                  {fmtValB(s.value_b)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <LegendDot cls="bg-accent-green" label="Completed" />
            <LegendDot cls="bg-accent-amber" label="Pending" />
            <LegendDot cls="bg-accent-blue" label="Announced" />
            <LegendDot cls="bg-accent-red" label="Terminated" />
          </div>
          <span className="text-terminal-dim">
            Illustrative market-wide M&amp;A feed. Premiums shown to undisturbed price.
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-xl tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-2xs text-terminal-dim truncate" title={sub}>{sub}</div>}
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-2 h-2 rounded-sm inline-block ${cls}`} />
      {label}
    </span>
  );
}
