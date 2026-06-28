import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { RatePath, RateProbabilities } from "../api/types";

/**
 * Fed Rate Path Panel - mirrors Bloomberg WIRP + CME FedWatch + FFV.
 *
 * Layout: three serif hero cards (current target, terminal rate, cuts priced 12m),
 * a stepped implied-path chart (TradingView), and the signature FedWatch-style
 * per-meeting probability ladder (CSS stacked bars: cut red / hold green / hike blue).
 */
export function RatePathPanel() {
  const [path, setPath] = useState<RatePath | null>(null);
  const [probs, setProbs] = useState<RateProbabilities | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.ratePath(), api.rateProbabilities()])
      .then(([p, pr]) => {
        if (!alive) return;
        setPath(p);
        setProbs(pr);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Fed Rate Path</span></div>
        <div className="panel-body text-accent-red">{err}</div>
      </div>
    );
  }
  if (!path) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Fed Rate Path</span></div>
        <div className="panel-body text-terminal-dim">loading...</div>
      </div>
    );
  }

  const ladder = probs?.meetings ?? path.implied_path.map((p) => ({
    date: p.date,
    cut: p.cut,
    hold: p.hold,
    hike: p.hike,
    implied_rate: p.implied_rate,
  }));

  return (
    <div className="grid grid-cols-3 gap-2 h-full min-h-0">
      {/* Left: hero stats + step chart */}
      <div className="col-span-2 flex flex-col gap-2 min-h-0">
        <div className="grid grid-cols-3 gap-2 flex-shrink-0">
          <HeroCard
            label="Current Target"
            value={fmtPct(path.current_target)}
            sub="upper bound"
            tone="amber"
          />
          <HeroCard
            label="Terminal Rate"
            value={fmtPct(path.terminal_rate)}
            sub="priced in"
            tone="text"
          />
          <HeroCard
            label="Cuts Priced 12m"
            value={fmtCuts(path.cuts_priced)}
            sub={cutsSub(path.cuts_priced)}
            tone={path.cuts_priced > 0 ? "green" : path.cuts_priced < 0 ? "red" : "text"}
          />
        </div>
        <StepChart points={path.implied_path} />
      </div>

      {/* Right: FedWatch probability ladder */}
      <div className="col-span-1 min-h-0">
        <ProbabilityLadder rows={ladder} />
      </div>
    </div>
  );
}

// ───────── Hero card ─────────

function HeroCard({
  label, value, sub, tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "amber" | "green" | "red" | "text";
}) {
  const color =
    tone === "amber" ? "text-accent-amber" :
    tone === "green" ? "text-accent-green" :
    tone === "red"   ? "text-accent-red"   :
                       "text-terminal-text";
  return (
    <div className="panel">
      <div className="panel-body py-3 flex flex-col items-center text-center">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider">{label}</span>
        <span className={"font-serif text-3xl leading-tight tabular-nums " + color}>{value}</span>
        <span className="text-2xs text-terminal-dim">{sub}</span>
      </div>
    </div>
  );
}

// ───────── Stepped implied-path chart ─────────

function StepChart({ points }: { points: RatePath["implied_path"] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono", fontSize: 10 },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "#1a1a1a" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const s = chart.addSeries(LineSeries, {
      color: "#ffb800",
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = s;
    return () => { chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points
      .filter((p) => p.implied_rate !== null && p.implied_rate !== undefined)
      .map((p) => ({ time: (Date.parse(p.date) / 1000) as UTCTimestamp, value: p.implied_rate }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div className="panel flex-1 min-h-0 flex flex-col">
      <div className="panel-header">
        <span>Implied Policy Path</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">
          Fed Funds futures, by FOMC date
        </span>
      </div>
      <div ref={elRef} className="flex-1 min-h-0" />
    </div>
  );
}

// ───────── FedWatch probability ladder ─────────

type LadderRow = { date: string; cut: number; hold: number; hike: number; implied_rate: number };

function ProbabilityLadder({ rows }: { rows: LadderRow[] }) {
  return (
    <div className="panel h-full flex flex-col min-h-0">
      <div className="panel-header">
        <span>Meeting Probabilities</span>
        <div className="flex items-center gap-2 normal-case tracking-normal text-2xs text-terminal-dim">
          <Legend color="#ef5350" label="cut" />
          <Legend color="#5fb878" label="hold" />
          <Legend color="#3b82f6" label="hike" />
        </div>
      </div>
      <div className="panel-body flex-1 min-h-0 overflow-auto py-2 space-y-2">
        {rows.map((r) => (
          <LadderItem key={r.date} row={r} />
        ))}
      </div>
    </div>
  );
}

function LadderItem({ row }: { row: LadderRow }) {
  // Normalize to a clean 100% width even if probabilities drift slightly.
  const cut = clamp01(row.cut);
  const hold = clamp01(row.hold);
  const hike = clamp01(row.hike);
  const total = cut + hold + hike || 1;
  const cutPct = (cut / total) * 100;
  const holdPct = (hold / total) * 100;
  const hikePct = (hike / total) * 100;

  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs text-terminal-text">{fmtMeetingDate(row.date)}</span>
        <span className="font-mono text-2xs text-accent-amber tabular-nums">
          {fmtPct(row.implied_rate)} implied
        </span>
      </div>
      <div className="flex h-5 w-full overflow-hidden rounded-sm bg-terminal-panel">
        <Segment pct={cutPct} color="#ef5350" />
        <Segment pct={holdPct} color="#5fb878" />
        <Segment pct={hikePct} color="#3b82f6" />
      </div>
      <div className="flex justify-between mt-0.5 text-2xs tabular-nums">
        <span className="text-accent-red">{fmtProb(cut)} cut</span>
        <span className="text-accent-green">{fmtProb(hold)} hold</span>
        <span className="text-accent-blue">{fmtProb(hike)} hike</span>
      </div>
    </div>
  );
}

function Segment({ pct, color }: { pct: number; color: string }) {
  if (pct <= 0) return null;
  const showLabel = pct >= 14;
  return (
    <div
      className="flex items-center justify-center text-2xs font-mono text-black/80"
      style={{ width: `${pct}%`, backgroundColor: color }}
      title={`${pct.toFixed(0)}%`}
    >
      {showLabel ? `${pct.toFixed(0)}%` : ""}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

// ───────── helpers ─────────

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return v.toFixed(2) + "%";
}

function fmtProb(v: number): string {
  // accept either 0-1 fractions or 0-100 percentages
  const pct = v <= 1 ? v * 100 : v;
  return pct.toFixed(0) + "%";
}

function clamp01(v: number | null | undefined): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  // accept either 0-1 fractions or 0-100 percentages
  const x = v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, x));
}

function fmtCuts(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  const n = Math.abs(v);
  return n.toFixed(1);
}

function cutsSub(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return "25 bps steps";
  return v > 0 ? "25 bps cuts" : "25 bps hikes";
}

function fmtMeetingDate(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
