import { useEffect, useMemo, useState } from "react";

import { portfolioApi } from "../../api/client";
import type { PortfolioPosition, PortfolioSummary } from "../../api/types";

interface Props {
  portfolioId: number;
  onAddTrade: (symbol: string) => void;
}

type SortKey = keyof PortfolioPosition | "day_change_pct" | "unrealized_pl_pct" | "portfolio_weight";
type SortDir = "asc" | "desc";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 2) {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollar(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtChange(v: number | null | undefined) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPl(v: number | null | undefined) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plColor(v: number | null | undefined) {
  if (v == null) return "text-terminal-fg";
  return v >= 0 ? "text-green-400" : "text-red-400";
}

function fmtLargeNum(v: number | null | undefined) {
  if (v == null) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9)  return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6)  return `${(v / 1e6).toFixed(1)}M`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      {Array.from({ length: 17 }).map((_, i) => (
        <td key={i} className="px-2 py-1.5">
          <div className="h-3 bg-terminal-border/40 rounded w-full" />
        </td>
      ))}
    </tr>
  );
}

// ── Column header ─────────────────────────────────────────────────────────────

function Th({
  label,
  sortKey,
  currentSort,
  dir,
  onSort,
  right,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  right?: boolean;
}) {
  const active = currentSort === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-2 py-1.5 text-2xs uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${
        right ? "text-right" : "text-left"
      } ${active ? "text-accent" : "text-terminal-dim"} hover:text-terminal-fg`}
    >
      {label}
      {active && <span className="ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>}
    </th>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PortfolioPositionsTab({ portfolioId, onAddTrade }: Props) {
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("market_value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    setLoading(true);
    setErr(null);
    portfolioApi
      .positions(portfolioId)
      .then(({ positions: pos, summary: sum }) => {
        setPositions(pos);
        setSummary(sum);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  }, [portfolioId]);

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const sorted = useMemo(() => {
    return [...positions].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortKey as string];
      const bv = (b as unknown as Record<string, unknown>)[sortKey as string];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [positions, sortKey, sortDir]);

  if (err) {
    return <div className="p-4 text-xs text-red-400">{err}</div>;
  }

  const thProps = { currentSort: sortKey, dir: sortDir, onSort: handleSort };

  return (
    <div className="overflow-auto flex-1 min-h-0">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
          <tr>
            <Th label="Symbol" sortKey="symbol" {...thProps} />
            <Th label="Name" sortKey="name" {...thProps} />
            <Th label="Sector" sortKey="sector" {...thProps} />
            <Th label="Shares" sortKey="shares" {...thProps} right />
            <Th label="Avg Cost" sortKey="avg_cost" {...thProps} right />
            <Th label="Price" sortKey="current_price" {...thProps} right />
            <Th label="Day Chg" sortKey="day_change" {...thProps} right />
            <Th label="Day %" sortKey="day_change_pct" {...thProps} right />
            <Th label="Mkt Value" sortKey="market_value" {...thProps} right />
            <Th label="Unreal P&L" sortKey="unrealized_pl" {...thProps} right />
            <Th label="P&L %" sortKey="unrealized_pl_pct" {...thProps} right />
            <Th label="Port %" sortKey="portfolio_weight" {...thProps} right />
            <Th label="52w Hi" sortKey={"52w_high" as SortKey} {...thProps} right />
            <Th label="% Hi" sortKey="pct_from_52w_high" {...thProps} right />
            <Th label="Beta" sortKey="beta" {...thProps} right />
            <Th label="YTD %" sortKey="ytd_return_pct" {...thProps} right />
            <Th label="Div Yld" sortKey="dividend_yield" {...thProps} right />
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
            : sorted.map((p) => (
                <tr
                  key={p.symbol}
                  className="border-b border-terminal-border/30 hover:bg-terminal-border/10 transition-colors"
                >
                  <td className="px-2 py-1.5 font-mono text-accent font-semibold whitespace-nowrap">
                    {p.symbol}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-fg truncate max-w-[140px]" title={p.name}>
                    {p.name}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-dim truncate max-w-[100px]" title={p.sector ?? ""}>
                    {p.sector ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(p.shares, 4)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtDollar(p.avg_cost)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtDollar(p.current_price)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.day_change)}`}>
                    {fmtPl(p.day_change)}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.day_change_pct)}`}>
                    {fmtChange(p.day_change_pct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {`$${p.market_value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.unrealized_pl)}`}>
                    {fmtPl(p.unrealized_pl)}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.unrealized_pl_pct)}`}>
                    {fmtChange(p.unrealized_pl_pct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">
                    {p.portfolio_weight.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">
                    {fmtDollar(p["52w_high"])}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.pct_from_52w_high ? -p.pct_from_52w_high : null)}`}>
                    {p.pct_from_52w_high != null ? `${p.pct_from_52w_high.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">
                    {fmt(p.beta, 2)}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.ytd_return_pct)}`}>
                    {fmtChange(p.ytd_return_pct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">
                    {p.dividend_yield != null ? `${p.dividend_yield.toFixed(2)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => onAddTrade(p.symbol)}
                      className="pill text-2xs text-accent hover:bg-accent/20 whitespace-nowrap"
                    >
                      + Trade
                    </button>
                  </td>
                </tr>
              ))}

          {/* Cash row */}
          {!loading && summary && summary.cash_balance > 0 && (
            <tr className="border-b border-terminal-border/30 bg-terminal-bg/40">
              <td className="px-2 py-1.5 font-mono text-yellow-400 font-semibold">CASH</td>
              <td className="px-2 py-1.5 text-terminal-dim">Cash Balance</td>
              <td className="px-2 py-1.5" />
              <td className="px-2 py-1.5" />
              <td className="px-2 py-1.5" />
              <td className="px-2 py-1.5 text-right font-mono">
                {`$${summary.cash_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
              </td>
              <td colSpan={5} />
              <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">
                {summary.cash_pct.toFixed(1)}%
              </td>
              <td colSpan={6} />
            </tr>
          )}

          {!loading && positions.length === 0 && (
            <tr>
              <td colSpan={18} className="px-4 py-6 text-center text-terminal-dim text-xs">
                No positions yet. Add a buy transaction to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Summary footer */}
      {!loading && summary && (
        <div className="px-3 py-2 border-t border-terminal-border bg-terminal-bg flex flex-wrap gap-4 text-2xs text-terminal-dim">
          <span>
            Total Value:{" "}
            <span className="text-terminal-fg font-mono">
              ${summary.total_value.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
          </span>
          <span>
            Market Cap:{" "}
            <span className="text-terminal-fg font-mono">
              ${summary.total_market_value.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
          </span>
          <span>
            Day P&L:{" "}
            <span className={`font-mono ${summary.total_day_pl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {summary.total_day_pl >= 0 ? "+" : ""}
              ${Math.abs(summary.total_day_pl).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              {" "}({summary.total_day_pl_pct >= 0 ? "+" : ""}{summary.total_day_pl_pct.toFixed(2)}%)
            </span>
          </span>
          <span>
            Total P&L:{" "}
            <span className={`font-mono ${summary.total_pl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {summary.total_pl >= 0 ? "+" : ""}
              ${Math.abs(summary.total_pl).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              {" "}({summary.total_pl_pct >= 0 ? "+" : ""}{summary.total_pl_pct.toFixed(2)}%)
            </span>
          </span>
          <span className="ml-auto text-terminal-dim">
            {fmtLargeNum(summary.position_count)} positions
          </span>
        </div>
      )}
    </div>
  );
}
