import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { HeatmapTile, MacroHeatmap as Hm, MacroTransform } from "../api/types";

import { MacroSeriesDetail } from "./MacroSeriesDetail";

/**
 * Macro Heatmap — Wave 5.
 *
 * Full-catalog grid colored by z-score (or chosen transform). Quickly spot
 * stretched indicators across the entire macro universe.
 */
const TRANSFORM_OPTIONS: { id: MacroTransform; label: string; help: string }[] = [
  { id: "z_score",    label: "Rolling Z",     help: "60-month rolling z-score" },
  { id: "percentile", label: "Percentile",    help: "Percentile of latest vs full history (0-100)" },
  { id: "yoy",        label: "YoY %",         help: "12-month % change" },
  { id: "three_m_ann",label: "3m annualized", help: "3-month annualized % change" },
];

export function MacroHeatmap() {
  const [hm, setHm] = useState<Hm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [transform, setTransform] = useState<MacroTransform>("z_score");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<HeatmapTile | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.macroHeatmap(transform)
      .then((d) => alive && setHm(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [transform]);

  const grouped = useMemo(() => {
    if (!hm) return {};
    const g: Record<string, HeatmapTile[]> = {};
    const q = query.trim().toLowerCase();
    for (const t of hm.tiles) {
      if (q && !(t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))) continue;
      const cat = t.category || "other";
      (g[cat] ||= []).push(t);
    }
    return g;
  }, [hm, query]);

  if (err) return (
    <div className="panel h-full"><div className="panel-header"><span>Macro Heatmap</span></div>
      <div className="panel-body text-accent-red">⚠ {err}</div></div>
  );

  return (
    <div className={"grid gap-2 h-full " + (focused ? "grid-cols-3" : "grid-cols-1")}>
      <div className={"flex flex-col gap-2 min-h-0 " + (focused ? "col-span-2" : "col-span-1")}>
        <Toolbar
          transform={transform} setTransform={setTransform}
          query={query} setQuery={setQuery}
          loading={loading}
          total={hm?.tiles.length ?? 0}
        />
        <div className="flex-1 min-h-0 overflow-auto pr-1">
          {Object.entries(grouped).map(([cat, tiles]) => (
            <div key={cat} className="mb-2">
              <div className="text-2xs uppercase tracking-wider text-terminal-muted py-1 sticky top-0 bg-terminal-bg z-10">
                {cat} <span className="text-terminal-dim">· {tiles.length}</span>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {tiles.map((t) => (
                  <Cell key={t.id} tile={t} transform={transform} onClick={() => setFocused(t)} active={focused?.id === t.id} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {focused && (
        <div className="col-span-1 min-h-0 overflow-auto">
          <MacroSeriesDetail seriesId={focused.id} onClose={() => setFocused(null)} />
        </div>
      )}
    </div>
  );
}

function Toolbar({
  transform, setTransform, query, setQuery, loading, total,
}: {
  transform: MacroTransform;
  setTransform: (t: MacroTransform) => void;
  query: string;
  setQuery: (q: string) => void;
  loading: boolean;
  total: number;
}) {
  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Macro Heatmap</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "rendering…" : `${total} indicators`}
        </span>
      </div>
      <div className="panel-body py-2 px-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-2xs">
          {TRANSFORM_OPTIONS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTransform(t.id)}
              className={"pill " + (transform === t.id ? "bg-accent-amber/20 text-accent-amber" : "text-terminal-muted")}
              title={t.help}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          className="ml-auto bg-terminal-panel border border-terminal-divider text-2xs text-terminal-text px-2 py-1 outline-none focus:border-accent-amber/40"
        />
      </div>
    </div>
  );
}

function Cell({
  tile, transform, onClick, active,
}: {
  tile: HeatmapTile;
  transform: MacroTransform;
  onClick: () => void;
  active: boolean;
}) {
  const v = transform === "percentile" ? tile.percentile : tile.z;
  const color = cellColor(v, transform);
  const display =
    v === null || v === undefined ? "—" :
    transform === "percentile" ? v.toFixed(0) :
    (v > 0 ? "+" : "") + v.toFixed(2);

  return (
    <button
      onClick={onClick}
      className={"text-left px-2 py-1.5 border rounded transition " +
                 (active ? "border-accent-amber" : "border-transparent")}
      style={{ background: color }}
      title={`${tile.label} · ${transform}: ${display}\nlast: ${fmtVal(tile.last)} (${tile.last_date ?? "—"})\npct: ${tile.percentile?.toFixed(0) ?? "—"}`}
    >
      <div className="text-2xs text-white truncate" style={{ textShadow: "0 0 4px rgba(0,0,0,0.7)" }}>
        {tile.id}
      </div>
      <div className="text-[10px] text-white/80 tabular-nums" style={{ textShadow: "0 0 4px rgba(0,0,0,0.7)" }}>
        {display}
      </div>
    </button>
  );
}

function cellColor(v: number | null, transform: MacroTransform): string {
  if (v === null || v === undefined) return "#1a1a1a";
  if (transform === "percentile") {
    // 0 = blue (low), 50 = neutral, 100 = red (high)
    const norm = (v - 50) / 50;
    return diverging(norm);
  }
  if (transform === "z_score") {
    return diverging(Math.max(-1, Math.min(1, v / 2)));
  }
  if (transform === "yoy" || transform === "three_m_ann") {
    return diverging(Math.max(-1, Math.min(1, v / 8)));
  }
  return "#262626";
}

function diverging(t: number): string {
  // t in [-1, 1]. Negative = blue, 0 = gray, Positive = red.
  if (t < 0) {
    // Blue to gray
    const f = Math.abs(t);
    const r = Math.round(38 + (1 - f) * 60);
    const g = Math.round(38 + (1 - f) * 80);
    const b = Math.round(38 + f * 130);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    const f = t;
    const r = Math.round(38 + f * 180);
    const g = Math.round(38 + (1 - f) * 50);
    const b = Math.round(38 + (1 - f) * 50);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

function fmtVal(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "k";
  return v.toFixed(2);
}
