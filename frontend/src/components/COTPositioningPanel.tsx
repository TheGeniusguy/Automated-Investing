import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

// ── Response shapes (mirror backend app/data/cot_positioning.py) ────────────────
// Defined locally so this panel is self-contained; the wiring agent also mirrors
// these in api/types.ts. Net spec = net non-commercial (the "fast money").

interface COTMarketRow {
  market: string; // slug, e.g. "es", "gold"
  name: string;
  group: string;
  net_spec: number;
  net_commercial: number;
  cot_index: number; // 0..100 percentile rank
  z_score: number;
  change_1w: number;
  pct_long: number; // 0..1
  open_interest: number;
  extreme: boolean;
  extreme_side: "long" | "short" | null;
}

interface COTMarketsResponse {
  markets: COTMarketRow[];
  data_mode: string;
  as_of: string;
  source: string;
}

interface COTSeriesPoint {
  date: string;
  net_noncommercial: number;
  net_commercial: number;
  pct_long: number;
  cot_index: number;
  z_score: number;
  open_interest: number;
}

interface COTSeriesResponse {
  market: string;
  name: string;
  group: string;
  series: COTSeriesPoint[];
  latest: COTSeriesPoint;
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Sort config ─────────────────────────────────────────────────────────────────

type SortKey =
  | "name"
  | "group"
  | "net_spec"
  | "cot_index"
  | "z_score"
  | "change_1w"
  | "pct_long"
  | "open_interest";

const SORTABLE: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Market", align: "left" },
  { key: "group", label: "Group", align: "left" },
  { key: "net_spec", label: "Net Spec", align: "right" },
  { key: "cot_index", label: "COT Index", align: "left" },
  { key: "z_score", label: "Z-Score", align: "right" },
  { key: "change_1w", label: "1W Chg", align: "right" },
  { key: "pct_long", label: "% Long", align: "right" },
  { key: "open_interest", label: "Open Int.", align: "right" },
];

// ── Panel ───────────────────────────────────────────────────────────────────────

export function COTPositioningPanel() {
  const [board, setBoard] = useState<COTMarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("cot_index");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [selected, setSelected] = useState<string | null>(null);
  const [series, setSeries] = useState<COTSeriesResponse | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesErr, setSeriesErr] = useState<string | null>(null);

  // Initial board load.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .cotMarkets()
      .then((res: COTMarketsResponse) => {
        if (!alive) return;
        setBoard(res);
        setLoading(false);
        // Auto-select the most extreme market for an immediately rich detail view.
        const first =
          [...res.markets].sort(
            (a, b) => Math.abs(b.z_score) - Math.abs(a.z_score),
          )[0] ?? res.markets[0];
        if (first) setSelected(first.market);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Detail series load when selection changes.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setSeriesLoading(true);
    setSeriesErr(null);
    api
      .cotSeries(selected)
      .then((res: COTSeriesResponse) => {
        if (!alive) return;
        setSeries(res);
        setSeriesLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setSeriesErr(String(e));
        setSeriesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const rows = useMemo(() => {
    if (!board) return [];
    const sorted = [...board.markets].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp: number;
      if (typeof av === "string" && typeof bv === "string") {
        cmp = av.localeCompare(bv);
      } else {
        cmp = (av as number) - (bv as number);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [board, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text columns default ascending, numeric default descending.
      setSortDir(key === "name" || key === "group" ? "asc" : "desc");
    }
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Positioning (COT)</span>
        {board && (
          <span className="normal-case tracking-normal text-terminal-dim">
            {board.markets.length} markets · net spec vs commercial · 3y COT index
          </span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {err && <div className="text-accent-red text-xs py-2">Failed to load positioning: {err}</div>}
        {loading && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading positioning data...
          </div>
        )}

        {board && !loading && (
          <>
            {/* ── Market grid ─────────────────────────────────────────── */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Market positioning grid
              </div>
              <MarketGrid
                rows={rows}
                selected={selected}
                onSelect={setSelected}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={toggleSort}
              />
              <Legend />
            </div>

            {/* ── Detail ──────────────────────────────────────────────── */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-2">
              {!selected ? (
                <div className="text-terminal-dim text-xs py-6 text-center">
                  Select a market to inspect its positioning history.
                </div>
              ) : seriesErr ? (
                <div className="text-accent-red text-xs py-4">Failed to load series: {seriesErr}</div>
              ) : seriesLoading || !series ? (
                <div className="text-terminal-dim text-xs py-6 text-center">
                  Loading {selected.toUpperCase()} series...
                </div>
              ) : (
                <DetailView data={series} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Market grid ───────────────────────────────────────────────────────────────

function MarketGrid({
  rows,
  selected,
  onSelect,
  sortKey,
  sortDir,
  onSort,
}: {
  rows: COTMarketRow[];
  selected: string | null;
  onSelect: (m: string) => void;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            {SORTABLE.map((col) => (
              <th
                key={col.key}
                className={`py-1 px-2 cursor-pointer select-none hover:text-terminal-text ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
                onClick={() => onSort(col.key)}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="ml-1 text-accent-amber">{sortDir === "asc" ? "▲" : "▼"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const crowded = r.extreme;
            const sideTint =
              r.extreme_side === "long"
                ? "bg-accent-red/[0.08]"
                : r.extreme_side === "short"
                  ? "bg-accent-green/[0.08]"
                  : "";
            const isSel = selected === r.market;
            return (
              <tr
                key={r.market}
                onClick={() => onSelect(r.market)}
                className={`border-t border-terminal-border/20 cursor-pointer transition-colors ${
                  isSel ? "bg-accent-amber/10" : `hover:bg-white/[0.02] ${sideTint}`
                }`}
              >
                <td className="py-1.5 px-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-terminal-text font-medium">{r.name}</span>
                    {crowded && (
                      <span
                        className={`pill ${
                          r.extreme_side === "long"
                            ? "bg-accent-red/15 text-accent-red"
                            : "bg-accent-green/15 text-accent-green"
                        }`}
                      >
                        {r.extreme_side === "long" ? "Crowded Long" : "Crowded Short"}
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-1.5 px-2 text-terminal-muted">{r.group}</td>
                <td className={`py-1.5 px-2 text-right font-mono tabular-nums ${signColor(r.net_spec)}`}>
                  {fmtNet(r.net_spec)}
                </td>
                <td className="py-1.5 px-2">
                  <CotIndexBar value={r.cot_index} side={r.extreme_side} />
                </td>
                <td className={`py-1.5 px-2 text-right font-mono tabular-nums ${zColor(r.z_score)}`}>
                  {r.z_score >= 0 ? "+" : ""}
                  {r.z_score.toFixed(2)}
                </td>
                <td className={`py-1.5 px-2 text-right font-mono tabular-nums ${signColor(r.change_1w)}`}>
                  {fmtNet(r.change_1w, true)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">
                  {(r.pct_long * 100).toFixed(0)}%
                </td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted">
                  {fmtCompact(r.open_interest)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CotIndexBar({ value, side }: { value: number; side: "long" | "short" | null }) {
  const v = Math.max(0, Math.min(100, value));
  // Color by extremity: high = crowded long (clay->red), low = crowded short (green).
  const color =
    v >= 90 ? "#e5564b" : v <= 10 ? "#5bb97f" : v >= 70 ? "#c9785c" : v <= 30 ? "#6e92c4" : "#a39a8c";
  return (
    <div className="flex items-center gap-2 min-w-[8.5rem]">
      <div className="relative flex-1 h-2.5 bg-terminal-panel rounded-sm overflow-hidden border border-terminal-border/40">
        {/* Extreme-zone hairlines at 10 and 90. */}
        <div className="absolute inset-y-0 left-[10%] w-px bg-terminal-divider/60" />
        <div className="absolute inset-y-0 left-[90%] w-px bg-terminal-divider/60" />
        <div className="h-full rounded-sm" style={{ width: `${v}%`, backgroundColor: color }} />
      </div>
      <span
        className="font-mono tabular-nums text-2xs w-7 text-right"
        style={{ color: side ? color : undefined }}
      >
        {v.toFixed(0)}
      </span>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-2xs text-terminal-dim">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "#e5564b" }} />
        COT index &ge; 90 crowded long
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "#5bb97f" }} />
        COT index &le; 10 crowded short
      </span>
      <span>Net spec = non-commercial (fast money) · Commercial = hedgers (smart money)</span>
    </div>
  );
}

// ── Detail view ─────────────────────────────────────────────────────────────────

function DetailView({ data }: { data: COTSeriesResponse }) {
  const latest = data.latest;
  const idxColor =
    latest.cot_index >= 90 ? "#e5564b" : latest.cot_index <= 10 ? "#5bb97f" : "#c9785c";
  const regime =
    latest.cot_index >= 90
      ? "Crowded long"
      : latest.cot_index <= 10
        ? "Crowded short"
        : latest.cot_index >= 70
          ? "Leaning long"
          : latest.cot_index <= 30
            ? "Leaning short"
            : "Neutral";

  return (
    <div className="flex flex-col gap-3">
      {/* Hero */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-2xs uppercase tracking-wider text-terminal-dim">{data.group}</div>
          <div className="font-serif text-xl text-terminal-text leading-tight">{data.name}</div>
        </div>
        <div className="flex items-end gap-6">
          <div className="text-right">
            <div className="text-2xs uppercase tracking-wider text-terminal-dim">COT Index</div>
            <div className="stat-figure text-4xl leading-none" style={{ color: idxColor }}>
              {latest.cot_index.toFixed(0)}
            </div>
            <div className="text-2xs mt-0.5" style={{ color: idxColor }}>
              {regime}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xs uppercase tracking-wider text-terminal-dim">Z-Score</div>
            <div className={`stat-figure text-4xl leading-none ${zColor(latest.z_score)}`}>
              {latest.z_score >= 0 ? "+" : ""}
              {latest.z_score.toFixed(2)}
            </div>
            <div className="text-2xs mt-0.5 text-terminal-dim">vs 3y mean</div>
          </div>
          <div className="text-right">
            <div className="text-2xs uppercase tracking-wider text-terminal-dim">Net Spec</div>
            <div className={`stat-figure text-4xl leading-none ${signColor(latest.net_noncommercial)}`}>
              {fmtNet(latest.net_noncommercial)}
            </div>
            <div className="text-2xs mt-0.5 text-terminal-dim">{(latest.pct_long * 100).toFixed(0)}% long</div>
          </div>
        </div>
      </div>

      {/* Net spec vs commercial overlay */}
      <div>
        <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1 flex items-center gap-4">
          <span>Net positioning (contracts)</span>
          <span className="flex items-center gap-1.5 normal-case tracking-normal">
            <span className="inline-block w-4 h-0.5 rounded" style={{ background: "#c9785c" }} />
            Non-commercial (spec)
          </span>
          <span className="flex items-center gap-1.5 normal-case tracking-normal">
            <span className="inline-block w-4 h-0.5 rounded" style={{ background: "#6e92c4" }} />
            Commercial (hedger)
          </span>
        </div>
        <PositioningChart points={data.series} />
      </div>

      {/* COT-index oscillator — the WOW element */}
      <div>
        <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1">
          COT index oscillator (0-100, 3y percentile rank)
        </div>
        <CotOscillator points={data.series} />
      </div>
    </div>
  );
}

// ── Net spec vs commercial — TradingView two-line overlay ──────────────────────

function PositioningChart({ points }: { points: COTSeriesPoint[] }) {
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
      height: 220,
      layout: { background: { color: "transparent" }, textColor: "#a39a8c", fontFamily: "JetBrains Mono" },
      grid: { vertLines: { color: "#2e2a24" }, horzLines: { color: "#2e2a24" } },
      timeScale: { borderColor: "#3a352d" },
      rightPriceScale: { borderColor: "#3a352d" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const spec = chart.addSeries(LineSeries, { color: "#c9785c", lineWidth: 2, title: "Spec" });
    const comm = chart.addSeries(LineSeries, { color: "#6e92c4", lineWidth: 2, title: "Commercial" });

    spec.setData(
      points.map((p) => ({
        time: toTime(p.date),
        value: p.net_noncommercial,
      })),
    );
    comm.setData(
      points.map((p) => ({
        time: toTime(p.date),
        value: p.net_commercial,
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
  }, [points]);

  return <div ref={ref} />;
}

// ── COT-index oscillator — custom SVG with shaded extreme zones ─────────────────

function CotOscillator({ points }: { points: COTSeriesPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(() => {
      if (ref.current) setWidth(ref.current.clientWidth);
    });
    ro.observe(ref.current);
    setWidth(ref.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  const H = 180;
  const padL = 28;
  const padR = 8;
  const padT = 6;
  const padB = 18;
  const plotW = Math.max(1, width - padL - padR);
  const plotH = H - padT - padB;

  const yFor = (v: number) => padT + ((100 - Math.max(0, Math.min(100, v))) / 100) * plotH;

  const n = points.length;
  const xFor = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const path = useMemo(() => {
    if (n === 0) return "";
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.cot_index).toFixed(1)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  // Year tick labels (first occurrence of each year).
  const ticks = useMemo(() => {
    const seen = new Set<string>();
    const out: { x: number; label: string }[] = [];
    points.forEach((p, i) => {
      const y = p.date.slice(0, 4);
      if (!seen.has(y)) {
        seen.add(y);
        out.push({ x: xFor(i), label: y });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  if (n === 0) {
    return <div className="text-2xs text-terminal-dim py-4">No oscillator data.</div>;
  }

  const yTop = yFor(100);
  const y90 = yFor(90);
  const y50 = yFor(50);
  const y10 = yFor(10);
  const yBot = yFor(0);

  return (
    <div ref={ref}>
      <svg width={width} height={H} className="block">
        {/* Crowded-long zone (>=90). */}
        <rect x={padL} y={yTop} width={plotW} height={y90 - yTop} fill="rgba(229,86,75,0.14)" />
        <text x={padL + 4} y={y90 - 3} className="fill-accent-red" style={{ fontSize: 9 }}>
          Crowded long
        </text>
        {/* Crowded-short zone (<=10). */}
        <rect x={padL} y={y10} width={plotW} height={yBot - y10} fill="rgba(91,185,127,0.14)" />
        <text x={padL + 4} y={yBot - 4} className="fill-accent-green" style={{ fontSize: 9 }}>
          Crowded short
        </text>

        {/* Gridlines + axis labels at 0/10/50/90/100. */}
        {[
          { v: 100, y: yTop },
          { v: 90, y: y90 },
          { v: 50, y: y50 },
          { v: 10, y: y10 },
          { v: 0, y: yBot },
        ].map((g) => (
          <g key={g.v}>
            <line
              x1={padL}
              x2={width - padR}
              y1={g.y}
              y2={g.y}
              stroke="#3a352d"
              strokeWidth={g.v === 90 || g.v === 10 ? 1 : 0.5}
              strokeDasharray={g.v === 90 || g.v === 10 ? "3 3" : undefined}
            />
            <text x={2} y={g.y + 3} className="fill-terminal-dim" style={{ fontSize: 9 }}>
              {g.v}
            </text>
          </g>
        ))}

        {/* Year ticks. */}
        {ticks.map((t) => (
          <text
            key={t.label}
            x={t.x}
            y={H - 4}
            textAnchor="middle"
            className="fill-terminal-dim"
            style={{ fontSize: 9 }}
          >
            {t.label}
          </text>
        ))}

        {/* Oscillator line. */}
        <path d={path} fill="none" stroke="#c9785c" strokeWidth={1.6} />

        {/* Latest marker. */}
        {n > 0 && (
          <circle
            cx={xFor(n - 1)}
            cy={yFor(points[n - 1].cot_index)}
            r={3}
            fill="#ece7df"
            stroke="#181613"
            strokeWidth={1}
          />
        )}
      </svg>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function toTime(date: string): UTCTimestamp {
  return Math.floor(new Date(date).getTime() / 1000) as UTCTimestamp;
}

function signColor(v: number): string {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

function zColor(z: number): string {
  if (Math.abs(z) >= 2) return z > 0 ? "text-accent-red" : "text-accent-green";
  if (Math.abs(z) >= 1) return "text-accent-amber";
  return "text-terminal-muted";
}

function fmtNet(v: number, signed = false): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  const a = Math.abs(v);
  const body =
    a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  if (signed) return `${sign}${body}`;
  return v < 0 ? `-${body}` : body;
}

function fmtCompact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}
