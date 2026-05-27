import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type {
  CurvePoint,
  YieldCurveDashboard,
  YieldCurve,
  SpreadSeries,
  RecessionProbabilityPoint,
} from "../api/types";

/**
 * Yield Curve Panel — Wave 5.
 *
 * Layout: full curve plot (left) | spreads stack + recession dial + term premium (right).
 * The curve plot has a historical-date slider so you can replay any past curve
 * vs today's overlay.
 */
export function YieldCurvePanel() {
  const [dash, setDash] = useState<YieldCurveDashboard | null>(null);
  const [historical, setHistorical] = useState<YieldCurve | null>(null);
  const [histDate, setHistDate] = useState<string>("");
  const [showReal, setShowReal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.yieldCurveDashboard()
      .then((d) => { if (alive) setDash(d); })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!histDate) { setHistorical(null); return; }
    let alive = true;
    api.yieldCurveHistorical(histDate, showReal)
      .then((c) => { if (alive) setHistorical(c); })
      .catch(() => alive && setHistorical(null));
    return () => { alive = false; };
  }, [histDate, showReal]);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Yield Curve</span></div>
        <div className="panel-body text-accent-red">⚠ {err}</div>
      </div>
    );
  }
  if (!dash) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Yield Curve</span></div>
        <div className="panel-body text-terminal-dim">loading…</div>
      </div>
    );
  }

  const curve = showReal ? dash.real_curve : dash.curve;

  return (
    <div className="grid grid-cols-3 gap-2 h-full">
      <div className="col-span-2 flex flex-col gap-2 min-h-0">
        <CurvePlot
          curve={curve}
          historical={historical}
          showReal={showReal}
          setShowReal={setShowReal}
          histDate={histDate}
          setHistDate={setHistDate}
        />
        <CurveShapeBar dash={dash} />
      </div>

      <div className="col-span-1 flex flex-col gap-2 min-h-0 overflow-auto">
        <RecessionDial current={dash.recession.current} history={dash.recession.history} />
        <SpreadsStack spreads={dash.spreads} />
        <TermPremiumCard
          points={dash.term_premium.points}
          summary={dash.term_premium.summary}
        />
        <ButterfliesStack butterflies={dash.butterflies} />
      </div>
    </div>
  );
}

// ───────── Curve plot (SVG, simple, fast) ─────────

function CurvePlot({
  curve, historical, showReal, setShowReal, histDate, setHistDate,
}: {
  curve: YieldCurve;
  historical: YieldCurve | null;
  showReal: boolean;
  setShowReal: (b: boolean) => void;
  histDate: string;
  setHistDate: (s: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 700, h: 280 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      setSize({ w: Math.max(300, e.contentRect.width), h: Math.max(180, e.contentRect.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    return curve.points
      .map((p) => ({ ...p, yield: p.yield as number | null }))
      .filter((p) => p.yield !== null);
  }, [curve]);

  const histData = useMemo(() => {
    if (!historical) return [];
    return historical.points.filter((p) => p.yield !== null);
  }, [historical]);

  const allValues = [
    ...data.map((p) => p.yield as number),
    ...histData.map((p) => p.yield as number),
  ];
  const yMin = Math.min(...allValues, 0);
  const yMax = Math.max(...allValues, 1) * 1.1;
  const padding = { l: 40, r: 12, t: 16, b: 28 };
  const innerW = size.w - padding.l - padding.r;
  const innerH = size.h - padding.t - padding.b;

  const xScale = (years: number) =>
    padding.l + (Math.log10(years + 0.01) - Math.log10(0.08)) / (Math.log10(30) - Math.log10(0.08)) * innerW;
  const yScale = (yld: number) =>
    padding.t + innerH - ((yld - yMin) / (yMax - yMin || 1)) * innerH;

  const buildPath = (pts: { years: number; yield: number | null }[]) =>
    pts
      .filter((p) => p.yield !== null)
      .map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.years)},${yScale(p.yield as number)}`)
      .join(" ");

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const step = (yMax - yMin) / 5;
    for (let i = 0; i <= 5; i++) ticks.push(yMin + i * step);
    return ticks;
  }, [yMin, yMax]);

  return (
    <div className="panel flex-1 min-h-0 flex flex-col">
      <div className="panel-header">
        <span>
          {showReal ? "Real (TIPS) Curve" : "Nominal Treasury Curve"}
          <span className="normal-case tracking-normal text-terminal-dim ml-2">
            {curve.date ?? "—"}
          </span>
        </span>
        <div className="flex items-center gap-2 normal-case tracking-normal text-2xs">
          <button
            onClick={() => setShowReal(false)}
            className={"pill " + (!showReal ? "bg-accent-amber/20 text-accent-amber" : "text-terminal-muted")}
          >
            nominal
          </button>
          <button
            onClick={() => setShowReal(true)}
            className={"pill " + (showReal ? "bg-accent-amber/20 text-accent-amber" : "text-terminal-muted")}
          >
            real
          </button>
          <input
            type="date"
            value={histDate}
            onChange={(e) => setHistDate(e.target.value)}
            className="bg-terminal-panel border border-terminal-divider text-2xs px-1 py-0.5"
          />
          {histDate && (
            <button onClick={() => setHistDate("")} className="text-terminal-dim hover:text-accent-red">✕</button>
          )}
        </div>
      </div>
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <svg width={size.w} height={size.h}>
          {/* y gridlines */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={padding.l} x2={size.w - padding.r}
                y1={yScale(t)} y2={yScale(t)}
                stroke="#1f1f1f"
              />
              <text x={4} y={yScale(t) + 4} fill="#8b8b8b" fontSize={10} fontFamily="monospace">
                {t.toFixed(2)}
              </text>
            </g>
          ))}
          {/* maturity ticks */}
          {data.map((p) => (
            <g key={p.maturity}>
              <line
                x1={xScale(p.years)} x2={xScale(p.years)}
                y1={padding.t} y2={size.h - padding.b}
                stroke="#1a1a1a"
              />
              <text
                x={xScale(p.years)} y={size.h - 8}
                fill="#8b8b8b" fontSize={10} textAnchor="middle" fontFamily="monospace"
              >
                {p.maturity}
              </text>
            </g>
          ))}

          {/* historical curve (if any) */}
          {historical && (
            <>
              <path d={buildPath(historical.points)} fill="none" stroke="#26a69a" strokeWidth={1.5} strokeDasharray="4 3" />
              {histData.map((p) => (
                <circle key={`h-${p.maturity}`} cx={xScale(p.years)} cy={yScale(p.yield as number)} r={2} fill="#26a69a" />
              ))}
            </>
          )}

          {/* current curve */}
          <path d={buildPath(curve.points)} fill="none" stroke="#ffb800" strokeWidth={2} />
          {data.map((p) => (
            <g key={p.maturity}>
              <circle cx={xScale(p.years)} cy={yScale(p.yield as number)} r={3} fill="#ffb800" />
              <title>
                {p.maturity}: {(p.yield as number).toFixed(3)}%
                {p.delta_bps !== null && p.delta_bps !== undefined ? ` (${p.delta_bps > 0 ? "+" : ""}${p.delta_bps.toFixed(1)} bps vs prior)` : ""}
              </title>
            </g>
          ))}

          {/* zero line */}
          {yMin < 0 && yMax > 0 && (
            <line
              x1={padding.l} x2={size.w - padding.r}
              y1={yScale(0)} y2={yScale(0)}
              stroke="#ef5350" strokeWidth={1} strokeDasharray="2 4"
            />
          )}
        </svg>
        <div className="absolute top-1 right-2 flex items-center gap-3 text-2xs text-terminal-dim">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-[#ffb800]" /> today
          </span>
          {historical && (
            <span className="flex items-center gap-1">
              <span className="w-3 h-0 border-t-2 border-dashed border-[#26a69a]" /> {historical.date}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── Curve shape summary bar ─────────

function CurveShapeBar({ dash }: { dash: YieldCurveDashboard }) {
  const s = dash.shape;
  const cls = s.classification;
  const clsColor =
    cls === "deeply inverted" ? "text-accent-red" :
    cls === "inverted"        ? "text-rose-400"   :
    cls === "flat"            ? "text-amber-400"  :
    cls === "steep"           ? "text-accent-green" :
                                "text-accent-amber";

  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Curve Shape · <span className={"normal-case tracking-normal " + clsColor}>{cls}</span></span>
      </div>
      <div className="panel-body grid grid-cols-3 gap-2 text-xs py-2">
        <ShapeStat label="10Y-2Y" v={s.spread_2_10_bps} suffix="bps" />
        <ShapeStat label="10Y-3M" v={s.spread_3m_10y_bps} suffix="bps" />
        <ShapeStat label="30Y-10Y" v={s.spread_10_30_bps} suffix="bps" />
      </div>
    </div>
  );
}

function ShapeStat({ label, v, suffix }: { label: string; v: number | null; suffix: string }) {
  const cls = v === null ? "text-terminal-dim" : v > 0 ? "text-accent-green" : "text-accent-red";
  return (
    <div className="flex flex-col items-center">
      <span className="text-2xs text-terminal-muted uppercase tracking-wider">{label}</span>
      <span className={"tabular-nums text-base " + cls}>
        {v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)} ${suffix}`}
      </span>
    </div>
  );
}

// ───────── Recession probability dial ─────────

function RecessionDial({
  current, history,
}: {
  current: { date: string | null; probability: number | null; summary: string; model?: string };
  history: RecessionProbabilityPoint[];
}) {
  const prob = current.probability ?? 0;
  const color = prob >= 0.7 ? "#ef4444" : prob >= 0.4 ? "#f97316" : prob >= 0.2 ? "#fbbf24" : "#22c55e";

  // Donut math
  const r = 36;
  const C = 2 * Math.PI * r;
  const dash = prob * C;

  // Mini history sparkline
  const chartEl = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono", fontSize: 9 },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "#1a1a1a" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const s = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 1 });
    chartRef.current = chart;
    seriesRef.current = s;
    return () => { chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = history.map((p) => ({
      time: (Date.parse(p.date) / 1000) as UTCTimestamp,
      value: p.probability * 100,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>NY Fed Recession Prob (12m)</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim" title={current.model}>
          {current.date ?? "—"}
        </span>
      </div>
      <div className="panel-body flex items-center gap-3 py-3">
        <svg width={96} height={96} viewBox="-48 -48 96 96">
          <circle r={r} fill="none" stroke="#262626" strokeWidth={8} />
          <circle
            r={r} fill="none" stroke={color} strokeWidth={8}
            strokeDasharray={`${dash} ${C - dash}`}
            transform="rotate(-90)"
            strokeLinecap="round"
          />
          <text x={0} y={5} textAnchor="middle" fontSize={14} fill={color} fontFamily="monospace">
            {(prob * 100).toFixed(0)}%
          </text>
        </svg>
        <div className="flex-1 text-2xs text-terminal-muted leading-relaxed">
          {current.summary}
        </div>
      </div>
      <div ref={chartEl} className="h-12 mx-2 mb-2" />
    </div>
  );
}

// ───────── Spreads stack ─────────

function SpreadsStack({ spreads }: { spreads: SpreadSeries[] }) {
  const [active, setActive] = useState<string>(spreads[0]?.id ?? "T10Y2Y");
  const selected = spreads.find((s) => s.id === active) ?? spreads[0];

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Spreads</span>
        <select
          value={active} onChange={(e) => setActive(e.target.value)}
          className="bg-terminal-panel border border-terminal-divider text-2xs text-terminal-text px-1 py-0.5 normal-case tracking-normal"
        >
          {spreads.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>
      <div className="panel-body py-2">
        <div className="text-2xs text-terminal-muted mb-1">{selected?.description}</div>
        <MiniLineChart points={selected?.points ?? []} color="#5fb878" height={56} />
      </div>
    </div>
  );
}

function ButterfliesStack({ butterflies }: { butterflies: SpreadSeries[] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Butterflies</span>
      </div>
      <div className="panel-body space-y-2 py-2">
        {butterflies.map((bf) => {
          const last = [...bf.points].reverse().find((p) => p.value !== null)?.value;
          return (
            <div key={bf.id}>
              <div className="flex justify-between text-2xs">
                <span className="text-terminal-muted">{bf.id}</span>
                <span className="text-accent-amber tabular-nums">
                  {last === null || last === undefined ? "—" : (last * 100).toFixed(1) + " bps"}
                </span>
              </div>
              <MiniLineChart points={bf.points} color="#a78bfa" height={32} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TermPremiumCard({ points, summary }: { points: { date: string; value: number | null }[]; summary: string | null }) {
  const last = [...points].reverse().find((p) => p.value !== null)?.value;
  return (
    <div className="panel">
      <div className="panel-header">
        <span>10Y Term Premium (proxy)</span>
        <span className="normal-case tracking-normal text-accent-amber tabular-nums">
          {last === undefined || last === null ? "—" : last.toFixed(3) + "%"}
        </span>
      </div>
      <div className="panel-body py-2">
        <div className="text-2xs text-terminal-muted mb-1">{summary ?? "DGS10 − DFII10 − T10YIE"}</div>
        <MiniLineChart points={points} color="#fb7185" height={56} />
      </div>
    </div>
  );
}

function MiniLineChart({
  points, color, height,
}: { points: { date: string; value: number | null }[]; color: string; height: number }) {
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
    return () => { chart.remove(); };
  }, [color]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points
      .filter((p) => p.value !== null)
      .map((p) => ({ time: (Date.parse(p.date) / 1000) as UTCTimestamp, value: p.value as number }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={elRef} style={{ height }} />;
}

export function getPointSegments(pts: CurvePoint[]) { return pts; }  // ensure export reachable
