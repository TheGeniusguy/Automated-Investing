import { useCallback, useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";
import type { PortfolioTaxResponse } from "../../api/types";

interface Props {
  portfolioId: number;
}

function fmtUsd(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plColor(v: number) {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-dim";
}

export function PortfolioTaxTab({ portfolioId }: Props) {
  const [data, setData] = useState<PortfolioTaxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [yearInput, setYearInput] = useState<string>("");
  const [appliedYear, setAppliedYear] = useState<number | undefined>(undefined);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    portfolioApi
      .tax(portfolioId, appliedYear)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId, appliedYear]);

  useEffect(() => { load(); }, [load]);

  const applyYear = () => {
    const trimmed = yearInput.trim();
    if (!trimmed) { setAppliedYear(undefined); return; }
    const n = parseInt(trimmed, 10);
    if (!Number.isNaN(n)) setAppliedYear(n);
  };

  if (loading) return <div className="p-4 text-terminal-dim text-xs text-center">Loading tax data...</div>;
  if (err) return <div className="p-3 text-accent-red text-xs">{err}</div>;
  if (!data) return null;

  const { summary, tlh } = data;

  return (
    <div className="flex flex-col gap-3 p-3 overflow-auto">
      {/* Year filter */}
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <label className="text-2xs text-terminal-dim">Tax Year</label>
          <input
            value={yearInput}
            onChange={(e) => setYearInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyYear(); }}
            placeholder={summary.year != null ? String(summary.year) : "All years"}
            inputMode="numeric"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono w-28"
          />
        </div>
        <button
          type="button"
          onClick={applyYear}
          className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 self-end"
        >
          Apply
        </button>
        {appliedYear != null && (
          <button
            type="button"
            onClick={() => { setYearInput(""); setAppliedYear(undefined); }}
            className="pill text-2xs text-terminal-dim hover:text-terminal-fg self-end"
          >
            Clear
          </button>
        )}
        <span className="text-2xs text-terminal-dim self-end pb-1">
          {summary.year != null ? `Showing ${summary.year}` : "Showing all years"} · {summary.lot_count} closed lot{summary.lot_count === 1 ? "" : "s"}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <SummaryCard
          label="Short-Term Gain"
          hint="Held ≤ 1 year — taxed as ordinary income"
          value={summary.short_term_gain}
        />
        <SummaryCard
          label="Long-Term Gain"
          hint="Held > 1 year — lower capital-gains rate"
          value={summary.long_term_gain}
        />
        <SummaryCard
          label="Total Realized"
          hint="Net of all closed positions this period"
          value={summary.total_realized}
        />
      </div>

      {/* Wash-sale warnings */}
      {summary.wash_sale_flags.length > 0 && (
        <div className="bg-amber-950/30 border border-amber-600/50 rounded p-2">
          <div className="text-2xs text-amber-400 uppercase tracking-wider mb-1 font-semibold">
            Wash-Sale Warnings ({summary.wash_sale_flags.length})
          </div>
          <p className="text-2xs text-terminal-dim mb-2">
            You sold at a loss and re-bought the same symbol within 30 days. The IRS disallows the loss
            on a wash sale — it gets added to the cost basis of the replacement shares instead.
          </p>
          <div className="flex flex-col gap-1">
            {summary.wash_sale_flags.map((w, i) => (
              <div
                key={`${w.symbol}-${i}`}
                className={`flex items-center justify-between gap-2 text-xs rounded px-2 py-1 ${
                  w.disallowed ? "bg-red-950/30 border border-red-700/40" : "bg-terminal-bg border border-amber-700/30"
                }`}
              >
                <span className="font-mono text-accent font-semibold">{w.symbol}</span>
                <span className="text-terminal-dim text-2xs flex-1 text-center">
                  Sold {w.close_date} · re-bought {w.repurchase_date}
                </span>
                <span className="text-accent-red font-mono tabular-nums">
                  Loss {fmtUsd(w.loss)}
                </span>
                <span
                  className={`pill text-2xs ${
                    w.disallowed ? "bg-red-900/40 text-red-300" : "bg-amber-900/30 text-amber-300"
                  }`}
                >
                  {w.disallowed ? "Disallowed" : "Watch"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Realized lots table */}
      <div>
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">Realized Lots</div>
        <div className="overflow-auto border border-terminal-border/50 rounded">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
              <tr>
                {["Symbol", "Term", "Qty", "Opened", "Closed", "Days", "Proceeds", "Cost Basis", "Gain/Loss"].map((h) => (
                  <th key={h} className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.lots.map((lot, i) => (
                <tr key={`${lot.symbol}-${i}`} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                  <td className="px-2 py-1.5 font-mono text-accent font-semibold">{lot.symbol}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`pill text-2xs ${
                        lot.term === "long" ? "bg-blue-900/30 text-blue-300" : "bg-yellow-900/30 text-yellow-300"
                      }`}
                      title={lot.term === "long" ? "Long-term (held > 1 year)" : "Short-term (held ≤ 1 year)"}
                    >
                      {lot.term === "long" ? "LT" : "ST"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{lot.quantity.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                  <td className="px-2 py-1.5 font-mono text-terminal-dim whitespace-nowrap">{lot.open_date}</td>
                  <td className="px-2 py-1.5 font-mono text-terminal-dim whitespace-nowrap">{lot.close_date}</td>
                  <td className="px-2 py-1.5 font-mono text-right text-terminal-dim">{lot.holding_days ?? "--"}</td>
                  <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{fmtUsd(lot.proceeds)}</td>
                  <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{fmtUsd(lot.cost_basis)}</td>
                  <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${plColor(lot.gain)}`}>{fmtUsd(lot.gain)}</td>
                </tr>
              ))}
              {summary.lots.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-terminal-dim text-xs">
                    No closed (realized) positions for this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tax-loss-harvesting candidates */}
      <div>
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">
          Tax-Loss Harvesting Candidates
        </div>
        <p className="text-2xs text-terminal-dim mb-1">
          Open positions currently sitting at an unrealized loss. Selling them would lock in a deductible
          loss to offset gains — just avoid re-buying within 30 days (see wash-sale rule above).
        </p>
        <div className="overflow-auto border border-terminal-border/50 rounded">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
              <tr>
                {["Symbol", "Market Value", "Unrealized Loss", "Loss %"].map((h) => (
                  <th key={h} className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tlh.map((c) => (
                <tr key={c.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                  <td className="px-2 py-1.5 font-mono text-accent font-semibold">{c.symbol}</td>
                  <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{fmtUsd(c.market_value)}</td>
                  <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${plColor(c.unrealized_pl)}`}>{fmtUsd(c.unrealized_pl)}</td>
                  <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${plColor(c.unrealized_pl_pct)}`}>
                    {c.unrealized_pl_pct >= 0 ? "+" : ""}{c.unrealized_pl_pct.toFixed(2)}%
                  </td>
                </tr>
              ))}
              {tlh.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-terminal-dim text-xs">
                    No positions are currently at an unrealized loss. Nothing to harvest.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, hint, value }: { label: string; hint: string; value: number }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-dim uppercase leading-tight">{label}</div>
      <div className={`text-base font-semibold tabular-nums mt-0.5 ${plColor(value)}`}>{fmtUsd(value)}</div>
      <div className="text-2xs text-terminal-muted mt-0.5 leading-tight">{hint}</div>
    </div>
  );
}
