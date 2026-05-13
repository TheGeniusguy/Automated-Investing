import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { SeriesPoint } from "../api/types";

interface Props {
  points: SeriesPoint[];
  label: string;
  unit: string;
}

/** Single-series line chart, TradingView-styled for a dark terminal. */
export function MacroChart({ points, label, unit }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // One-time chart init.
  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor:  "#8b8b8b",
        fontFamily: "JetBrains Mono, monospace",
        fontSize:   10,
      },
      grid: {
        vertLines: { color: "#1f1f1f" },
        horzLines: { color: "#1f1f1f" },
      },
      rightPriceScale: { borderColor: "#262626" },
      timeScale:       { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      crosshair:       { mode: 1 },
      autoSize:        true,
    });
    const series = chart.addSeries(LineSeries, {
      color: "#ffb800",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push new data whenever it changes.
  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points
      .filter((p) => p.value !== null && !Number.isNaN(p.value))
      .map((p) => ({
        time: (Date.parse(p.date) / 1000) as UTCTimestamp,
        value: p.value as number,
      }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  const latest = [...points].reverse().find((p) => p.value !== null);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>{label}</span>
        <span className="text-terminal-text normal-case tracking-normal">
          {latest?.value !== undefined && latest?.value !== null
            ? `${latest.value.toFixed(2)} ${unit}`
            : "—"}
        </span>
      </div>
      <div ref={elRef} className="flex-1 min-h-0" />
    </div>
  );
}
