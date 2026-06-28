import { useEffect, useRef, useState } from "react";
import {
  createChart,
  BaselineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ── Local mirror of the backend econ_surprise.py payload ──────────────────────
interface SurprisePoint {
  date: string;
  value: number | null;
}

interface SurpriseRelease {
  indicator: string;
  actual: number | null;
  consensus: number | null;
  surprise_z: number | null;
  date: string;
  unit: string;
}

interface SurpriseIndex {
  region: string;
  index_series: SurprisePoint[];
  latest: number;
  releases: SurpriseRelease[];
  beats: number;
  misses: number;
  data_mode: string;
  as_of: string;
  source: string;
}

const REGIONS: { key: string; label: string }[] = [
  { key: "US", label: "United States" },
  { key: "EU", label: "Euro Area" },
  { key: "CN", label: "China" },
];

const GREEN = "#5bb97f";
const RED = "#e5564b";

export function EconSurprisePanel() {
  const [region, setRegion] = useState("US");
  const [data, setData] = useState<SurpriseIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .econSurprise(region)
      .then((d: SurpriseIndex) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [region]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Economic Surprise Index</span>
        <div className="flex items-center gap-1">
          {REGIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRegion(r.key)}
              title={r.label}
              className={
                "pill normal-case tracking-normal text-2xs " +
                (r.key === region
                  ? "bg-accent-amber/20 text-accent-amber"
                  : "text-terminal-muted hover:text-terminal-text")
              }
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {err && (
          <div className="text-accent-red text-xs py-2">Could not load data. {err}</div>
        )}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-4">Loading surprise data...</div>
        )}

        {data && (
          <>
            <Hero data={data} />

            <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Surprise Index (180d)
              </div>
              <SurpriseChart series={data.index_series} />
              <div className="flex items-center gap-4 mt-2 px-1 text-2xs text-terminal-muted">
                <Legend color={GREEN} label="above consensus" />
                <Legend color={RED} label="below consensus" />
                <span className="ml-auto text-terminal-dim">zero = in line with forecasts</span>
              </div>
            </div>

            <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Recent Releases
              </div>
              <ReleasesTable releases={data.releases} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Hero figure + beats/misses tally ──────────────────────────────────────────
function Hero({ data }: { data: SurpriseIndex }) {
  const v = data.latest;
  const positive = v >= 0;
  const cls = positive ? "text-accent-green" : "text-accent-red";
  const regionLabel = REGIONS.find((r) => r.key === data.region)?.label ?? data.region;
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3 flex items-end gap-6 flex-wrap">
      <div>
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">
          {regionLabel} surprise
        </div>
        <div className={"stat-figure text-5xl leading-none " + cls}>
          {positive ? "+" : ""}
          {v.toFixed(1)}
        </div>
        <div className="text-2xs text-terminal-dim mt-1">
          {positive
            ? "Data running ahead of consensus"
            : "Data running behind consensus"}
        </div>
      </div>

      <div className="flex items-center gap-4 ml-auto">
        <Tally label="Beats" value={data.beats} cls="text-accent-green" />
        <Tally label="Misses" value={data.misses} cls="text-accent-red" />
        <Tally
          label="Tracked"
          value={data.releases.length}
          cls="text-terminal-text"
        />
      </div>
    </div>
  );
}

function Tally({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="text-center">
      <div className={"stat-figure text-2xl leading-none " + cls}>{value}</div>
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-3 h-0.5 rounded inline-block" style={{ background: color }} />
      {label}
    </span>
  );
}

// ── Surprise index time series (zero-baseline, green up / red down) ───────────
function SurpriseChart({ series }: { series: SurprisePoint[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      height: 220,
      layout: {
        background: { color: "transparent" },
        textColor: "#a39a8c",
        fontFamily: "JetBrains Mono",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: { color: "#2e2a24" },
      },
      rightPriceScale: { borderColor: "#2e2a24" },
      timeScale: { borderColor: "#2e2a24", timeVisible: false },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const s = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: GREEN,
      topFillColor1: "rgba(91, 185, 127, 0.28)",
      topFillColor2: "rgba(91, 185, 127, 0.02)",
      bottomLineColor: RED,
      bottomFillColor1: "rgba(229, 86, 75, 0.02)",
      bottomFillColor2: "rgba(229, 86, 75, 0.28)",
      lineWidth: 2,
    });
    s.createPriceLine({
      price: 0,
      color: "#6e665a",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: "",
    });
    chartRef.current = chart;
    seriesRef.current = s;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = series
      .filter((p) => p.value !== null)
      .map((p) => ({
        time: (Date.parse(p.date) / 1000) as UTCTimestamp,
        value: p.value as number,
      }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [series]);

  return <div ref={elRef} style={{ height: 220 }} />;
}

// ── Recent releases table ─────────────────────────────────────────────────────
function ReleasesTable({ releases }: { releases: SurpriseRelease[] }) {
  if (releases.length === 0) {
    return <div className="text-2xs text-terminal-dim">No recent releases.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Indicator</th>
            <th className="text-right py-1 px-2">Actual</th>
            <th className="text-right py-1 px-2">Consensus</th>
            <th className="text-center py-1 px-2">Surprise z</th>
            <th className="text-right py-1 px-2">Date</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((r, i) => (
            <tr key={`${r.indicator}-${i}`} className="border-t border-terminal-border/20">
              <td className="py-1.5 px-2 text-terminal-text">{r.indicator}</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-text">
                {fmtVal(r.actual, r.unit)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-muted">
                {fmtVal(r.consensus, r.unit)}
              </td>
              <td className="py-1.5 px-2 text-center">
                <ZChip z={r.surprise_z} />
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-terminal-dim">{r.date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ZChip({ z }: { z: number | null }) {
  if (z === null || Number.isNaN(z)) {
    return <span className="text-terminal-dim text-2xs">n/a</span>;
  }
  const positive = z >= 0;
  const cls = positive
    ? "bg-accent-green/15 text-accent-green"
    : "bg-accent-red/15 text-accent-red";
  return (
    <span className={"pill normal-case tracking-normal text-2xs tabular-nums " + cls}>
      {positive ? "+" : ""}
      {z.toFixed(2)}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtVal(v: number | null, unit: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  const num = v.toFixed(2);
  if (unit === "%") return `${num}%`;
  if (unit === "k") return `${num}k`;
  if (unit === "idx") return num;
  return num;
}
