import { useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";
import type {
  PortfolioAllocation,
  PortfolioMetrics,
  PortfolioPosition,
  PortfolioSummary,
} from "../../api/types";

interface Props {
  portfolioId: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 2, prefix = "") {
  if (v == null) return "—";
  return `${prefix}${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPct(v: number | null | undefined, decimals = 2) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;
}

function fmtDollar(v: number | null | undefined) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plColor(v: number | null | undefined): string {
  if (v == null) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

// ── sub-components ────────────────────────────────────────────────────────────

// Featured hero figure: large editorial serif so the headline number reads as a
// confident metric, with an optional signed sub-figure (the matching percent).
function HeroStat({
  label,
  value,
  sub,
  color,
  subColor,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  subColor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 bg-terminal-bg/40 border border-terminal-border rounded-panel px-5 py-4 min-w-[180px]">
      <span className="text-2xs text-terminal-dim uppercase tracking-[0.14em]">{label}</span>
      <span className={`stat-figure text-3xl leading-none ${color ?? "text-terminal-text"}`}>
        {value}
      </span>
      {sub && (
        <span className={`stat-figure text-sm leading-none ${subColor ?? "text-terminal-muted"}`}>
          {sub}
        </span>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-terminal-bg/40 border border-terminal-border rounded-panel px-3 py-2.5 min-w-[120px]">
      <span className="text-2xs text-terminal-dim uppercase tracking-wide">{label}</span>
      <span className={`stat-figure text-base ${color ?? "text-terminal-text"}`}>
        {value}
      </span>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-terminal-bg/40 border border-terminal-border rounded-panel px-3 py-2.5 min-w-[100px]">
      <span className="text-2xs text-terminal-dim uppercase tracking-wide">{label}</span>
      <span className={`stat-figure text-sm ${color ?? "text-terminal-text"}`}>
        {value}
      </span>
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

export function PortfolioOverviewTab({ portfolioId }: Props) {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null);
  const [allocation, setAllocation] = useState<PortfolioAllocation | null>(null);
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    Promise.all([
      portfolioApi.overview(portfolioId),
      portfolioApi.allocation(portfolioId),
      portfolioApi.positions(portfolioId),
    ])
      .then(([ov, alloc, pos]) => {
        const ovObj = ov as { summary?: PortfolioSummary; metrics?: PortfolioMetrics };
        setSummary(ovObj.summary ?? null);
        setMetrics(ovObj.metrics ?? null);
        setAllocation(alloc);
        setPositions(pos.positions ?? []);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  }, [portfolioId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-terminal-dim text-xs">
        Loading overview...
      </div>
    );
  }

  if (err) {
    return <div className="p-4 text-xs text-accent-red">{err}</div>;
  }

  // Sort positions for top/bottom 5 by day P&L
  const sorted = [...positions].sort((a, b) => (b.day_pl ?? 0) - (a.day_pl ?? 0));
  const top5 = sorted.slice(0, 5);
  const bottom5 = [...sorted].reverse().slice(0, 5);

  // Max sector weight for bar scaling
  const maxSectorWeight =
    allocation && allocation.sectors.length > 0
      ? Math.max(...allocation.sectors.map((s) => s.weight_pct), allocation.cash_pct)
      : 100;

  return (
    <div className="overflow-auto p-4 space-y-5">
      {/* Row 1 — P&L summary */}
      {summary && (
        <div className="space-y-3">
          {/* Hero figures — value + headline P&L */}
          <div className="flex flex-wrap gap-3">
            <HeroStat
              label="Total Value"
              value={`$${summary.total_value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
            />
            <HeroStat
              label="Day P&L"
              value={fmtDollar(summary.total_day_pl)}
              color={plColor(summary.total_day_pl)}
              sub={fmtPct(summary.total_day_pl_pct)}
              subColor={plColor(summary.total_day_pl_pct)}
            />
            <HeroStat
              label="Total P&L"
              value={fmtDollar(summary.total_pl)}
              color={plColor(summary.total_pl)}
              sub={fmtPct(summary.total_pl_pct)}
              subColor={plColor(summary.total_pl_pct)}
            />
          </div>
          {/* Secondary figures */}
          <div className="flex flex-wrap gap-2">
            <StatCard
              label="Unrealized P&L"
              value={fmtDollar(summary.total_unrealized_pl)}
              color={plColor(summary.total_unrealized_pl)}
            />
            <StatCard
              label="Realized P&L"
              value={fmtDollar(summary.total_realized_pl)}
              color={plColor(summary.total_realized_pl)}
            />
            <StatCard
              label="Cash"
              value={`$${summary.cash_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
            />
            <StatCard label="Cash %" value={`${summary.cash_pct.toFixed(1)}%`} />
            <StatCard label="Positions" value={String(summary.position_count)} />
          </div>
        </div>
      )}

      {/* Row 2 — Risk metrics */}
      {metrics && (
        <div>
          <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1.5">
            Risk Metrics
          </div>
          <div className="flex flex-wrap gap-2">
            <MetricCard label="Sharpe" value={fmt(metrics.sharpe, 2)} color={plColor(metrics.sharpe)} />
            <MetricCard label="Sortino" value={fmt(metrics.sortino, 2)} color={plColor(metrics.sortino)} />
            <MetricCard label="Alpha" value={fmtPct(metrics.alpha_pct)} color={plColor(metrics.alpha_pct)} />
            <MetricCard label="Beta" value={fmt(metrics.beta, 2)} />
            <MetricCard
              label="Max Drawdown"
              value={fmtPct(metrics.max_drawdown_pct)}
              color={metrics.max_drawdown_pct != null ? "text-accent-red" : "text-terminal-dim"}
            />
            <MetricCard
              label="Ann Return"
              value={fmtPct(metrics.ann_return_pct)}
              color={plColor(metrics.ann_return_pct)}
            />
            <MetricCard label="Volatility" value={fmtPct(metrics.ann_volatility_pct)} />
            <MetricCard label="Calmar" value={fmt(metrics.calmar, 2)} color={plColor(metrics.calmar)} />
            <MetricCard label="TWR" value={fmtPct(metrics.twr_pct)} color={plColor(metrics.twr_pct)} />
            <MetricCard label="MWR" value={fmtPct(metrics.mwr_pct)} color={plColor(metrics.mwr_pct)} />
            <MetricCard label="Win Rate" value={fmtPct(metrics.win_rate_pct)} />
            <MetricCard label="R Squared" value={fmt(metrics.r_squared, 3)} />
          </div>
        </div>
      )}

      {/* Row 3 — Sector allocation + top/bottom 5 */}
      <div className="flex gap-4 flex-wrap">
        {/* Sector bars */}
        {allocation && (
          <div className="flex-1 min-w-[220px]">
            <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1.5">
              Sector Allocation
            </div>
            <div className="space-y-1.5">
              {allocation.sectors.map((s) => (
                <div key={s.sector} className="flex items-center gap-2">
                  <span className="text-2xs text-terminal-dim w-28 truncate" title={s.sector}>
                    {s.sector}
                  </span>
                  <div className="flex-1 bg-terminal-border/40 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-accent/70 rounded-full"
                      style={{ width: `${(s.weight_pct / maxSectorWeight) * 100}%` }}
                    />
                  </div>
                  <span className="text-2xs text-terminal-text w-10 text-right font-mono tabular-nums">
                    {s.weight_pct.toFixed(1)}%
                  </span>
                </div>
              ))}
              {/* Cash row */}
              {allocation.cash_pct > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-terminal-dim w-28">Cash</span>
                  <div className="flex-1 bg-terminal-border/40 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-accent-blue/60 rounded-full"
                      style={{ width: `${(allocation.cash_pct / maxSectorWeight) * 100}%` }}
                    />
                  </div>
                  <span className="text-2xs text-terminal-text w-10 text-right font-mono tabular-nums">
                    {allocation.cash_pct.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Top 5 */}
        {top5.length > 0 && (
          <div className="flex-1 min-w-[180px]">
            <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1.5">
              Top 5 Today
            </div>
            <div className="space-y-1">
              {top5.map((p) => (
                <div key={p.symbol} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-accent w-16">{p.symbol}</span>
                  <span className={`text-xs font-mono tabular-nums ${plColor(p.day_pl)}`}>
                    {fmtDollar(p.day_pl)}
                  </span>
                  <span className={`text-2xs font-mono tabular-nums ${plColor(p.day_change_pct)}`}>
                    {fmtPct(p.day_change_pct)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bottom 5 */}
        {bottom5.length > 0 && (
          <div className="flex-1 min-w-[180px]">
            <div className="text-2xs text-terminal-dim uppercase tracking-wide mb-1.5">
              Bottom 5 Today
            </div>
            <div className="space-y-1">
              {bottom5.map((p) => (
                <div key={p.symbol} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-accent w-16">{p.symbol}</span>
                  <span className={`text-xs font-mono tabular-nums ${plColor(p.day_pl)}`}>
                    {fmtDollar(p.day_pl)}
                  </span>
                  <span className={`text-2xs font-mono tabular-nums ${plColor(p.day_change_pct)}`}>
                    {fmtPct(p.day_change_pct)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
