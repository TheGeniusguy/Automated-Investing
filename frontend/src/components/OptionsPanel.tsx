import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { ChainSummary, VixTerm } from "../api/types";

const DEFAULT_OPTIONS_TICKERS = "SPY, QQQ, AAPL, MSFT, NVDA, TSLA, GOOGL, AMZN";

/**
 * Panel 8 — Options & Implied Vol.
 *
 * Left: VIX term structure chart (9d/30d/3m/6m) with structure label.
 * Right: per-ticker option-chain summary — ATM IV, P/C, implied ±1σ move.
 */
export function OptionsPanel() {
  const [vix, setVix]           = useState<VixTerm | null>(null);
  const [chains, setChains]     = useState<ChainSummary[]>([]);
  const [tickersRaw, setTickersRaw] = useState<string>(DEFAULT_OPTIONS_TICKERS);
  const [loading, setLoading]   = useState<boolean>(false);
  const [err, setErr]           = useState<string | null>(null);

  const tickers = useMemo(
    () => tickersRaw.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean),
    [tickersRaw],
  );

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [v, c] = await Promise.all([api.vixTerm(), api.optionChains(tickers, 30)]);
      setVix(v);
      setChains(c.summaries);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [tickersRaw]); // eslint-disable-line

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-2">
        <VixTermCard vix={vix} loading={loading} err={err} />
      </div>
      <div className="col-span-3">
        <ChainTable
          tickersRaw={tickersRaw}
          setTickersRaw={setTickersRaw}
          chains={chains}
          loading={loading}
          err={err}
        />
      </div>
    </div>
  );
}

function VixTermCard({
  vix, loading, err,
}: { vix: VixTerm | null; loading: boolean; err: string | null }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout:    { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid:      { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      autoSize:  true,
    });
    seriesRef.current = chart.addSeries(LineSeries, {
      color: "#ffb800", lineWidth: 2, pointMarkersVisible: true,
      priceLineVisible: false, lastValueVisible: true,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !vix) return;
    // Plot as a line over the four tenors. We synthesize an artificial date
    // sequence (today + 9, 30, 90, 180 days) so the chart can render a line.
    const today = Date.now();
    const offsets = [9, 30, 90, 180];
    const data = vix.tenors
      .map((p, i) => ({
        time: ((today + offsets[i] * 86_400_000) / 1000) as UTCTimestamp,
        value: p.value ?? NaN,
      }))
      .filter((p) => !Number.isNaN(p.value));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [vix]);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span>VIX Term Structure</span>
          {vix && <StructurePill structure={vix.structure} slope={vix.slope} />}
        </div>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : ""}
        </span>
      </div>
      <div className="panel-body flex flex-col">
        {err && <div className="text-accent-red text-xs">⚠ {err}</div>}
        <div ref={elRef} className="flex-1 min-h-0" />
        {vix && (
          <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
            {vix.tenors.map((t) => (
              <div key={t.ticker} className="border border-terminal-divider p-2 text-center">
                <div className="text-2xs uppercase tracking-wider text-terminal-muted">{t.label}</div>
                <div className="text-accent-amber font-semibold tabular-nums mt-0.5">
                  {t.value !== null ? t.value.toFixed(2) : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StructurePill({
  structure, slope,
}: { structure: VixTerm["structure"]; slope: number | null }) {
  const map: Record<VixTerm["structure"], { text: string; cls: string }> = {
    contango:      { text: "CONTANGO",      cls: "bg-accent-green/15 text-accent-green border-accent-green/40" },
    backwardation: { text: "BACKWARDATION", cls: "bg-accent-red/15 text-accent-red border-accent-red/40" },
    flat:          { text: "FLAT",          cls: "bg-accent-amber/15 text-accent-amber border-accent-amber/40" },
    unknown:       { text: "—",             cls: "border-terminal-divider text-terminal-muted" },
  };
  const cfg = map[structure];
  return (
    <span className={`pill border ${cfg.cls}`}>
      {cfg.text}
      {slope !== null && (
        <span className="ml-1 normal-case tracking-normal opacity-80">
          {slope >= 0 ? "+" : ""}{slope.toFixed(2)}
        </span>
      )}
    </span>
  );
}

function ChainTable({
  tickersRaw, setTickersRaw, chains, loading, err,
}: {
  tickersRaw: string;
  setTickersRaw: (v: string) => void;
  chains: ChainSummary[];
  loading: boolean;
  err: string | null;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Option Chain Summary</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : `${chains.length} tickers`}
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
                <th className="text-right pr-2">Spot</th>
                <th className="text-right pr-2">Expiry</th>
                <th className="text-right pr-2">IV(C)</th>
                <th className="text-right pr-2">IV(P)</th>
                <th className="text-right pr-2">Skew</th>
                <th className="text-right pr-2">P/C OI</th>
                <th className="text-right pr-3">±1σ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-divider">
              {chains.map((c) => (
                <tr key={c.symbol} className="hover:bg-white/[0.02]">
                  <td className="py-1.5 pl-3 pr-2 text-accent-amber">{c.symbol}</td>
                  <td className="pr-2 text-right text-terminal-text">{fmtMoney(c.spot)}</td>
                  <td className="pr-2 text-right text-terminal-muted">
                    {c.days_to_expiry !== null ? `${c.days_to_expiry}d` : "—"}
                  </td>
                  <td className="pr-2 text-right text-terminal-text">{fmtPct(c.iv_calls)}</td>
                  <td className="pr-2 text-right text-terminal-text">{fmtPct(c.iv_puts)}</td>
                  <td className="pr-2 text-right">
                    <SkewCell v={c.iv_skew} />
                  </td>
                  <td className="pr-2 text-right">
                    <PCCell v={c.pc_ratio_oi} />
                  </td>
                  <td className="pr-3 text-right text-terminal-text">{fmtMoney(c.implied_move_1sigma, "±$")}</td>
                </tr>
              ))}
              {chains.length === 0 && !loading && (
                <tr><td colSpan={8} className="p-3 text-terminal-dim text-xs">No data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SkewCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  const cls = v > 0 ? "text-accent-red" : v < 0 ? "text-accent-green" : "text-terminal-muted";
  return <span className={cls}>{v >= 0 ? "+" : ""}{(v * 100).toFixed(1)}%</span>;
}

function PCCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">—</span>;
  // > 1 = put-heavy (defensive/bearish), < 1 = call-heavy (offensive/bullish)
  const cls = v > 1.5 ? "text-accent-red" : v < 0.7 ? "text-accent-green" : "text-terminal-muted";
  return <span className={cls}>{v.toFixed(2)}</span>;
}

function fmtMoney(v: number | null, prefix = "$"): string {
  if (v === null) return "—";
  return `${prefix}${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return (v * 100).toFixed(1) + "%";
}
