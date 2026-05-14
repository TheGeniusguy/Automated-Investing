import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { MacroTile as TileData } from "../api/types";

interface Props {
  tile: TileData;
  onClick?: (t: TileData) => void;
  selected?: boolean;
}

/**
 * Compact tile for a single time-series indicator: label, latest value with
 * unit, change vs prior, and a sparkline. Used by the Macro Explorer, Energy,
 * and Shipping panels.
 */
export function MacroTileCard({ tile, onClick, selected }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor:  "transparent",
        fontFamily: "JetBrains Mono, monospace",
        fontSize:   8,
      },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      rightPriceScale: { borderColor: "transparent", visible: false },
      timeScale:       { borderColor: "transparent", visible: false },
      crosshair:       { mode: 0 },
      autoSize:        true,
      handleScale:     false,
      handleScroll:    false,
    });
    seriesRef.current = chart.addSeries(LineSeries, {
      color: "#ffb800",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = (tile.trail ?? [])
      .filter((p) => p.value !== null && p.value !== undefined && !Number.isNaN(p.value))
      .map((p) => ({
        time:  (Date.parse(p.date) / 1000) as UTCTimestamp,
        value: p.value as number,
      }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();

    // Color the sparkline by trend direction
    if (data.length >= 2) {
      const first = data[0].value;
      const last  = data[data.length - 1].value;
      const color = last > first ? "#22c55e" : last < first ? "#ef4444" : "#8b8b8b";
      seriesRef.current.applyOptions({ color });
    }
  }, [tile.trail]);

  const delta = tile.delta_pct;
  const deltaCls =
    delta === null || delta === undefined ? "text-terminal-dim"
      : delta > 0 ? "text-accent-green"
      : delta < 0 ? "text-accent-red"
      : "text-terminal-muted";
  const deltaText =
    delta === null || delta === undefined ? "—"
      : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`;

  return (
    <button
      type="button"
      onClick={() => onClick?.(tile)}
      className={
        "panel text-left transition w-full " +
        (selected
          ? "border-accent-amber/60 ring-1 ring-accent-amber/20"
          : "hover:border-terminal-muted")
      }
      title={tile.note || tile.label}
    >
      <div className="panel-header" style={{ minHeight: 0 }}>
        <span className="truncate" style={{ maxWidth: "12rem" }}>{tile.label}</span>
        <span className="normal-case tracking-normal text-terminal-dim">{tile.unit || tile.id}</span>
      </div>
      <div className="px-3 py-2 flex items-baseline gap-2">
        <span className="text-base text-accent-amber tabular-nums">
          {tile.latest === null || tile.latest === undefined
            ? "—"
            : fmtNumber(tile.latest)}
        </span>
        <span className={`text-xs tabular-nums ${deltaCls}`}>{deltaText}</span>
        {tile.latest_date && (
          <span className="text-2xs text-terminal-dim ml-auto whitespace-nowrap">
            {tile.latest_date.slice(0, 10)}
          </span>
        )}
      </div>
      <div ref={elRef} className="h-10 mx-2 mb-2" />
    </button>
  );
}

function fmtNumber(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(2) + "k";
  if (Math.abs(v) >= 100)       return v.toFixed(1);
  if (Math.abs(v) >= 10)        return v.toFixed(2);
  return v.toFixed(3);
}
