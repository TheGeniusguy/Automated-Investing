/**
 * Relative Strength Momentum Chart for a sector vs SPY.
 *
 * Two line series:
 *   - 20D RS Momentum (amber) — etf/spy ratio vs 20 trading days ago
 *   - 60D RS Momentum (green) — etf/spy ratio vs 60 trading days ago
 * Plus a faint raw RS normalization line (gray).
 *
 * A dashed baseline at 1.0 marks parity with SPY.
 * Values above 1.0 = outperforming; below = underperforming.
 */
import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { SectorRsResponse } from "../api/types";

interface Props {
  data: SectorRsResponse;
}

const COLORS: Record<string, string> = {
  rs_raw:  "#374151",  // gray-700 — subtle background context
  rs_20d:  "#ffb800",  // amber
  rs_60d:  "#4ade80",  // green
};

export function SectorRsChart({ data }: Props) {
  const elRef    = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<"Line">[]>([]);

  // Init chart once
  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background:  { color: "transparent" },
        textColor:   "#8b8b8b",
        fontFamily:  "JetBrains Mono, monospace",
        fontSize:    10,
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

    // Create a series per RS series key
    const keys = ["rs_raw", "rs_20d", "rs_60d"];
    const refs: ISeriesApi<"Line">[] = keys.map((key) =>
      chart.addSeries(LineSeries, {
        color:            COLORS[key] ?? "#ffffff",
        lineWidth:        key === "rs_raw" ? 1 : 2,
        lineStyle:        key === "rs_raw" ? 2 : 0,  // dashed for raw
        priceLineVisible: false,
        lastValueVisible: key !== "rs_raw",
        crosshairMarkerVisible: key !== "rs_raw",
      })
    );

    // Baseline at 1.0
    const baseline = chart.addSeries(LineSeries, {
      color:            "#374151",
      lineWidth:        1,
      lineStyle:        1,  // dotted
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current   = chart;
    seriesRefs.current = [...refs, baseline];

    return () => {
      chart.remove();
      chartRef.current   = null;
      seriesRefs.current = [];
    };
  }, []);

  // Push data on update
  useEffect(() => {
    if (!chartRef.current || seriesRefs.current.length < 4) return;
    const keys = ["rs_raw", "rs_20d", "rs_60d"];

    keys.forEach((key, idx) => {
      const series = data.series.find((s) => s.key === key);
      if (!series) return;
      const chartData = series.points
        .filter((p) => p.value != null)
        .map((p) => ({
          time:  (Date.parse(p.date) / 1000) as UTCTimestamp,
          value: p.value,
        }));
      seriesRefs.current[idx]?.setData(chartData);
    });

    // Baseline: span the full date range at y=1.0
    const allPoints = data.series.flatMap((s) => s.points);
    if (allPoints.length >= 2) {
      const sorted = [...allPoints].sort((a, b) => a.date.localeCompare(b.date));
      const first = sorted[0];
      const last  = sorted[sorted.length - 1];
      seriesRefs.current[3]?.setData([
        { time: (Date.parse(first.date) / 1000) as UTCTimestamp, value: 1.0 },
        { time: (Date.parse(last.date)  / 1000) as UTCTimestamp, value: 1.0 },
      ]);
    }

    chartRef.current.timeScale().fitContent();
  }, [data]);

  const { rs_20d, rs_60d } = data.current;
  const fmt = (v: number | null | undefined) =>
    v == null ? "--" : v >= 1 ? `+${((v - 1) * 100).toFixed(1)}%` : `${((v - 1) * 100).toFixed(1)}%`;
  const col = (v: number | null | undefined) =>
    v == null ? "#6b7280" : v >= 1 ? "#4ade80" : "#f87171";

  return (
    <div className="flex flex-col" style={{ height: 200 }}>
      {/* Legend row */}
      <div className="flex items-center gap-4 px-1 pb-1 text-2xs">
        <span className="text-terminal-dim">
          {data.etf} vs {data.benchmark} — Relative Strength
        </span>
        <span style={{ color: "#ffb800" }}>
          20D: <span style={{ color: col(rs_20d) }}>{fmt(rs_20d)}</span>
        </span>
        <span style={{ color: "#4ade80" }}>
          60D: <span style={{ color: col(rs_60d) }}>{fmt(rs_60d)}</span>
        </span>
        {data.outperforming_20d != null && (
          <span className={data.outperforming_20d ? "text-green-400" : "text-rose-400"}>
            {data.outperforming_20d ? "▲ Outperforming (20D)" : "▼ Underperforming (20D)"}
          </span>
        )}
      </div>
      <div ref={elRef} className="flex-1" />
    </div>
  );
}
