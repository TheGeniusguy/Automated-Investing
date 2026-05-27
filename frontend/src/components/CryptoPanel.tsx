import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { cryptoApi } from "../api/client";
import type { CryptoCompareResponse, CryptoOverviewResponse } from "../api/types";

/**
 * Crypto panel — top-coin overview table + normalized comparison chart.
 *
 * Overview: top majors with price, 24h/7d change, market cap. Optional global
 * market cap + BTC dominance from CoinGecko (null-safe).
 * Compare: BTC vs ETH (default) normalized-to-100 over the selected window.
 */
const COMPARE_PRESET = ["BTC-USD", "ETH-USD", "SOL-USD"];
const SERIES_COLORS = ["#ffb800", "#4ade80", "#3b82f6", "#f87171", "#a78bfa"];

export function CryptoPanel() {
  const [data, setData] = useState<CryptoOverviewResponse | null>(null);
  const [cmp, setCmp] = useState<CryptoCompareResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([cryptoApi.overview(), cryptoApi.compare(COMPARE_PRESET, 365)])
      .then(([ov, c]) => {
        if (!alive) return;
        setData(ov);
        setCmp(c);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <span className="text-accent-amber font-semibold tracking-wider">CRYPTO</span>
        {data?.global?.btc_dominance_pct != null && (
          <span className="text-2xs text-terminal-dim">
            BTC dominance {data.global.btc_dominance_pct.toFixed(1)}%
            {data.global.total_market_cap_usd != null && (
              <> · Total mcap {fmtBig(data.global.total_market_cap_usd)}</>
            )}
          </span>
        )}
      </header>

      <div className="panel-body flex-1 overflow-auto p-2 space-y-3">
        {loading && <div className="text-terminal-dim text-xs">Loading crypto…</div>}
        {err && <div className="text-accent-red text-xs">Error: {err}</div>}

        {data && data.coins.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Coin</th>
                  <th className="text-right py-1 px-2">Price (USD)</th>
                  <th className="text-right py-1 px-2">24h</th>
                  <th className="text-right py-1 px-2">7d</th>
                  <th className="text-right py-1 px-2">Market Cap</th>
                </tr>
              </thead>
              <tbody>
                {data.coins.map((c) => (
                  <tr key={c.symbol} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                    <td className="py-1 px-2">
                      <span className="font-mono">{c.symbol.replace("-USD", "")}</span>
                      <span className="text-terminal-dim ml-2">{c.name}</span>
                    </td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtPrice(c.price)}</td>
                    <td className={`text-right py-1 px-2 tabular-nums ${pnl(c.change_24h_pct)}`}>{fmtPct(c.change_24h_pct)}</td>
                    <td className={`text-right py-1 px-2 tabular-nums ${pnl(c.change_7d_pct)}`}>{fmtPct(c.change_7d_pct)}</td>
                    <td className="text-right py-1 px-2 tabular-nums text-terminal-dim">{fmtBig(c.market_cap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.coins.length === 0 && !loading && (
          <div className="text-terminal-dim text-xs italic">No crypto data available.</div>
        )}

        {/* Comparison chart */}
        {cmp && Object.keys(cmp.series).length > 0 && (
          <div className="pt-2 border-t border-terminal-border">
            <div className="flex items-center gap-3 px-1 pb-1 text-2xs flex-wrap">
              <span className="text-terminal-dim">1Y relative (normalized to 100)</span>
              {cmp.symbols.map((s, i) => {
                const m = cmp.metrics[s];
                return (
                  <span key={s} style={{ color: SERIES_COLORS[i % SERIES_COLORS.length] }}>
                    {s.replace("-USD", "")}:{" "}
                    <span className={pnl(m?.return_pct ?? null)}>{fmtPct(m?.return_pct ?? null)}</span>
                  </span>
                );
              })}
            </div>
            <CompareChart data={cmp} />
          </div>
        )}
      </div>
    </section>
  );
}

function CompareChart({ data }: { data: CryptoCompareResponse }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8b8b8b",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1a1a1a" },
        horzLines: { color: "#1a1a1a" },
      },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRefs.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Remove stale series.
    for (const [key, s] of seriesRefs.current.entries()) {
      if (!data.series[key]) {
        chart.removeSeries(s);
        seriesRefs.current.delete(key);
      }
    }
    data.symbols.forEach((sym, i) => {
      const points = data.series[sym];
      if (!points) return;
      let series = seriesRefs.current.get(sym);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: SERIES_COLORS[i % SERIES_COLORS.length],
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        seriesRefs.current.set(sym, series);
      }
      series.setData(
        points.map((p) => ({
          time: (Date.parse(p.date) / 1000) as UTCTimestamp,
          value: p.value,
        })),
      );
    });
    chart.timeScale().fitContent();
  }, [data]);

  return <div ref={elRef} style={{ height: 200 }} />;
}

function pnl(v: number | null): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null): string {
  if (v == null) return "—";
  if (v < 1) return v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtBig(v: number | null): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
}
