import { useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";

interface DivPosition {
  symbol: string;
  shares: number;
  trailing_12m_div_per_share: number | null;
  dividend_yield_pct: number | null;
  annual_income: number | null;
  next_ex_date: string | null;
  payout_ratio_pct: number | null;
}

interface DivData {
  positions: DivPosition[];
  total_annual_income: number;
  portfolio_yield_pct: number;
  monthly_income: number;
  income_positions_count: number;
}

interface Props {
  portfolioId: number;
}

function fmt2(v: number | null | undefined) {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PortfolioDividendsTab({ portfolioId }: Props) {
  const [data, setData]     = useState<DivData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]       = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    portfolioApi
      .dividends(portfolioId)
      .then((d) => { setData(d as unknown as DivData); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId]);

  if (err) return <div className="p-4 text-xs text-red-400">{err}</div>;

  const incomePositions = (data?.positions ?? [])
    .filter((p) => (p.annual_income ?? 0) > 0)
    .sort((a, b) => (b.annual_income ?? 0) - (a.annual_income ?? 0));

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      {/* Summary cards */}
      <div className="flex gap-3 p-3 border-b border-terminal-border flex-wrap">
        {[
          { label: "Annual Income",    value: data ? `$${fmt2(data.total_annual_income)}` : "—" },
          { label: "Monthly Income",   value: data ? `$${fmt2(data.monthly_income)}` : "—" },
          { label: "Portfolio Yield",  value: data ? `${data.portfolio_yield_pct.toFixed(2)}%` : "—" },
          { label: "Income Positions", value: data ? String(data.income_positions_count) : "—" },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col gap-0.5 bg-terminal-bg border border-terminal-border rounded px-3 py-2 min-w-[120px]"
          >
            <span className="text-2xs uppercase tracking-wide text-terminal-dim">{label}</span>
            <span className="text-sm font-mono text-green-400 font-semibold">{value}</span>
          </div>
        ))}
      </div>

      {/* Dividend table */}
      <div className="overflow-auto flex-1">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
            <tr>
              {["Symbol", "Shares", "Div/Share", "Yield %", "Annual Income", "Next Ex-Date", "Payout Ratio"].map((h) => (
                <th
                  key={h}
                  className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="animate-pulse border-b border-terminal-border/30">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-2 py-1.5">
                        <div className="h-3 bg-terminal-border/40 rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              : incomePositions.map((p) => (
                  <tr key={p.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                    <td className="px-2 py-1.5 font-mono text-accent font-semibold">{p.symbol}</td>
                    <td className="px-2 py-1.5 font-mono text-terminal-fg text-right">
                      {p.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-terminal-fg text-right">
                      {p.trailing_12m_div_per_share != null ? `$${fmt2(p.trailing_12m_div_per_share)}` : "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-green-400 text-right">
                      {p.dividend_yield_pct != null ? `${p.dividend_yield_pct.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-green-400 font-semibold text-right">
                      {p.annual_income != null ? `$${fmt2(p.annual_income)}` : "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-terminal-dim text-right">
                      {p.next_ex_date ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-terminal-dim text-right">
                      {p.payout_ratio_pct != null ? `${p.payout_ratio_pct.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
            {!loading && incomePositions.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-terminal-dim text-xs">
                  No dividend-paying positions in this portfolio.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
