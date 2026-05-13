import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { RegimeSegment, SeriesPoint } from "../api/types";

interface Props {
  spx: SeriesPoint[];
  segments: RegimeSegment[];
}

const REGIME_COLORS: Record<RegimeSegment["label"], string> = {
  risk_on:    "#22c55e",
  risk_off:   "#ef4444",
  transition: "#ffb800",
};

/**
 * SPX line chart with a regime-color ribbon directly beneath it. Both share
 * the same date range so the ribbon visually labels each historical period.
 */
export function RegimeTimelineChart({ spx, segments }: Props) {
  const chartEl = useRef<HTMLDivElement>(null);
  const ribbonEl = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // Chart init
  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
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
      color: "#e5e5e5",
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

  // Push new data
  useEffect(() => {
    if (!seriesRef.current) return;
    const data = spx
      .filter((p) => p.value !== null && !Number.isNaN(p.value))
      .map((p) => ({
        time: (Date.parse(p.date) / 1000) as UTCTimestamp,
        value: p.value as number,
      }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [spx]);

  // Ribbon positioning is keyed to the SPX date range so it lines up under
  // the chart's body. We don't try to track the chart's pan/zoom — this is a
  // static "fitContent" view, which matches the rest of the terminal.
  const ribbon = buildRibbonStops(segments, spx);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>SPX with Regime Overlay</span>
        <RibbonLegend />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <div ref={chartEl} className="flex-1 min-h-0" />
        <div
          ref={ribbonEl}
          className="h-4 flex border-t border-terminal-divider relative shrink-0"
          aria-label="regime ribbon"
        >
          {ribbon.map((seg, i) => (
            <div
              key={i}
              title={`${seg.label} · ${seg.start} → ${seg.end}`}
              style={{
                flexBasis: `${seg.weight * 100}%`,
                background: REGIME_COLORS[seg.label],
                opacity: 0.7,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RibbonLegend() {
  return (
    <span className="flex items-center gap-2 normal-case tracking-normal text-terminal-muted">
      <Swatch color={REGIME_COLORS.risk_on}    label="risk-on" />
      <Swatch color={REGIME_COLORS.transition} label="transition" />
      <Swatch color={REGIME_COLORS.risk_off}   label="risk-off" />
    </span>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Convert segments to flex-basis weights keyed to the SPX date span,
 *  so the ribbon physically lines up with the chart's time axis. */
function buildRibbonStops(
  segments: RegimeSegment[],
  spx: SeriesPoint[],
): { label: RegimeSegment["label"]; start: string; end: string; weight: number }[] {
  if (!spx.length || !segments.length) return [];

  const first = Date.parse(spx[0].date);
  const last = Date.parse(spx[spx.length - 1].date);
  const span = Math.max(1, last - first);

  return segments
    .map((s) => {
      const segStart = Math.max(first, Date.parse(s.start));
      const segEnd   = Math.min(last, Date.parse(s.end));
      const weight = Math.max(0, (segEnd - segStart) / span);
      return { label: s.label, start: s.start, end: s.end, weight };
    })
    .filter((s) => s.weight > 0);
}
