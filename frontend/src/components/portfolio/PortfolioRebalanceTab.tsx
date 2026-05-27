import { useCallback, useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";
import type { RebalanceResponse } from "../../api/types";

interface Props {
  portfolioId: number;
}

interface TargetRow {
  symbol: string;
  target: string; // string for controlled input
}

const CASH = "CASH";

function fmtUsd(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function plColor(v: number) {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-dim";
}

export function PortfolioRebalanceTab({ portfolioId }: Props) {
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [threshold, setThreshold] = useState("5");
  const [newSymbol, setNewSymbol] = useState("");
  const [result, setResult] = useState<RebalanceResponse | null>(null);
  const [loadingInit, setLoadingInit] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pre-populate target weights from current holdings.
  const loadCurrent = useCallback(() => {
    setLoadingInit(true);
    setErr(null);
    portfolioApi
      .positions(portfolioId)
      .then(({ positions, summary }) => {
        const initial: TargetRow[] = positions.map((p) => ({
          symbol: p.symbol,
          target: (p.portfolio_weight ?? 0).toFixed(2),
        }));
        // Add a CASH row from the cash weight.
        const cashWeight = summary.cash_pct ?? 0;
        initial.push({ symbol: CASH, target: cashWeight.toFixed(2) });
        setRows(initial);
        setLoadingInit(false);
      })
      .catch((e) => { setErr(String(e)); setLoadingInit(false); });
  }, [portfolioId]);

  useEffect(() => { loadCurrent(); }, [loadCurrent]);

  const totalTarget = rows.reduce((sum, r) => sum + (parseFloat(r.target) || 0), 0);
  const totalOk = Math.abs(totalTarget - 100) < 0.05;

  const updateTarget = (symbol: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.symbol === symbol ? { ...r, target: value } : r)));
  };

  const removeRow = (symbol: string) => {
    setRows((prev) => prev.filter((r) => r.symbol !== symbol));
  };

  const addSymbol = () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    if (rows.some((r) => r.symbol === sym)) { setNewSymbol(""); return; }
    setRows((prev) => {
      // Keep CASH last.
      const withoutCash = prev.filter((r) => r.symbol !== CASH);
      const cash = prev.find((r) => r.symbol === CASH);
      const next = [...withoutCash, { symbol: sym, target: "0" }];
      if (cash) next.push(cash);
      return next;
    });
    setNewSymbol("");
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    setErr(null);
    try {
      const targets: Record<string, number> = {};
      for (const r of rows) {
        targets[r.symbol] = parseFloat(r.target) || 0;
      }
      const thr = parseFloat(threshold);
      const res = await portfolioApi.rebalance(
        portfolioId,
        targets,
        Number.isNaN(thr) ? undefined : thr,
      );
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSuggesting(false);
    }
  };

  if (loadingInit) return <div className="p-4 text-terminal-dim text-xs text-center">Loading current holdings...</div>;

  return (
    <div className="flex flex-col gap-3 p-3 overflow-auto">
      <p className="text-2xs text-terminal-dim">
        Set the target weight (%) you want for each holding. Targets are pre-filled from your current
        allocation. Adjust them, make sure they add up to 100%, then hit Suggest to see exactly which
        trades bring you back in line.
      </p>

      {/* Target editor */}
      <div className="border border-terminal-border/50 rounded">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-terminal-bg border-b border-terminal-border">
            <tr>
              <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left">Symbol</th>
              <th className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-right">Target %</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-b border-terminal-border/30">
                <td className={`px-2 py-1 font-mono font-semibold ${r.symbol === CASH ? "text-yellow-400" : "text-accent"}`}>
                  {r.symbol}
                </td>
                <td className="px-2 py-1 text-right">
                  <input
                    type="number"
                    value={r.target}
                    onChange={(e) => updateTarget(r.symbol, e.target.value)}
                    min="0"
                    step="any"
                    className="bg-terminal-bg border border-terminal-border rounded px-2 py-0.5 text-xs text-terminal-fg font-mono text-right w-24"
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  {r.symbol !== CASH && (
                    <button
                      type="button"
                      onClick={() => removeRow(r.symbol)}
                      className="pill text-2xs text-red-400 hover:bg-red-900/20"
                    >
                      Del
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-terminal-border bg-terminal-bg/60">
              <td className="px-2 py-1.5 text-2xs uppercase text-terminal-dim">Total</td>
              <td className={`px-2 py-1.5 text-right font-mono font-semibold tabular-nums ${totalOk ? "text-accent-green" : "text-accent-red"}`}>
                {totalTarget.toFixed(2)}%
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {!totalOk && (
        <p className="text-2xs text-accent-red">
          Targets add up to {totalTarget.toFixed(2)}% — they should total 100%
          ({totalTarget > 100 ? "reduce" : "increase"} by {Math.abs(totalTarget - 100).toFixed(2)}%).
        </p>
      )}

      {/* Add symbol + threshold + suggest */}
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <label className="text-2xs text-terminal-dim">Add Symbol</label>
          <div className="flex gap-1">
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") addSymbol(); }}
              placeholder="MSFT"
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono w-24"
            />
            <button type="button" onClick={addSymbol} className="pill text-xs text-terminal-dim hover:text-terminal-fg border border-terminal-border">
              + Add
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-2xs text-terminal-dim" title="Only flag holdings that drift more than this many percentage points">
            Drift Threshold (%)
          </label>
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            min="0"
            step="any"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono w-24"
          />
        </div>
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting}
          className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-40 self-end"
        >
          {suggesting ? "Calculating..." : "Suggest Trades"}
        </button>
      </div>

      {err && <p className="text-2xs text-accent-red">{err}</p>}

      {/* Results */}
      {result && (
        <div className="flex flex-col gap-2">
          <div
            className={`text-xs rounded px-2 py-1.5 border ${
              result.rebalance_needed
                ? "bg-amber-950/30 border-amber-600/50 text-amber-300"
                : "bg-green-950/20 border-green-700/40 text-green-300"
            }`}
          >
            {result.rebalance_needed
              ? `Rebalance recommended — total drift is ${result.total_drift_pct.toFixed(2)}% (threshold ${result.threshold_pct.toFixed(1)}%). Portfolio value ${fmtUsd(result.total_value)}.`
              : `You're balanced — total drift ${result.total_drift_pct.toFixed(2)}% is within the ${result.threshold_pct.toFixed(1)}% threshold.`}
          </div>

          <div className="overflow-auto border border-terminal-border/50 rounded">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
                <tr>
                  {["Symbol", "Current %", "Target %", "Drift", "Trade $", "Action", "Plain English"].map((h) => (
                    <th key={h} className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                    <td className={`px-2 py-1.5 font-mono font-semibold ${row.symbol === CASH ? "text-yellow-400" : "text-accent"}`}>
                      {row.symbol}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{row.current_weight_pct.toFixed(2)}%</td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{row.target_weight_pct.toFixed(2)}%</td>
                    <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${plColor(row.drift_pct)}`}>
                      {row.drift_pct >= 0 ? "+" : ""}{row.drift_pct.toFixed(2)}%
                    </td>
                    <td className={`px-2 py-1.5 font-mono text-right tabular-nums ${plColor(row.trade_value)}`}>
                      {row.trade_value > 0 ? "+" : ""}{fmtUsd(row.trade_value)}
                    </td>
                    <td className="px-2 py-1.5">
                      <ActionBadge action={row.action} />
                    </td>
                    <td className="px-2 py-1.5 text-terminal-dim text-2xs">{plainEnglish(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: "buy" | "sell" | "hold" }) {
  const cls =
    action === "buy" ? "bg-green-900/30 text-green-300"
    : action === "sell" ? "bg-red-900/30 text-red-300"
    : "bg-terminal-border text-terminal-dim";
  return <span className={`pill text-2xs uppercase ${cls}`}>{action}</span>;
}

function plainEnglish(row: { symbol: string; action: string; drift_pct: number; trade_value: number }): string {
  const sym = row.symbol === CASH ? "cash" : row.symbol;
  const dollars = `$${Math.abs(Math.round(row.trade_value)).toLocaleString("en-US")}`;
  if (row.action === "hold") return `On target — no trade needed.`;
  if (row.action === "buy") {
    return `Underweight by ${Math.abs(row.drift_pct).toFixed(1)}% — buy ~${dollars} of ${sym}.`;
  }
  return `Overweight ${sym} by ${Math.abs(row.drift_pct).toFixed(1)}% — sell ~${dollars}.`;
}
