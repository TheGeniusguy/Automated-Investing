import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { MacroSeriesDetail as Detail, MacroTransform } from "../api/types";

const TRANSFORMS: { id: MacroTransform; label: string; help: string }[] = [
  { id: "level",        label: "Level",        help: "Raw series level" },
  { id: "yoy",          label: "YoY %",        help: "12-month % change" },
  { id: "mom",          label: "MoM %",        help: "1-month % change" },
  { id: "three_m_ann",  label: "3m ann",       help: "3-month annualized % change" },
  { id: "six_m_ann",    label: "6m ann",       help: "6-month annualized % change" },
  { id: "log_diff",     label: "Log diff",     help: "Log of period-over-period ratio" },
  { id: "z_score",      label: "Rolling Z",    help: "60-month rolling z-score" },
  { id: "percentile",   label: "Percentile",   help: "Percentile rank vs full history" },
  { id: "detrend",      label: "Detrend",      help: "Residual from OLS linear fit" },
];

const YEAR_OPTIONS = [5, 10, 20, 40];

export function MacroSeriesDetail({
  seriesId, onClose,
}: { seriesId: string; onClose?: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [transform, setTransform] = useState<MacroTransform>("level");
  const [years, setYears] = useState<number>(20);

  useEffect(() => {
    let alive = true;
    setErr(null);
    api.macroSeriesDetail(seriesId, transform, years)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [seriesId, transform, years]);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>{seriesId}</span></div>
        <div className="panel-body text-accent-red">⚠ {err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>{seriesId}</span></div>
        <div className="panel-body text-terminal-dim">loading…</div>
      </div>
    );
  }

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <div className="flex flex-col">
          <span>{data.label}</span>
          <span className="normal-case tracking-normal text-2xs text-terminal-dim">
            {data.series_id} · {data.unit} · {data.frequency}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} className="normal-case tracking-normal text-terminal-muted hover:text-accent-red text-2xs">
            close
          </button>
        )}
      </div>

      <div className="px-3 py-2 border-b border-terminal-divider flex flex-wrap items-center gap-1 text-2xs">
        <span className="text-terminal-muted uppercase tracking-wider mr-1">transform</span>
        <select
          value={transform} onChange={(e) => setTransform(e.target.value as MacroTransform)}
          className="bg-terminal-panel border border-terminal-divider text-2xs text-terminal-text px-1 py-0.5 normal-case"
        >
          {TRANSFORMS.map((t) => <option key={t.id} value={t.id} title={t.help}>{t.label}</option>)}
        </select>
        <span className="ml-2 text-terminal-muted uppercase tracking-wider mr-1">window</span>
        {YEAR_OPTIONS.map((y) => (
          <button key={y}
            onClick={() => setYears(y)}
            className={"pill " + (years === y ? "bg-accent-amber/20 text-accent-amber" : "text-terminal-muted")}
          >
            {y}y
          </button>
        ))}
      </div>

      <DetailChart points={data.points} transform={transform} />

      <StatsBar stats={data.stats} unit={data.unit} />

      {data.note && (
        <div className="px-3 py-2 border-t border-terminal-divider text-2xs text-terminal-muted leading-relaxed">
          {data.note}
        </div>
      )}
    </div>
  );
}

function DetailChart({
  points, transform,
}: { points: { date: string; value: number | null }[]; transform: MacroTransform }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono", fontSize: 10 },
      grid: { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    const s = chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 1 });
    chartRef.current = chart;
    seriesRef.current = s;
    return () => { chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points
      .filter((p) => p.value !== null)
      .map((p) => ({ time: (Date.parse(p.date) / 1000) as UTCTimestamp, value: p.value as number }));
    seriesRef.current.setData(data);
    // Add a zero line for divergent transforms
    if (["yoy", "mom", "three_m_ann", "six_m_ann", "log_diff", "z_score", "detrend"].includes(transform)) {
      try {
        seriesRef.current.createPriceLine({
          price: 0, color: "#666", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: false, title: "",
        });
      } catch { /* duplicate creates throw, ignore */ }
    }
    chartRef.current?.timeScale().fitContent();
  }, [points, transform]);

  return <div ref={elRef} className="flex-1 min-h-0" />;
}

function StatsBar({ stats, unit }: { stats: Detail["stats"]; unit: string }) {
  if (!stats || stats.count === 0) return null;
  return (
    <div className="border-t border-terminal-divider px-3 py-2 grid grid-cols-4 gap-2 text-2xs">
      <Stat label="last"  v={stats.last}      unit={unit} />
      <Stat label="mean"  v={stats.mean}      unit={unit} />
      <Stat label="std"   v={stats.std}       unit={unit} />
      <Stat label="z (5y)"v={stats.z_5y ?? null} />
      <Stat label="pct"   v={stats.percentile ?? null} unit="%" />
      <Stat label="min"   v={stats.min}       unit={unit} />
      <Stat label="max"   v={stats.max}       unit={unit} />
      <Stat label="n"     v={stats.count}     />
    </div>
  );
}

function Stat({ label, v, unit = "" }: { label: string; v: number | null | undefined; unit?: string }) {
  return (
    <div>
      <div className="text-terminal-muted uppercase tracking-wider">{label}</div>
      <div className="text-terminal-text tabular-nums">
        {v === null || v === undefined ? "—" : `${fmt(v)} ${unit}`.trim()}
      </div>
    </div>
  );
}

function fmt(v: number) {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "k";
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(3);
}
