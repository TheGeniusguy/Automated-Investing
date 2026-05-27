import { useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";

interface FundRow {
  pe_ttm: number | null;
  forward_pe: number | null;
  ps_ttm: number | null;
  pb: number | null;
  ev_ebitda: number | null;
  revenue_growth_yoy: number | null;
  earnings_growth_yoy: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  net_margin: number | null;
  fcf_yield: number | null;
  debt_to_equity: number | null;
  return_on_equity: number | null;
  peg_ratio: number | null;
  eps_ttm: number | null;
  short_pct_float: number | null;
}

interface Props {
  portfolioId: number;
}

function fmt(v: number | null | undefined, dec = 2, suffix = "") {
  if (v == null) return "—";
  return `${v.toFixed(dec)}${suffix}`;
}

function growthColor(v: number | null | undefined) {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-green-400" : "text-red-400";
}

function marginColor(v: number | null | undefined) {
  if (v == null) return "text-terminal-dim";
  if (v >= 20) return "text-green-400";
  if (v < 5)  return "text-red-400";
  return "text-terminal-fg";
}

interface Col {
  label: string;
  key: keyof FundRow;
  format: (v: number | null | undefined) => string;
  color?: (v: number | null | undefined) => string;
}

const COLS: Col[] = [
  { label: "PE (TTM)",    key: "pe_ttm",             format: (v) => fmt(v, 1) },
  { label: "Fwd PE",      key: "forward_pe",          format: (v) => fmt(v, 1) },
  { label: "P/S",         key: "ps_ttm",              format: (v) => fmt(v, 1) },
  { label: "P/B",         key: "pb",                  format: (v) => fmt(v, 2) },
  { label: "EV/EBITDA",   key: "ev_ebitda",           format: (v) => fmt(v, 1) },
  { label: "Rev Grw YoY", key: "revenue_growth_yoy",  format: (v) => fmt(v, 1, "%"), color: growthColor },
  { label: "EPS Grw YoY", key: "earnings_growth_yoy", format: (v) => fmt(v, 1, "%"), color: growthColor },
  { label: "Gross Mgn",   key: "gross_margin",        format: (v) => fmt(v, 1, "%"), color: marginColor },
  { label: "Op Mgn",      key: "operating_margin",    format: (v) => fmt(v, 1, "%"), color: marginColor },
  { label: "Net Mgn",     key: "net_margin",           format: (v) => fmt(v, 1, "%"), color: marginColor },
  { label: "FCF Yield",   key: "fcf_yield",            format: (v) => fmt(v, 1, "%"), color: growthColor },
  { label: "D/E",         key: "debt_to_equity",       format: (v) => fmt(v, 2) },
  { label: "ROE",         key: "return_on_equity",     format: (v) => fmt(v, 1, "%"), color: growthColor },
  { label: "PEG",         key: "peg_ratio",            format: (v) => fmt(v, 2) },
  { label: "EPS (TTM)",   key: "eps_ttm",              format: (v) => fmt(v, 2) },
  { label: "Short Float", key: "short_pct_float",      format: (v) => fmt(v, 1, "%") },
];

export function PortfolioFundamentalsTab({ portfolioId }: Props) {
  const [data, setData] = useState<{ fundamentals: Record<string, FundRow>; symbols: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    portfolioApi
      .fundamentals(portfolioId)
      .then((d) => { setData(d as typeof data); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId]);

  if (err) return <div className="p-4 text-xs text-red-400">{err}</div>;

  const symbols = data?.symbols ?? [];
  const funds   = data?.fundamentals ?? {};

  return (
    <div className="overflow-auto flex-1 min-h-0">
      <table className="text-xs border-collapse" style={{ minWidth: "max-content" }}>
        <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
          <tr>
            <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left sticky left-0 bg-terminal-bg z-20 whitespace-nowrap min-w-[80px]">
              Symbol
            </th>
            {COLS.map((c) => (
              <th key={c.key} className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right whitespace-nowrap">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="animate-pulse border-b border-terminal-border/30">
                  {Array.from({ length: COLS.length + 1 }).map((__, j) => (
                    <td key={j} className="px-2 py-1.5">
                      <div className="h-3 bg-terminal-border/40 rounded" />
                    </td>
                  ))}
                </tr>
              ))
            : symbols.map((sym) => {
                const row = funds[sym] ?? ({} as FundRow);
                return (
                  <tr key={sym} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                    <td className="px-2 py-1.5 font-mono text-accent font-semibold sticky left-0 bg-terminal-bg whitespace-nowrap">
                      {sym}
                    </td>
                    {COLS.map((c) => {
                      const val = row[c.key];
                      const colorFn = c.color;
                      const cls = colorFn ? colorFn(val as number | null) : "text-terminal-fg";
                      return (
                        <td key={c.key} className={`px-2 py-1.5 text-right font-mono ${cls}`}>
                          {c.format(val as number | null)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          {!loading && symbols.length === 0 && (
            <tr>
              <td colSpan={COLS.length + 1} className="px-4 py-6 text-center text-terminal-dim text-xs">
                No positions to show fundamentals for.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
