import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

/**
 * Commodities Curve Panel (Wave D2 - CCRV).
 *
 * Reads /api/commodities/curves (api.commoditiesCurves). Renders a commodity
 * selector, a 12-month futures-curve line chart with a contango/backwardation
 * tag (green backwardation, red contango), front/second prices, a serif spot +
 * structure hero, and a cross-commodity roll table.
 *
 * Shapes are mirrored as LOCAL interfaces so this panel is self-describing and
 * does not depend on the shared types module.
 */

// -- Local mirrors of the backend payload (commodities_curve.py) -------------

interface CurvePoint {
  contract: string;
  months_out: number;
  price: number;
}

type Structure = "contango" | "backwardation" | "flat";

interface Commodity {
  symbol: string;
  name: string;
  unit: string;
  spot: number;
  curve: CurvePoint[];
  structure: Structure;
  roll_yield_pct: number;
  slope_pct: number;
  front_price: number;
  second_price: number;
}

interface CrossCommodity {
  symbol: string;
  name: string;
  unit: string;
  spot: number;
  structure: Structure;
  roll_yield_pct: number;
  slope_pct: number;
}

interface CommoditiesCurvesResponse {
  commodities: Commodity[];
  cross_commodity: CrossCommodity[];
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Formatting helpers ------------------------------------------------------

function fmtPrice(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtSignedPct(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function structureClasses(s: Structure): string {
  if (s === "backwardation") return "text-accent-green";
  if (s === "contango") return "text-accent-red";
  return "text-terminal-muted";
}

function structureChip(s: Structure): string {
  if (s === "backwardation") return "bg-accent-green/15 text-accent-green border-accent-green/40";
  if (s === "contango") return "bg-accent-red/15 text-accent-red border-accent-red/40";
  return "bg-terminal-border/30 text-terminal-muted border-terminal-border/60";
}

function structureLabel(s: Structure): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Curve line color tracks the structure read.
function curveColor(s: Structure): string {
  if (s === "backwardation") return "#34d399";
  if (s === "contango") return "#f87171";
  return "#9ca3af";
}

// -- Futures curve chart (months_out 1..12 on the x-axis) --------------------

function CurveChart({ commodity }: { commodity: Commodity }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 260,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      timeScale: { borderColor: "#374151", timeVisible: false, secondsVisible: false },
      rightPriceScale: { borderColor: "#374151" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const line = chart.addSeries(LineSeries, {
      color: curveColor(commodity.structure),
      lineWidth: 2,
      title: commodity.symbol,
    });

    // months_out 1..12 mapped to one synthetic monthly step each so the
    // forward strip reads left to right. Anchor a fixed base date so the
    // axis is stable across renders.
    const base = Date.UTC(2026, 0, 1) / 1000;
    const monthSecs = 30 * 24 * 60 * 60;
    line.setData(
      commodity.curve.map((p) => ({
        time: (base + p.months_out * monthSecs) as UTCTimestamp,
        value: p.price,
      })),
    );

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [commodity]);

  return <div ref={ref} />;
}

// -- Panel -------------------------------------------------------------------

export function CommoditiesCurvePanel() {
  const [data, setData] = useState<CommoditiesCurvesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState("CL");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.commoditiesCurves()
      .then((res) => {
        if (!alive) return;
        setData(res as unknown as CommoditiesCurvesResponse);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const active = useMemo(() => {
    if (!data) return null;
    return data.commodities.find((c) => c.symbol === selected) ?? data.commodities[0] ?? null;
  }, [data, selected]);

  if (err) {
    return (
      <div className="panel flex flex-col h-full">
        <div className="panel-header">
          <span className="text-xs font-semibold uppercase tracking-wider">Commodities Curve</span>
        </div>
        <div className="panel-body text-accent-red text-xs p-3">{err}</div>
      </div>
    );
  }

  if (loading || !data || !active) {
    return (
      <div className="panel flex flex-col h-full">
        <div className="panel-header">
          <span className="text-xs font-semibold uppercase tracking-wider">Commodities Curve</span>
        </div>
        <div className="panel-body text-terminal-dim text-xs p-3">loading...</div>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">Commodities Curve</span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Commodity selector */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-2xs text-terminal-dim uppercase mr-1">Contract:</span>
          {data.commodities.map((c) => (
            <button
              key={c.symbol}
              type="button"
              onClick={() => setSelected(c.symbol)}
              className={`pill text-2xs ${
                active.symbol === c.symbol
                  ? "bg-accent text-black"
                  : "text-terminal-dim hover:text-terminal-fg"
              }`}
            >
              {c.symbol}
            </button>
          ))}
        </div>

        {/* Serif hero: spot + structure */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3 flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="flex flex-col">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              {active.name}
            </span>
            <span className="stat-figure font-serif text-4xl leading-tight tabular-nums text-terminal-text">
              {fmtPrice(active.spot)}
            </span>
            <span className="text-2xs text-terminal-dim">{active.unit} spot</span>
          </div>

          <div className="flex flex-col">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">Structure</span>
            <span className={`font-serif text-3xl leading-tight ${structureClasses(active.structure)}`}>
              {structureLabel(active.structure)}
            </span>
            <span className="text-2xs text-terminal-dim">
              roll {fmtSignedPct(active.roll_yield_pct)} - 1y slope {fmtSignedPct(active.slope_pct)}
            </span>
          </div>

          <div className="flex-1" />

          <span
            className={`pill border text-2xs uppercase tracking-wider ${structureChip(active.structure)}`}
          >
            {structureLabel(active.structure)}
          </span>
        </div>

        {/* Futures curve chart */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              12-Month Futures Curve
            </span>
            <div className="flex items-center gap-3 text-2xs">
              <span className="text-terminal-dim">
                Front <span className="font-mono text-terminal-text">{fmtPrice(active.front_price)}</span>
              </span>
              <span className="text-terminal-dim">
                Second <span className="font-mono text-terminal-text">{fmtPrice(active.second_price)}</span>
              </span>
            </div>
          </div>
          <CurveChart commodity={active} />
        </div>

        {/* Cross-commodity roll table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
          <span className="text-2xs text-terminal-muted uppercase tracking-wider px-1">
            Cross-Commodity Roll
          </span>
          <table className="w-full text-2xs mt-1">
            <thead>
              <tr className="text-terminal-dim uppercase tracking-wider border-b border-terminal-border/50">
                <th className="text-left font-medium py-1 px-1">Symbol</th>
                <th className="text-left font-medium py-1 px-1">Name</th>
                <th className="text-left font-medium py-1 px-1">Structure</th>
                <th className="text-right font-medium py-1 px-1">Roll Yield</th>
                <th className="text-right font-medium py-1 px-1">1Y Slope</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.cross_commodity.map((c) => (
                <tr
                  key={c.symbol}
                  onClick={() => setSelected(c.symbol)}
                  className={`border-b border-terminal-border/20 cursor-pointer hover:bg-terminal-border/20 ${
                    active.symbol === c.symbol ? "bg-terminal-border/20" : ""
                  }`}
                >
                  <td className="py-1 px-1 text-terminal-text">{c.symbol}</td>
                  <td className="py-1 px-1 font-sans text-terminal-dim">{c.name}</td>
                  <td className={`py-1 px-1 ${structureClasses(c.structure)}`}>
                    {structureLabel(c.structure)}
                  </td>
                  <td className={`py-1 px-1 text-right ${c.roll_yield_pct >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtSignedPct(c.roll_yield_pct)}
                  </td>
                  <td className={`py-1 px-1 text-right ${c.slope_pct >= 0 ? "text-accent-red" : "text-accent-green"}`}>
                    {fmtSignedPct(c.slope_pct)}
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
