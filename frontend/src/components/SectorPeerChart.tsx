/**
 * Peer Comparison Chart — YTD performance for all sector stocks normalized
 * to 100 at Jan 1. Each stock is a separate line series. The sector ETF is
 * drawn thicker in white. Best performer = bright green, worst = rose.
 * A dashed baseline at 100 marks flat.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { SectorPeerComparisonResponse } from "../api/types";

interface Props {
  data: SectorPeerComparisonResponse;
}

// Fixed palette for up to 14 lines (excluding ETF/best/worst which get special colors)
const PALETTE = [
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#fb923c", // orange-400
  "#34d399", // emerald-400
  "#f472b6", // pink-400
  "#facc15", // yellow-400
  "#38bdf8", // sky-400
  "#c084fc", // purple-400
  "#4ade80", // green-400 (lighter)
  "#f87171", // red-400 (lighter)
  "#2dd4bf", // teal-400
  "#e879f9", // fuchsia-400
  "#a3e635", // lime-400
  "#fb7185", // rose-400 lighter
];

function toUTC(dateStr: string): UTCTimestamp {
  return (new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

export function SectorPeerChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<"Line">[]>([]);
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);

  // Init chart once
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      rightPriceScale: { borderColor: "#374151" },
      timeScale: {
        borderColor: "#374151",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (el) chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Update series whenever data changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old series
    for (const s of seriesRefs.current) chart.removeSeries(s);
    seriesRefs.current = [];

    if (!data.series.length) return;

    // Assign colors
    const etf = data.etf;
    const best = data.best;
    const worst = data.worst;
    let paletteIdx = 0;

    const colorFor = (symbol: string): string => {
      if (symbol === best) return "#22c55e";    // green-500
      if (symbol === worst) return "#ef4444";   // red-500
      if (symbol === etf) return "#ffffff";
      return PALETTE[paletteIdx++ % PALETTE.length];
    };

    // Draw ETF last so it's on top of stocks
    const stocks = data.series.filter((s) => s.symbol !== etf);
    const etfSeries = data.series.find((s) => s.symbol === etf);
    const ordered = etfSeries ? [...stocks, etfSeries] : stocks;

    for (const peer of ordered) {
      const color = colorFor(peer.symbol);
      const isEtf = peer.symbol === etf;
      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: isEtf ? 2 : 1,
        lineStyle: isEtf ? 0 : 0,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: peer.symbol,
      });
      const chartData = peer.points.map((p) => ({
        time: toUTC(p.date),
        value: p.value,
      }));
      lineSeries.setData(chartData);
      seriesRefs.current.push(lineSeries);
    }

    // Baseline at 100
    const baseline = chart.addSeries(LineSeries, {
      color: "#4b5563",
      lineWidth: 1,
      lineStyle: 1, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: "",
    });
    const dates = data.series[0]?.points ?? [];
    if (dates.length >= 2) {
      baseline.setData([
        { time: toUTC(dates[0].date), value: 100 },
        { time: toUTC(dates[dates.length - 1].date), value: 100 },
      ]);
    }
    seriesRefs.current.push(baseline);

    chart.timeScale().fitContent();
  }, [data]);

  const year = new Date().getFullYear();
  const etf = data.etf;
  const sortedForLegend = [...data.series].sort((a, b) => b.ytd_pct - a.ytd_pct);

  let legendPaletteIdx = 0;
  const legendColorFor = (symbol: string): string => {
    if (symbol === data.best) return "#22c55e";
    if (symbol === data.worst) return "#ef4444";
    if (symbol === etf) return "#ffffff";
    return PALETTE[legendPaletteIdx++ % PALETTE.length];
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider font-semibold">
          YTD Peer Comparison — {year} (rebased to 100)
        </span>
        <span className="text-2xs text-terminal-dim">
          {data.series.length} series · ETF = {etf}
        </span>
      </div>

      <div ref={containerRef} style={{ height: 260, width: "100%" }} />

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 max-h-20 overflow-y-auto">
        {sortedForLegend.map((peer) => {
          const color = legendColorFor(peer.symbol);
          const isBest = peer.symbol === data.best;
          const isWorst = peer.symbol === data.worst;
          const isEtf = peer.symbol === etf;
          return (
            <button
              key={peer.symbol}
              type="button"
              onMouseEnter={() => setHoveredSymbol(peer.symbol)}
              onMouseLeave={() => setHoveredSymbol(null)}
              className={`flex items-center gap-1 text-2xs transition-opacity ${
                hoveredSymbol && hoveredSymbol !== peer.symbol
                  ? "opacity-40"
                  : "opacity-100"
              }`}
            >
              <span
                className="w-3 h-0.5 inline-block flex-shrink-0"
                style={{
                  backgroundColor: color,
                  height: isEtf ? 2 : 1,
                }}
              />
              <span
                style={{ color }}
                className={`tabular-nums ${isEtf ? "font-semibold" : ""}`}
              >
                {peer.symbol}
              </span>
              <span
                className="tabular-nums"
                style={{ color: peer.ytd_pct >= 0 ? "#22c55e" : "#ef4444" }}
              >
                {peer.ytd_pct >= 0 ? "+" : ""}{peer.ytd_pct.toFixed(1)}%
              </span>
              {isBest && <span className="text-green-400">▲</span>}
              {isWorst && <span className="text-rose-400">▼</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
