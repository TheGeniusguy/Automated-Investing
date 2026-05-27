import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { InsiderTickerResponse } from "../api/types";

export function InsiderTransactionsPanel() {
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [days, setDays] = useState(365);
  const [data, setData] = useState<InsiderTickerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [filter, setFilter] = useState<"all" | "P" | "S">("all");

  const load = (sym: string) => {
    setLoading(true);
    setErr(null);
    api
      .insiderSummary(sym, days)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  };

  useEffect(() => { load(symbol); }, [symbol, days]);

  const handleIngest = () => {
    setIngesting(true);
    api
      .insiderIngest([symbol], days)
      .then(() => { load(symbol); setIngesting(false); })
      .catch(() => setIngesting(false));
  };

  const filtered = data?.transactions.filter(
    (t) => filter === "all" || t.txn_code === filter,
  ) ?? [];

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">INSIDER TRANSACTIONS</span>
          <span className="text-xs text-terminal-dim">SEC Form 4</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && setSymbol(symbolInput)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-0.5 text-xs w-20 text-terminal-fg"
            placeholder="Symbol"
          />
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-terminal-bg border border-terminal-border rounded px-1 py-0.5 text-xs text-terminal-fg"
          >
            <option value={90}>90d</option>
            <option value={180}>180d</option>
            <option value={365}>1Y</option>
            <option value={730}>2Y</option>
          </select>
          <button
            type="button"
            onClick={handleIngest}
            disabled={ingesting}
            className="pill text-xs bg-accent/20 hover:bg-accent/40 text-accent"
          >
            {ingesting ? "Fetching..." : "Fetch from SEC"}
          </button>
        </div>
      </header>

      <div className="panel-body flex-1 overflow-auto">
        {loading && <div className="text-terminal-dim text-xs p-2">Loading...</div>}
        {err && <div className="text-rose-400 text-xs p-2">Error: {err}</div>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-2 p-2">
              <StatCard label="Buys" value={data.summary.buy_count} sub={fmtDollar(data.summary.buy_value)} color="text-emerald-400" />
              <StatCard label="Sells" value={data.summary.sell_count} sub={fmtDollar(data.summary.sell_value)} color="text-rose-400" />
              <StatCard label="Net Value" value={fmtDollar(data.summary.net_value)} color={data.summary.net_value >= 0 ? "text-emerald-400" : "text-rose-400"} />
              <StatCard
                label="Buy/Sell Ratio"
                value={data.summary.buy_sell_ratio === Infinity ? "All Buys" : data.summary.buy_sell_ratio.toFixed(2)}
                color={data.summary.buy_sell_ratio > 1 ? "text-emerald-400" : "text-rose-400"}
              />
            </div>

            {/* Cluster alerts */}
            {data.clusters.length > 0 && (
              <div className="mx-2 mb-2 p-2 rounded bg-emerald-900/30 border border-emerald-700/50">
                <div className="text-xs text-emerald-400 font-semibold mb-1">
                  Cluster Buy Detected
                </div>
                {data.clusters.map((c, i) => (
                  <div key={i} className="text-2xs text-emerald-300">
                    {c.insider_count} insiders bought {c.start_date} to {c.end_date}:
                    {" "}{c.insiders.join(", ")}
                  </div>
                ))}
              </div>
            )}

            {/* Filter tabs */}
            <div className="flex gap-1 px-2 mb-1">
              {(["all", "P", "S"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`pill text-xs ${filter === f ? "bg-accent text-black" : ""}`}
                >
                  {f === "all" ? "All" : f === "P" ? "Purchases" : "Sales"}
                </button>
              ))}
            </div>

            {/* Transaction table */}
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Date</th>
                  <th className="text-left py-1 px-2">Insider</th>
                  <th className="text-left py-1 px-2">Title</th>
                  <th className="text-center py-1 px-2">Type</th>
                  <th className="text-right py-1 px-2">Shares</th>
                  <th className="text-right py-1 px-2">Price</th>
                  <th className="text-right py-1 px-2">Value</th>
                  <th className="text-right py-1 px-2">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr key={i} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                    <td className="py-1 px-2 tabular-nums">{t.txn_date ?? "--"}</td>
                    <td className="py-1 px-2 truncate max-w-[140px]">{t.insider_name}</td>
                    <td className="py-1 px-2 text-terminal-dim truncate max-w-[100px]">{t.insider_title || "--"}</td>
                    <td className="py-1 px-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold ${
                        t.txn_code === "P" ? "bg-emerald-900/50 text-emerald-400" :
                        t.txn_code === "S" ? "bg-rose-900/50 text-rose-400" :
                        "bg-terminal-border/50 text-terminal-dim"
                      }`}>
                        {TXN_LABELS[t.txn_code] ?? t.txn_code}
                      </span>
                    </td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtNum(t.shares)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">
                      {t.price_per_share != null ? `$${t.price_per_share.toFixed(2)}` : "--"}
                    </td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtDollar(t.total_value)}</td>
                    <td className="text-right py-1 px-2 tabular-nums text-terminal-dim">{fmtNum(t.shares_after)}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center py-4 text-terminal-dim">
                      No insider transactions found. Click "Fetch from SEC" to ingest data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

const TXN_LABELS: Record<string, string> = {
  P: "Buy",
  S: "Sell",
  A: "Award",
  M: "Exercise",
  F: "Tax",
  G: "Gift",
  D: "Dispose",
  C: "Convert",
};

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-dim uppercase">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color ?? ""}`}>{value}</div>
      {sub && <div className="text-2xs text-terminal-dim tabular-nums">{sub}</div>}
    </div>
  );
}

function fmtDollar(v: number | null | undefined): string {
  if (v == null) return "--";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return "--";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
