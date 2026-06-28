import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { DeepEconomyResponse, EconCategory } from "../api/types";

/**
 * Deep Economy - Wave 2, Feature F.
 *
 * A dense economic terminal. The header band reads the regime in plain
 * language and pins the composite z as a serif hero gauge. Below it, the nine
 * curated categories (Growth, Labor, Inflation, Consumer, Housing, Credit and
 * Financial Conditions, Fiscal and Debt, Trade, Global) render as cards. Each
 * card carries a diffusion read (heat bar + plain text) and its series as
 * compact metric tiles: label, latest, change, an inline sparkline, and a
 * z-score chip colored by sense-adjusted z (green good, red bad, muted flat).
 * Clicking a category opens a drill-down with the longer history per series.
 */

type DeepCategory = DeepEconomyResponse["categories"][number];
type DeepSeries = DeepCategory["series"][number];
type DrillSeries = EconCategory["series"][number];

export function DeepEconomyPanel() {
  const [data, setData] = useState<DeepEconomyResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.deepEconomy()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) return <PanelShell title="Deep Economy"><div className="panel-body text-accent-red">⚠ {err}</div></PanelShell>;
  if (!data) return <PanelShell title="Deep Economy"><div className="panel-body text-terminal-dim">loading…</div></PanelShell>;

  if (selected) {
    return <CategoryDrillDown cat={selected} onClose={() => setSelected(null)} />;
  }

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <RegimeBand data={data} />
      <div className="flex-1 min-h-0 overflow-auto pr-1">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {data.categories.map((c) => (
            <CategoryCard key={c.name} cat={c} onOpen={() => setSelected(c.name)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function RegimeBand({ data }: { data: DeepEconomyResponse }) {
  const z = data.composite_z;
  const tone = zTone(z);
  // category_signed_z is a per-category map; the breadth read is its mean.
  const catZ = Object.values(data.category_signed_z ?? {});
  const breadthZ = catZ.length ? catZ.reduce((a, b) => a + b, 0) / catZ.length : null;
  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Deep Economy</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {data.category_count} categories · {data.series_count} series
        </span>
      </div>
      <div className="panel-body py-3 px-4 flex items-center gap-5">
        <div className="flex flex-col items-center justify-center min-w-[7rem]">
          <span className={"stat-figure text-5xl leading-none " + tone.text}>
            {z === null || z === undefined ? "—" : (z > 0 ? "+" : "") + z.toFixed(2)}
          </span>
          <span className="text-2xs uppercase tracking-wider text-terminal-muted mt-1">composite z</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">regime read</div>
          <p className="text-sm text-terminal-text leading-snug font-serif">{data.regime_read}</p>
          {breadthZ != null && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xs text-terminal-dim uppercase tracking-wider">breadth</span>
              <DiffusionBar heat={normalizeHeat(breadthZ)} className="w-40" />
              <span className={"text-2xs tabular-nums " + zTone(breadthZ).text}>
                {(breadthZ > 0 ? "+" : "") + breadthZ.toFixed(2)} avg
              </span>
            </div>
          )}
        </div>
        <div className="text-right text-2xs text-terminal-dim whitespace-nowrap self-start">
          {data.as_of?.slice(0, 10) ?? ""}
          <div className="text-terminal-dim/70">{data.source}</div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- card */

function CategoryCard({ cat, onOpen }: { cat: DeepCategory; onOpen: () => void }) {
  return (
    <div className="panel">
      <button
        type="button"
        onClick={onOpen}
        className="panel-header w-full text-left hover:text-terminal-text transition"
        title="Open drill-down"
      >
        <span className="truncate">{cat.name}</span>
        <span className={"normal-case tracking-normal tabular-nums " + zTone(cat.avg_signed_z).text}>
          {cat.avg_signed_z == null ? "" : (cat.avg_signed_z > 0 ? "+" : "") + cat.avg_signed_z.toFixed(2)}
        </span>
      </button>
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <DiffusionBar heat={cat.heat} className="w-20" />
        <span className="text-2xs text-terminal-muted truncate flex-1">{cat.diffusion_read}</span>
        <span className="text-2xs text-terminal-dim tabular-nums whitespace-nowrap">
          {cat.improving}/{cat.total}
        </span>
      </div>
      <div className="px-2 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {cat.series.map((s) => (
          <MetricTile key={s.id} s={s} />
        ))}
      </div>
    </div>
  );
}

function MetricTile({ s }: { s: DeepSeries }) {
  const sd = senseDir(s.signed_z, s.zscore);
  const chgGood = s.change == null || s.change === 0 ? 0 : Math.sign(s.change) * sd;
  const chgCls = chgGood > 0 ? "text-accent-green" : chgGood < 0 ? "text-accent-red" : "text-terminal-muted";
  const sparkColor = zTone(s.signed_z).hex;
  return (
    <div
      className="border border-terminal-border/60 rounded-panel px-2 py-1.5 bg-terminal-bg/30"
      title={`${s.label} (${s.id})\nlatest ${fmtNum(s.latest)}${s.unit ?? ""}\nz ${fmtZ(s.zscore)} · signed ${fmtZ(s.signed_z)} · pct ${s.percentile == null ? "—" : s.percentile.toFixed(0)}`}
    >
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <span className="text-2xs text-terminal-muted truncate">{s.label}</span>
        <ZChip z={s.zscore} signed={s.signed_z} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="stat-figure text-base text-terminal-text">{fmtNum(s.latest)}</span>
            {s.unit && <span className="text-2xs text-terminal-dim">{s.unit}</span>}
          </div>
          <span className={"text-2xs tabular-nums " + chgCls}>
            {s.change == null ? "—" : (s.change > 0 ? "+" : "") + fmtNum(s.change)}
          </span>
        </div>
        <Spark values={s.spark} color={sparkColor} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- drill-down */

function CategoryDrillDown({ cat, onClose }: { cat: string; onClose: () => void }) {
  const [data, setData] = useState<EconCategory | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    api.econCategory(cat)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [cat]);

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="panel" style={{ flexShrink: 0 }}>
        <div className="panel-header">
          <button type="button" onClick={onClose} className="hover:text-terminal-text transition normal-case tracking-normal">
            ‹ all categories
          </button>
          <span className="normal-case tracking-normal text-terminal-text">{cat}</span>
        </div>
        {data && (
          <div className="px-3 py-2 flex items-center gap-2 border-t border-terminal-border/40">
            <DiffusionBar heat={data.heat} className="w-24" />
            <span className="text-2xs text-terminal-muted">{data.diffusion_read}</span>
            <span className="text-2xs text-terminal-dim tabular-nums ml-auto">
              {data.improving}/{data.total} improving · avg {data.avg_signed_z == null ? "—" : data.avg_signed_z.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {err && <div className="panel"><div className="panel-body text-accent-red">⚠ {err}</div></div>}
      {!data && !err && <div className="panel"><div className="panel-body text-terminal-dim">loading…</div></div>}

      {data && (
        <div className="flex-1 min-h-0 overflow-auto pr-1 flex flex-col gap-2">
          {data.series.map((s) => (
            <DrillRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function DrillRow({ s }: { s: DrillSeries }) {
  const statEntries: [string, number][] = s.stats
    ? (Object.entries(s.stats) as [string, number][]).slice(0, 5)
    : [];
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="truncate">{s.label}</span>
        <span className="normal-case tracking-normal text-terminal-dim">{s.id}</span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-1">
            <span className="stat-figure text-2xl text-terminal-text">{fmtNum(s.latest)}</span>
            {s.unit && <span className="text-2xs text-terminal-dim">{s.unit}</span>}
          </div>
          <ChangeTag change={s.change} sd={senseDir(s.signed_z, s.zscore)} />
          <ZChip z={s.zscore} signed={s.signed_z} />
          <span className="text-2xs text-terminal-muted tabular-nums">
            pct {s.percentile == null ? "—" : s.percentile.toFixed(0)}
          </span>
          {s.trend && <span className="text-2xs text-terminal-dim">{s.trend}</span>}
        </div>
        <HistoryLine history={s.history} color={zTone(s.signed_z).hex} />
        {statEntries.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-terminal-muted">
            {statEntries.map(([k, v]) => (
              <span key={k} className="tabular-nums">
                <span className="text-terminal-dim uppercase tracking-wider">{k}</span> {fmtNum(v)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- primitives */

function ZChip({ z, signed }: { z: number | null; signed: number | null }) {
  const tone = zTone(signed);
  const txt = z == null ? "—" : (z > 0 ? "+" : "") + z.toFixed(2);
  return (
    <span className={"pill tabular-nums " + tone.chip} title={`z ${fmtZ(z)} · sense-adjusted ${fmtZ(signed)}`}>
      z {txt}
    </span>
  );
}

function ChangeTag({ change, sd }: { change: number | null; sd: number }) {
  const good = change == null || change === 0 ? 0 : Math.sign(change) * sd;
  const cls = good > 0 ? "text-accent-green" : good < 0 ? "text-accent-red" : "text-terminal-muted";
  return (
    <span className={"text-2xs tabular-nums " + cls}>
      {change == null ? "—" : (change > 0 ? "+" : "") + fmtNum(change)}
    </span>
  );
}

function DiffusionBar({ heat, className = "" }: { heat: number | null; className?: string }) {
  // heat normalized to [0, 1]; below 0.5 = contracting (red), above = improving (green).
  const h = heat == null ? 0.5 : Math.max(0, Math.min(1, heat));
  const pct = Math.round(h * 100);
  const color = h > 0.55 ? "#34d399" : h < 0.45 ? "#fb7185" : "#8b8b8b";
  return (
    <div className={"h-1.5 rounded-full bg-terminal-border/50 overflow-hidden " + className} title={`diffusion ${pct}%`}>
      <div className="h-full rounded-full" style={{ width: pct + "%", background: color }} />
    </div>
  );
}

function Spark({ values, color }: { values: number[] | null | undefined; color: string }) {
  const W = 56;
  const H = 26;
  if (!values || values.length < 2) return <svg width={W} height={H} className="shrink-0" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = W / (values.length - 1);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(H - ((v - min) / range) * H).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={W} height={H} className="shrink-0">
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function HistoryLine({ history, color }: { history?: { date: string; value: number }[]; color: string }) {
  const pts = (history ?? []).filter((p) => p.value != null);
  const W = 600;
  const H = 72;
  if (pts.length < 2) {
    return <div className="h-[72px] flex items-center text-2xs text-terminal-dim">insufficient history</div>;
  }
  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = W / (pts.length - 1);
  const coords = pts.map((p, i) => ({
    x: i * step,
    y: H - ((p.value - min) / range) * H,
  }));
  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gid = "deepfill-" + color.replace(/[^a-z0-9]/gi, "");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-[72px]">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------- helpers */

// Sense direction: +1 when higher is good, -1 when lower is good. Derived from
// signed_z vs raw z so it is agnostic to however the backend encodes `sense`.
function senseDir(signedZ: number | null, z: number | null): number {
  if (signedZ == null || z == null || signedZ === 0 || z === 0) return 1;
  return Math.sign(signedZ) === Math.sign(z) ? 1 : -1;
}

function zTone(z: number | null | undefined): { text: string; chip: string; hex: string } {
  if (z == null) return { text: "text-terminal-muted", chip: "bg-terminal-border/40 text-terminal-muted", hex: "#8b8b8b" };
  if (z >= 0.5) return { text: "text-accent-green", chip: "bg-green-500/15 text-accent-green", hex: "#34d399" };
  if (z <= -0.5) return { text: "text-accent-red", chip: "bg-rose-500/15 text-accent-red", hex: "#fb7185" };
  return { text: "text-terminal-muted", chip: "bg-terminal-border/40 text-terminal-muted", hex: "#8b8b8b" };
}

// Map a signed z (roughly -3..3) onto a [0,1] diffusion fill.
function normalizeHeat(z: number | null): number {
  if (z == null) return 0.5;
  return Math.max(0, Math.min(1, 0.5 + z / 6));
}

function fmtZ(z: number | null | undefined): string {
  return z == null ? "—" : (z > 0 ? "+" : "") + z.toFixed(2);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (abs >= 10_000) return (v / 1_000).toFixed(1) + "k";
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
