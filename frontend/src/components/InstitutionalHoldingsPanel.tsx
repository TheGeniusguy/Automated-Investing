import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  InstitutionalChanges,
  InstitutionalFiler,
  InstitutionalPortfolio,
} from "../api/types";

type View = "filers" | "portfolio" | "changes";

export function InstitutionalHoldingsPanel() {
  const [filers, setFilers] = useState<InstitutionalFiler[]>([]);
  const [view, setView] = useState<View>("filers");
  const [_selectedFiler, setSelectedFiler] = useState<InstitutionalFiler | null>(null);
  const [portfolio, setPortfolio] = useState<InstitutionalPortfolio | null>(null);
  const [changes, setChanges] = useState<InstitutionalChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.institutionalFilers().then((r) => setFilers(r.filers)).catch(() => {});
  }, []);

  const handleIngest = () => {
    setIngesting(true);
    api
      .institutionalIngest()
      .then(() => api.institutionalFilers())
      .then((r) => { setFilers(r.filers); setIngesting(false); })
      .catch(() => setIngesting(false));
  };

  const openPortfolio = (filer: InstitutionalFiler) => {
    setSelectedFiler(filer);
    setView("portfolio");
    setLoading(true);
    setErr(null);
    api
      .institutionalPortfolio(filer.cik)
      .then((p) => { setPortfolio(p); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  };

  const openChanges = (filer: InstitutionalFiler) => {
    setSelectedFiler(filer);
    setView("changes");
    setLoading(true);
    setErr(null);
    api
      .institutionalChanges(filer.cik)
      .then((c) => { setChanges(c); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  };

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">13F INSTITUTIONAL</span>
          <span className="text-xs text-terminal-dim">Quarterly Holdings</span>
        </div>
        <div className="flex items-center gap-2">
          {view !== "filers" && (
            <button
              type="button"
              onClick={() => setView("filers")}
              className="pill text-xs hover:bg-terminal-border/50"
            >
              &larr; All Filers
            </button>
          )}
          <button
            type="button"
            onClick={handleIngest}
            disabled={ingesting}
            className="pill text-xs bg-accent/20 hover:bg-accent/40 text-accent"
          >
            {ingesting ? "Ingesting..." : "Fetch from SEC"}
          </button>
        </div>
      </header>

      <div className="panel-body flex-1 overflow-auto">
        {err && <div className="text-rose-400 text-xs p-2">Error: {err}</div>}

        {/* Filers list */}
        {view === "filers" && (
          <table className="w-full text-xs">
            <thead className="text-terminal-dim uppercase tracking-wide">
              <tr>
                <th className="text-left py-1 px-2">Fund Manager</th>
                <th className="text-right py-1 px-2">Holdings</th>
                <th className="text-right py-1 px-2">Latest Q</th>
                <th className="text-right py-1 px-2">Filed</th>
                <th className="text-center py-1 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filers.map((f) => (
                <tr key={f.cik} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                  <td className="py-1.5 px-2 text-accent">{f.name}</td>
                  <td className="text-right py-1.5 px-2 tabular-nums">
                    {f.holdings_count > 0 ? f.holdings_count.toLocaleString() : "--"}
                  </td>
                  <td className="text-right py-1.5 px-2 tabular-nums text-terminal-dim">
                    {f.latest_quarter ?? "--"}
                  </td>
                  <td className="text-right py-1.5 px-2 tabular-nums text-terminal-dim">
                    {f.latest_filing ?? "--"}
                  </td>
                  <td className="text-center py-1.5 px-2">
                    <div className="flex gap-1 justify-center">
                      <button
                        type="button"
                        onClick={() => openPortfolio(f)}
                        className="pill text-2xs"
                        disabled={f.holdings_count === 0}
                      >
                        Portfolio
                      </button>
                      <button
                        type="button"
                        onClick={() => openChanges(f)}
                        className="pill text-2xs"
                        disabled={f.holdings_count === 0}
                      >
                        Changes
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-4 text-terminal-dim">
                    No data yet. Click "Fetch from SEC" to ingest 13F filings.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* Portfolio view */}
        {view === "portfolio" && (
          <>
            {loading && <div className="text-terminal-dim text-xs p-2">Loading portfolio...</div>}
            {portfolio && !loading && (
              <>
                <div className="p-2 flex items-center justify-between">
                  <div>
                    <div className="text-sm text-accent font-semibold">{portfolio.filer_name}</div>
                    <div className="text-2xs text-terminal-dim">
                      Q: {portfolio.report_date} | {portfolio.position_count} positions |
                      Total: {fmtDollar(portfolio.total_value)}
                    </div>
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead className="text-terminal-dim uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1 px-2">#</th>
                      <th className="text-left py-1 px-2">Issuer</th>
                      <th className="text-right py-1 px-2">Shares</th>
                      <th className="text-right py-1 px-2">Value</th>
                      <th className="text-right py-1 px-2">% of Portfolio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.holdings.map((h, i) => {
                      const val = (h.value_x1000 ?? 0) * 1000;
                      const pctPort = portfolio.total_value > 0
                        ? (val / portfolio.total_value * 100)
                        : 0;
                      return (
                        <tr key={`${h.cusip}-${i}`} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                          <td className="py-1 px-2 text-terminal-dim">{i + 1}</td>
                          <td className="py-1 px-2 truncate max-w-[200px]">
                            {h.symbol ? (
                              <span className="text-accent font-mono mr-1">{h.symbol}</span>
                            ) : null}
                            {h.name_of_issuer}
                          </td>
                          <td className="text-right py-1 px-2 tabular-nums">
                            {h.shares != null ? h.shares.toLocaleString() : "--"}
                          </td>
                          <td className="text-right py-1 px-2 tabular-nums">{fmtDollar(val)}</td>
                          <td className="text-right py-1 px-2 tabular-nums">
                            <div className="flex items-center justify-end gap-1">
                              <div
                                className="h-1.5 rounded bg-accent/60"
                                style={{ width: `${Math.min(pctPort * 3, 60)}px` }}
                              />
                              <span>{pctPort.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {/* Changes view */}
        {view === "changes" && (
          <>
            {loading && <div className="text-terminal-dim text-xs p-2">Loading changes...</div>}
            {changes && !loading && (
              <>
                <div className="p-2">
                  <div className="text-sm text-accent font-semibold">{changes.filer_name}</div>
                  <div className="text-2xs text-terminal-dim mb-2">
                    {changes.prior_quarter} &rarr; {changes.current_quarter}
                  </div>
                  <div className="flex gap-3 text-2xs">
                    <span className="text-emerald-400">+{changes.summary.new_positions} New</span>
                    <span className="text-rose-400">-{changes.summary.exited} Exited</span>
                    <span className="text-blue-400">&uarr;{changes.summary.increased} Increased</span>
                    <span className="text-amber-400">&darr;{changes.summary.decreased} Decreased</span>
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead className="text-terminal-dim uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1 px-2">Issuer</th>
                      <th className="text-center py-1 px-2">Action</th>
                      <th className="text-right py-1 px-2">Prior Shares</th>
                      <th className="text-right py-1 px-2">Current Shares</th>
                      <th className="text-right py-1 px-2">Delta</th>
                      <th className="text-right py-1 px-2">Delta %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.changes.filter(c => c.change_type !== "unchanged").map((c, i) => (
                      <tr key={`${c.cusip}-${i}`} className="border-b border-terminal-border/30 hover:bg-terminal-panel/60">
                        <td className="py-1 px-2 truncate max-w-[200px]">{c.name_of_issuer}</td>
                        <td className="text-center py-1 px-2">
                          <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold ${CHANGE_COLORS[c.change_type]}`}>
                            {CHANGE_LABELS[c.change_type]}
                          </span>
                        </td>
                        <td className="text-right py-1 px-2 tabular-nums">
                          {c.prior_shares > 0 ? c.prior_shares.toLocaleString() : "--"}
                        </td>
                        <td className="text-right py-1 px-2 tabular-nums">
                          {c.current_shares > 0 ? c.current_shares.toLocaleString() : "--"}
                        </td>
                        <td className="text-right py-1 px-2 tabular-nums" style={{ color: c.share_delta >= 0 ? "#34d399" : "#fb7185" }}>
                          {c.share_delta >= 0 ? "+" : ""}{c.share_delta.toLocaleString()}
                        </td>
                        <td className="text-right py-1 px-2 tabular-nums text-terminal-dim">
                          {c.share_delta_pct != null ? `${c.share_delta_pct >= 0 ? "+" : ""}${c.share_delta_pct.toFixed(1)}%` : "--"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const CHANGE_LABELS: Record<string, string> = {
  new_position: "NEW",
  exited: "EXIT",
  increased: "ADD",
  decreased: "TRIM",
  unchanged: "--",
};

const CHANGE_COLORS: Record<string, string> = {
  new_position: "bg-emerald-900/50 text-emerald-400",
  exited: "bg-rose-900/50 text-rose-400",
  increased: "bg-blue-900/50 text-blue-400",
  decreased: "bg-amber-900/50 text-amber-400",
  unchanged: "bg-terminal-border/50 text-terminal-dim",
};

function fmtDollar(v: number | null | undefined): string {
  if (v == null) return "--";
  if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
