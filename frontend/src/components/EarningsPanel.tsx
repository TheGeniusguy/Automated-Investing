import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { EarningsOverview, EarningsResult } from "../api/types";

const DEFAULT_TICKERS = "AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, JPM, BAC, XOM, UNH";

/**
 * Panel 9 — Earnings Calendar + Reaction History.
 *
 * Upcoming earnings dates per ticker plus 1y-2y of historical surprise +
 * next-day price reaction stats. Surfaces patterns like "sell the news"
 * (NVDA: +3.8% avg surprise, -2.93% avg next-day) or "priced in"
 * (AAPL: 100% beat rate, -0.7% avg reaction).
 */
export function EarningsPanel() {
  const [tickersRaw, setTickersRaw] = useState<string>(DEFAULT_TICKERS);
  const [data, setData] = useState<EarningsOverview | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const tickers = useMemo(
    () => tickersRaw.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean),
    [tickersRaw],
  );

  useEffect(() => {
    if (tickers.length === 0) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api.earningsOverview(tickers)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [tickersRaw]); // eslint-disable-line react-hooks/exhaustive-deps

  const focused = data?.results.find((r) => r.symbol === active) ?? data?.results[0] ?? null;

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-3">
        <CalendarCard
          tickersRaw={tickersRaw}
          setTickersRaw={setTickersRaw}
          results={data?.results ?? []}
          loading={loading}
          err={err}
          active={focused?.symbol ?? null}
          setActive={setActive}
        />
      </div>
      <div className="col-span-2">
        {focused
          ? <SurpriseHistoryCard r={focused} />
          : <div className="panel h-full"><div className="panel-header"><span>Surprise History</span></div><div className="panel-body text-xs text-terminal-dim">Pick a ticker.</div></div>}
      </div>
    </div>
  );
}

function CalendarCard({
  tickersRaw, setTickersRaw, results, loading, err, active, setActive,
}: {
  tickersRaw: string;
  setTickersRaw: (v: string) => void;
  results: EarningsResult[];
  loading: boolean;
  err: string | null;
  active: string | null;
  setActive: (s: string) => void;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Earnings Calendar</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : `${results.length} tickers`}
        </span>
      </div>
      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider">
          <label className="text-2xs uppercase tracking-wider text-terminal-muted">tickers</label>
          <textarea
            value={tickersRaw}
            onChange={(e) => setTickersRaw(e.target.value)}
            rows={2}
            spellCheck={false}
            className="mt-1 w-full bg-black/40 border border-terminal-divider
                       text-terminal-text font-mono text-xs p-2 outline-none
                       focus:border-accent-amber/60 resize-none"
          />
        </div>
        <div className="flex-1 overflow-auto">
          {err && <div className="p-3 text-accent-red text-xs">⚠ {err}</div>}
          <table className="w-full text-xs tabular-nums">
            <thead className="text-terminal-muted text-2xs uppercase tracking-wider sticky top-0 bg-terminal-panel">
              <tr className="border-b border-terminal-divider">
                <th className="text-left py-1.5 pl-3 pr-2">Ticker</th>
                <th className="text-left pr-2">Next</th>
                <th className="text-right pr-2">In</th>
                <th className="text-right pr-2">Est EPS</th>
                <th className="text-right pr-2">Beat %</th>
                <th className="text-right pr-2">Avg Surp</th>
                <th className="text-right pr-3">Avg 1d</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-divider">
              {results.map((r) => (
                <tr
                  key={r.symbol}
                  onClick={() => setActive(r.symbol)}
                  className={
                    "cursor-pointer hover:bg-white/[0.02] " +
                    (active === r.symbol ? "bg-white/[0.04]" : "")
                  }
                >
                  <td className="py-1.5 pl-3 pr-2 text-accent-amber">{r.symbol}</td>
                  <td className="pr-2 text-terminal-text whitespace-nowrap">{r.next_earnings ?? "—"}</td>
                  <td className="pr-2 text-right text-terminal-muted">{daysUntil(r.next_earnings)}</td>
                  <td className="pr-2 text-right text-terminal-text">
                    {r.eps_estimate !== null ? `$${r.eps_estimate.toFixed(2)}` : "—"}
                  </td>
                  <td className="pr-2 text-right">
                    <BeatCell v={r.stats.beat_rate} />
                  </td>
                  <td className="pr-2 text-right">
                    <PctCell v={r.stats.avg_surprise} />
                  </td>
                  <td className="pr-3 text-right">
                    <PctCell v={r.stats.avg_reaction_1d} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SurpriseHistoryCard({ r }: { r: EarningsResult }) {
  const past = r.events.filter((e) => e.actual !== null);
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Surprise History</span>
        <span className="normal-case tracking-normal text-accent-amber">{r.symbol}</span>
      </div>
      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider text-xs grid grid-cols-3 gap-2">
          <Stat label="Next" value={r.next_earnings ?? "—"} />
          <Stat label="Est EPS" value={r.eps_estimate !== null ? `$${r.eps_estimate.toFixed(2)}` : "—"} />
          <Stat label="Past events" value={String(r.stats.n)} />
          <Stat label="Beat rate" value={r.stats.beat_rate !== null ? `${(r.stats.beat_rate * 100).toFixed(0)}%` : "—"} />
          <Stat label="Avg surprise" value={r.stats.avg_surprise !== null ? `${(r.stats.avg_surprise * 100).toFixed(1)}%` : "—"} signed={r.stats.avg_surprise} />
          <Stat label="Avg 1d react" value={r.stats.avg_reaction_1d !== null ? `${(r.stats.avg_reaction_1d * 100).toFixed(2)}%` : "—"} signed={r.stats.avg_reaction_1d} />
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-terminal-muted text-2xs uppercase tracking-wider sticky top-0 bg-terminal-panel">
              <tr className="border-b border-terminal-divider">
                <th className="text-left py-1.5 pl-3 pr-2">Date</th>
                <th className="text-right pr-2">Est</th>
                <th className="text-right pr-2">Actual</th>
                <th className="text-right pr-2">Surp</th>
                <th className="text-right pr-2">1d</th>
                <th className="text-right pr-3">5d</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-divider">
              {past.map((e) => (
                <tr key={e.date} className="hover:bg-white/[0.02]">
                  <td className="py-1.5 pl-3 pr-2 text-terminal-muted whitespace-nowrap">
                    {e.date.slice(0, 10)}
                  </td>
                  <td className="pr-2 text-right text-terminal-text">
                    {e.estimate !== null ? `$${e.estimate.toFixed(2)}` : "—"}
                  </td>
                  <td className="pr-2 text-right text-terminal-text">
                    {e.actual !== null ? `$${e.actual.toFixed(2)}` : "—"}
                  </td>
                  <td className="pr-2 text-right">
                    <PctCell v={e.surprise_pct} />
                  </td>
                  <td className="pr-2 text-right">
                    <PctCell v={e.reaction_1d} />
                  </td>
                  <td className="pr-3 text-right">
                    <PctCell v={e.reaction_5d} />
                  </td>
                </tr>
              ))}
              {past.length === 0 && (
                <tr><td colSpan={6} className="p-3 text-terminal-dim text-xs">No past events.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, signed }: { label: string; value: string; signed?: number | null }) {
  let cls = "text-terminal-text";
  if (typeof signed === "number") {
    cls = signed > 0 ? "text-accent-green" : signed < 0 ? "text-accent-red" : "text-terminal-muted";
  }
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-muted">{label}</div>
      <div className={`${cls} font-semibold mt-0.5`}>{value}</div>
    </div>
  );
}

function BeatCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  const pct = v * 100;
  const cls = pct >= 75 ? "text-accent-green" : pct >= 50 ? "text-terminal-text" : "text-accent-red";
  return <span className={cls}>{pct.toFixed(0)}%</span>;
}

function PctCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  const pct = v * 100;
  const cls = pct > 0 ? "text-accent-green" : pct < 0 ? "text-accent-red" : "text-terminal-muted";
  return <span className={cls}>{pct > 0 ? "+" : ""}{pct.toFixed(2)}%</span>;
}

function daysUntil(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const now = new Date();
    const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) return `${-days}d ago`;
    if (days === 0) return "today";
    return `${days}d`;
  } catch {
    return "—";
  }
}
