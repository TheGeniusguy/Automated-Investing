import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { RecessionDashboard as Dashboard } from "../api/types";

export function RecessionDashboard() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [nowcast, setNowcast] = useState<import("../api/types").NowcastDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.recessionDashboard(), api.nowcastDashboard()])
      .then(([r, n]) => { if (!alive) return; setDash(r); setNowcast(n); })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) return <ErrPanel title="Recession Dashboard" err={err} />;
  if (!dash) return <LoadingPanel title="Recession Dashboard" />;

  const comp = dash.composite;
  return (
    <div className="grid grid-cols-3 gap-2 h-full">
      <div className="col-span-1 flex flex-col gap-2 min-h-0 overflow-auto">
        <CompositeMeter composite={comp.composite} bucket={comp.bucket} />
        <ComponentsList components={comp.components} />
        {nowcast && <GdpNowCard data={nowcast.atlanta_fed} />}
        {nowcast && <NowcastComposite data={nowcast.composite} />}
      </div>

      <div className="col-span-2 grid grid-cols-2 grid-rows-3 gap-2 min-h-0">
        <SahmCard data={dash.sahm} />
        <NyFedCard data={dash.nyfed} />
        <LeiCard data={dash.lei_proxy} />
        <ClaimsCard data={dash.claims} />
        <IndProCard label="Industrial Production YoY" data={dash.industrial} color="#ef4444" />
        <IndProCard label="Real Retail Sales YoY" data={dash.real_retail} color="#fb7185" />
      </div>
    </div>
  );
}

// ---------- Composite meter ----------

function CompositeMeter({ composite, bucket }: { composite: number | null; bucket: string }) {
  const score = composite ?? 0;
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "#ef4444" : score >= 0.5 ? "#f97316" : score >= 0.3 ? "#fbbf24" : "#22c55e";

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Composite</span>
        <span className="normal-case tracking-normal text-2xs" style={{ color }}>{bucket}</span>
      </div>
      <div className="panel-body py-3">
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-3xl tabular-nums" style={{ color }}>{pct}</span>
          <span className="text-2xs text-terminal-muted">/ 100 pressure</span>
        </div>
        <div className="h-2 bg-terminal-divider rounded">
          <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
        </div>
      </div>
    </div>
  );
}

function ComponentsList({
  components,
}: { components: { label: string; value: number | null; score: number | null }[] }) {
  return (
    <div className="panel">
      <div className="panel-header"><span>Component Scores</span></div>
      <div className="panel-body p-0 divide-y divide-terminal-divider text-xs">
        {components.map((c) => (
          <div key={c.label} className="px-3 py-2">
            <div className="flex justify-between text-2xs">
              <span className="text-terminal-text">{c.label}</span>
              <span className="text-accent-amber tabular-nums">
                {c.value === null ? "—" : c.value.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 h-1.5 bg-terminal-divider rounded">
              {c.score !== null && (
                <div
                  className="h-full rounded"
                  style={{
                    width: `${Math.round(c.score * 100)}%`,
                    background: c.score >= 0.6 ? "#ef4444" : c.score >= 0.3 ? "#f97316" : "#22c55e",
                  }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Individual indicator cards ----------

function SahmCard({ data }: { data: Dashboard["sahm"] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Sahm Rule</span>
        <span className={"normal-case tracking-normal text-2xs " + (data.triggered ? "text-rose-400" : "text-terminal-muted")}>
          {data.triggered ? "TRIGGERED" : "armed"}
        </span>
      </div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xl text-accent-amber tabular-nums">{data.current?.toFixed(2) ?? "—"}</span>
          <span className="text-2xs text-terminal-muted">pp · trigger 0.50</span>
        </div>
        <MiniLine
          points={data.history.map((h) => ({ date: h.date, value: h.value }))}
          color="#ef4444"
          threshold={data.threshold}
          height={48}
        />
      </div>
    </div>
  );
}

function NyFedCard({ data }: { data: Dashboard["nyfed"] }) {
  const prob = data.current.probability ?? 0;
  return (
    <div className="panel">
      <div className="panel-header">
        <span>NY Fed Prob (12m)</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-muted">{data.current.date ?? "—"}</span>
      </div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xl tabular-nums" style={{ color: prob > 0.4 ? "#ef4444" : "#ffb800" }}>
            {(prob * 100).toFixed(1)}%
          </span>
        </div>
        <MiniLine
          points={data.history.map((h) => ({ date: h.date, value: h.probability * 100 }))}
          color="#ef5350" height={48}
        />
      </div>
    </div>
  );
}

function LeiCard({ data }: { data: Dashboard["lei_proxy"] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>LEI proxy (z)</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-muted">{data.summary}</span>
      </div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2 mb-1">
          <span className={"text-xl tabular-nums " + ((data.current ?? 0) >= 0 ? "text-accent-green" : "text-rose-400")}>
            {data.current === null ? "—" : data.current.toFixed(2)}σ
          </span>
        </div>
        <MiniLine points={data.history} color="#26a69a" height={48} threshold={0} />
      </div>
    </div>
  );
}

function ClaimsCard({ data }: { data: Dashboard["claims"] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Initial Claims YoY</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-muted">
          MA {data.current_ma?.toFixed(0) ?? "—"}
        </span>
      </div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2 mb-1">
          <span className={"text-xl tabular-nums " + ((data.current_yoy ?? 0) > 0 ? "text-rose-400" : "text-accent-green")}>
            {data.current_yoy === null ? "—" : (data.current_yoy > 0 ? "+" : "") + data.current_yoy.toFixed(1) + "%"}
          </span>
        </div>
        <MiniLine points={data.history.map((h) => ({ date: h.date, value: h.value }))}
                  color="#fb7185" height={48} threshold={data.threshold} />
      </div>
    </div>
  );
}

function IndProCard({
  label, data, color,
}: {
  label: string;
  data: { current: number | null; history: { date: string; value: number | null }[]; summary: string };
  color: string;
}) {
  return (
    <div className="panel">
      <div className="panel-header"><span>{label}</span></div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2 mb-1">
          <span className={"text-xl tabular-nums " + ((data.current ?? 0) < 0 ? "text-rose-400" : "text-accent-green")}>
            {data.current === null ? "—" : (data.current > 0 ? "+" : "") + data.current.toFixed(2) + "%"}
          </span>
        </div>
        <MiniLine points={data.history} color={color} height={48} threshold={0} />
      </div>
    </div>
  );
}

function GdpNowCard({ data }: { data: import("../api/types").NowcastDashboard["atlanta_fed"] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Atlanta Fed GDPNow</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">{data.quarter ?? "—"}</span>
      </div>
      <div className="panel-body py-2 px-3">
        <div className="flex items-baseline gap-2">
          <span className={"text-2xl tabular-nums " + ((data.value ?? 0) < 0 ? "text-rose-400" : "text-accent-amber")}>
            {data.value === null ? "—" : (data.value > 0 ? "+" : "") + data.value.toFixed(2) + "%"}
          </span>
          <span className="text-2xs text-terminal-muted">SAAR</span>
        </div>
        <div className="text-2xs text-terminal-muted mt-1">{data.asof ?? ""}</div>
        <div className="text-2xs text-terminal-dim">{data.summary}</div>
      </div>
    </div>
  );
}

function NowcastComposite({ data }: { data: import("../api/types").NowcastDashboard["composite"] }) {
  const z = data.composite_z ?? 0;
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Activity Nowcast (z)</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">{data.summary}</span>
      </div>
      <div className="panel-body p-0 divide-y divide-terminal-divider text-xs">
        <div className="px-3 py-2">
          <span className={"text-2xl tabular-nums " + (z >= 0 ? "text-accent-green" : "text-rose-400")}>
            {z === null ? "—" : (z > 0 ? "+" : "") + z.toFixed(2)}σ
          </span>
        </div>
        {data.components.map((c) => (
          <div key={c.series_id} className="px-3 py-1.5 flex justify-between">
            <span className="text-terminal-text truncate" title={c.series_id}>{c.label}</span>
            <span className={"tabular-nums " + ((c.z ?? 0) >= 0 ? "text-accent-green" : "text-rose-400")}>
              {c.z === null ? "—" : (c.z > 0 ? "+" : "") + c.z.toFixed(2)}σ
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- mini-line + boilerplate ----------

function MiniLine({
  points, color, height, threshold,
}: {
  points: { date: string; value: number | null }[];
  color: string;
  height: number;
  threshold?: number;
}) {
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

function LoadingPanel({ title }: { title: string }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      <div className="panel-body text-terminal-dim">loading…</div>
    </div>
  );
}

function ErrPanel({ title, err }: { title: string; err: string }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      <div className="panel-body text-accent-red">⚠ {err}</div>
    </div>
  );
}
