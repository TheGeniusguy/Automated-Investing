import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type {
  InflationDashboard as Dashboard,
  InflationMomentumSeries,
} from "../api/types";

type Window = "yoy" | "mom_annualized" | "three_m_ann" | "six_m_ann";

const WINDOWS: { id: Window; label: string }[] = [
  { id: "yoy",            label: "YoY" },
  { id: "three_m_ann",    label: "3m ann" },
  { id: "six_m_ann",      label: "6m ann" },
  { id: "mom_annualized", label: "MoM ann" },
];

export function InflationDashboard() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [window, setWindow] = useState<Window>("yoy");

  useEffect(() => {
    let alive = true;
    api.inflationDashboard()
      .then((d) => alive && setDash(d))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) return <PanelErr err={err} title="Inflation" />;
  if (!dash) return <PanelLoading title="Inflation" />;

  return (
    <div className="grid grid-cols-3 gap-2 h-full">
      <div className="col-span-2 flex flex-col gap-2 min-h-0">
        <RegimeHeader dash={dash} />
        <div className="flex items-center gap-1 text-2xs">
          <span className="text-terminal-muted uppercase tracking-wider mr-2">window</span>
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWindow(w.id)}
              className={"pill " + (w.id === window ? "bg-accent-amber/20 text-accent-amber" : "text-terminal-muted")}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 flex-1 min-h-0 overflow-auto">
          {dash.series.map((s) => (
            <InflationSeriesCard key={s.series_id} s={s} window={window} />
          ))}
        </div>
      </div>

      <div className="col-span-1 flex flex-col gap-2 min-h-0 overflow-auto">
        <ExpectationsCard expectations={dash.expectations.points} />
        <DecompositionCard nominal={dash.decomposition.nominal}
                           real={dash.decomposition.real}
                           breakeven={dash.decomposition.breakeven} />
      </div>
    </div>
  );
}

function RegimeHeader({ dash }: { dash: Dashboard }) {
  const s = dash.summary;
  const cls = dash.classification;
  const cBadge =
    cls.label.includes("hot")               ? "bg-rose-500/20 text-rose-300"   :
    cls.label.includes("above_target")      ? "bg-amber-500/20 text-amber-300" :
    cls.label === "near_target"             ? "bg-green-500/20 text-green-300" :
    cls.label === "below_target"            ? "bg-sky-500/20 text-sky-300"     :
                                              "bg-blue-500/20 text-blue-300";
  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Inflation Regime</span>
        <span className={"pill normal-case tracking-normal text-2xs " + cBadge}>
          {cls.label.replace(/_/g, " ")}
        </span>
      </div>
      <div className="panel-body grid grid-cols-4 gap-3 text-xs py-2">
        <Stat label="Core PCE YoY" value={fmt(s.core_pce_yoy, "%")} cls="text-accent-amber" />
        <Stat label="Hdln PCE YoY" value={fmt(s.headline_pce_yoy, "%")} />
        <Stat label="Core 3m ann" value={fmt(s.core_pce_3m_ann, "%")} cls={s.core_pce_3m_ann !== null && s.core_pce_yoy !== null && s.core_pce_3m_ann > s.core_pce_yoy ? "text-rose-400" : "text-accent-green"} />
        <Stat label="Fed target" value={fmt(s.fed_target, "%")} cls="text-terminal-muted" />
      </div>
      <div className="px-3 pb-2 text-2xs text-terminal-muted">{cls.summary}</div>
    </div>
  );
}

function InflationSeriesCard({ s, window }: { s: InflationMomentumSeries; window: Window }) {
  const points = s.is_rate ? s.yoy : s[window] ?? [];
  const last = points.length ? points[points.length - 1] : null;
  const prev = points.length >= 13 ? points[points.length - 13] : null;
  const delta = last && prev && last.value !== null && prev.value !== null
    ? last.value - prev.value : null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span>{s.label ?? s.series_id}</span>
        <span className="normal-case tracking-normal text-terminal-dim text-2xs">{s.series_id}</span>
      </div>
      <div className="panel-body py-2">
        <div className="flex items-baseline gap-3 mb-1">
          <span className="text-xl text-accent-amber tabular-nums">
            {last && last.value !== null ? `${last.value.toFixed(2)}%` : "—"}
          </span>
          {delta !== null && (
            <span className={"text-2xs tabular-nums " + (delta > 0 ? "text-rose-400" : "text-accent-green")}>
              {delta > 0 ? "+" : ""}{delta.toFixed(2)}pp YoY
            </span>
          )}
          <span className="text-2xs text-terminal-dim ml-auto">{last?.date ?? "—"}</span>
        </div>
        <MiniLine points={points.map((p) => ({ ...p, value: p.value ?? null }))} color="#ffb800" height={64} threshold={2.0} />
      </div>
    </div>
  );
}

function ExpectationsCard({ expectations }: { expectations: Dashboard["expectations"]["points"] }) {
  return (
    <div className="panel">
      <div className="panel-header"><span>Inflation Expectations</span></div>
      <div className="panel-body py-1 divide-y divide-terminal-divider text-xs">
        {expectations.map((p) => (
          <div key={p.id} className="flex items-center justify-between px-3 py-1.5">
            <span className="text-terminal-text">{p.label}</span>
            <span className="text-accent-amber tabular-nums">
              {p.value === null ? "—" : `${p.value.toFixed(2)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecompositionCard({
  nominal, real, breakeven,
}: {
  nominal: { date: string; value: number | null }[];
  real: { date: string; value: number | null }[];
  breakeven: { date: string; value: number | null }[];
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    nom: ISeriesApi<"Line">;
    real: ISeriesApi<"Line">;
    be: ISeriesApi<"Line">;
  } | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono", fontSize: 9 },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "#1a1a1a" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const nom = chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 1, title: "10Y nominal" });
    const real = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 1, title: "10Y real" });
    const be = chart.addSeries(LineSeries, { color: "#fb7185", lineWidth: 1, title: "10Y breakeven" });
    chartRef.current = chart;
    seriesRef.current = { nom, real, be };
    return () => { chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const cv = (pts: { date: string; value: number | null }[]) =>
      pts.filter((p) => p.value !== null)
         .map((p) => ({ time: (Date.parse(p.date) / 1000) as UTCTimestamp, value: p.value as number }));
    seriesRef.current.nom.setData(cv(nominal));
    seriesRef.current.real.setData(cv(real));
    seriesRef.current.be.setData(cv(breakeven));
    chartRef.current?.timeScale().fitContent();
  }, [nominal, real, breakeven]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>10Y Decomposition</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">nominal = real + breakeven</span>
      </div>
      <div className="panel-body py-2 flex flex-col gap-2">
        <div className="flex gap-3 text-2xs text-terminal-muted">
          <Lg dot="#ffb800" label="nominal" />
          <Lg dot="#22c55e" label="real (TIPS)" />
          <Lg dot="#fb7185" label="breakeven" />
        </div>
        <div ref={elRef} className="h-32" />
      </div>
    </div>
  );
}

function Lg({ dot, label }: { dot: string; label: string }) {
  return <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: dot }} />{label}</span>;
}

function Stat({ label, value, cls = "text-terminal-text" }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-2xs text-terminal-muted uppercase tracking-wider">{label}</div>
      <div className={"tabular-nums " + cls}>{value}</div>
    </div>
  );
}

function fmt(v: number | null, suffix = "") {
  return v === null || v === undefined ? "—" : v.toFixed(2) + suffix;
}

function MiniLine({
  points, color, height, threshold,
}: { points: { date: string; value: number | null }[]; color: string; height: number; threshold?: number }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono", fontSize: 9 },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "#1a1a1a" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const s = chart.addSeries(LineSeries, { color, lineWidth: 1 });
    chartRef.current = chart;
    seriesRef.current = s;
    if (threshold !== undefined) {
      s.createPriceLine({ price: threshold, color: "#666", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    }
    return () => { chart.remove(); };
  }, [color, threshold]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points.filter((p) => p.value !== null).map((p) => ({
      time: (Date.parse(p.date) / 1000) as UTCTimestamp,
      value: p.value as number,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={elRef} style={{ height }} />;
}

function PanelErr({ err, title }: { err: string; title: string }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      <div className="panel-body text-accent-red">⚠ {err}</div>
    </div>
  );
}

function PanelLoading({ title }: { title: string }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      <div className="panel-body text-terminal-dim">loading…</div>
    </div>
  );
}
