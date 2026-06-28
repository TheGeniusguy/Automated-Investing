import { useEffect, useMemo, useState } from "react";

/**
 * Relative Rotation Graph (Bloomberg RRG) - the signature sector-rotation
 * quadrant chart. Plots the 11 SPDR sector ETFs against a benchmark on the
 * JdK RS-Ratio (x) vs RS-Momentum (y) plane, split into four rotation
 * quadrants around the (100, 100) origin:
 *
 *   Leading (top-right, green)   Weakening (bottom-right, amber)
 *   Improving (top-left, blue)   Lagging (bottom-left, red)
 *
 * Self-contained: fetches /api/rrg directly and renders fully populated from a
 * local FALLBACK so it never shows an empty box. Uses the shared design system.
 */

// ---- local types (no edits to api/types.ts) -------------------------------

interface RrgTailPoint {
  rs_ratio: number;
  rs_momentum: number;
}

interface RrgPoint {
  symbol: string;
  name: string;
  rs_ratio: number;
  rs_momentum: number;
  quadrant: "Leading" | "Weakening" | "Lagging" | "Improving" | string;
  tail: RrgTailPoint[];
}

interface RrgResponse {
  benchmark: string;
  as_of_date: string;
  points: RrgPoint[];
  data_mode?: string;
  as_of?: string;
  source?: string;
}

// ---- local fallback (renders premium even fully offline) ------------------

const FALLBACK: RrgResponse = {
  benchmark: "SPY",
  as_of_date: "2026-06-28",
  points: [
    mk("XLK", "Technology", 102.6, 101.4, "Leading"),
    mk("XLC", "Communication Services", 101.8, 100.6, "Leading"),
    mk("XLY", "Consumer Discretionary", 100.9, 100.9, "Leading"),
    mk("XLF", "Financials", 101.2, 99.1, "Weakening"),
    mk("XLI", "Industrials", 100.7, 98.6, "Weakening"),
    mk("XLU", "Utilities", 98.6, 101.1, "Improving"),
    mk("XLRE", "Real Estate", 99.3, 101.8, "Improving"),
    mk("XLV", "Health Care", 99.6, 100.7, "Improving"),
    mk("XLE", "Energy", 98.4, 97.7, "Lagging"),
    mk("XLB", "Materials", 98.9, 98.9, "Lagging"),
    mk("XLP", "Consumer Staples", 97.9, 99.4, "Lagging"),
  ],
  data_mode: "sample",
  source: "sample",
};

function mk(symbol: string, name: string, x: number, y: number, q: string): RrgPoint {
  // Build a short curved tail trailing into the head for the fallback.
  const tail: RrgTailPoint[] = [];
  const baseAng = Math.atan2(y - 100, x - 100);
  const baseR = Math.hypot(x - 100, y - 100);
  const N = 6;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const ang = baseAng + (0.55 * (1 - t));
    const r = baseR - 1.1 * (1 - t);
    tail.push({
      rs_ratio: 100 + r * Math.cos(ang),
      rs_momentum: 100 + r * Math.sin(ang),
    });
  }
  tail[N - 1] = { rs_ratio: x, rs_momentum: y };
  return { symbol, name, rs_ratio: x, rs_momentum: y, quadrant: q, tail };
}

// ---- quadrant styling -----------------------------------------------------

const QUADRANTS = ["Leading", "Weakening", "Lagging", "Improving"] as const;
type Quad = (typeof QUADRANTS)[number];

const QUAD_STYLE: Record<Quad, { fill: string; text: string; pill: string; dot: string }> = {
  Leading: {
    fill: "rgba(74, 158, 110, 0.10)",
    text: "text-accent-green",
    pill: "border-accent-green/40 bg-accent-green/5 text-accent-green",
    dot: "#5BB37D",
  },
  Improving: {
    fill: "rgba(90, 140, 210, 0.10)",
    text: "text-accent-blue",
    pill: "border-accent-blue/40 bg-accent-blue/5 text-accent-blue",
    dot: "#6E96D6",
  },
  Weakening: {
    fill: "rgba(200, 150, 60, 0.10)",
    text: "text-accent-amber",
    pill: "border-accent-amber/40 bg-accent-amber/5 text-accent-amber",
    dot: "#D6A84E",
  },
  Lagging: {
    fill: "rgba(200, 90, 80, 0.10)",
    text: "text-accent-red",
    pill: "border-accent-red/40 bg-accent-red/5 text-accent-red",
    dot: "#D17068",
  },
};

const QUAD_ORDER: Quad[] = ["Leading", "Weakening", "Lagging", "Improving"];

// ---- component ------------------------------------------------------------

export function RRGPanel() {
  const [data, setData] = useState<RrgResponse>(FALLBACK);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch("/api/rrg")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: RrgResponse) => {
        if (!alive) return;
        if (d && Array.isArray(d.points) && d.points.length > 0) setData(d);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const points = data.points;

  // KPI counts per quadrant.
  const counts = useMemo(() => {
    const c: Record<string, number> = { Leading: 0, Weakening: 0, Lagging: 0, Improving: 0 };
    for (const p of points) if (c[p.quadrant] !== undefined) c[p.quadrant] += 1;
    return c;
  }, [points]);

  // Group rows by quadrant for the table.
  const grouped = useMemo(() => {
    const g: Record<string, RrgPoint[]> = { Leading: [], Weakening: [], Lagging: [], Improving: [] };
    for (const p of points) (g[p.quadrant] ?? (g[p.quadrant] = [])).push(p);
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => b.rs_ratio - a.rs_ratio);
    }
    return g;
  }, [points]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span>Relative Rotation Graph</span>
          <span className="normal-case tracking-normal text-terminal-dim">
            RRG · 11 sectors vs {data.benchmark}
          </span>
        </div>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching..." : data.as_of_date}
        </span>
      </div>

      <div className="panel-body p-0 flex flex-col overflow-auto">
        {/* KPI strip */}
        <div className="grid grid-cols-4 border-b border-terminal-divider">
          {QUAD_ORDER.map((q) => (
            <div key={q} className="px-4 py-2.5 border-r border-terminal-divider last:border-r-0">
              <div className={"text-2xs uppercase tracking-wider " + QUAD_STYLE[q].text}>{q}</div>
              <div className="stat-figure text-terminal-text leading-none mt-1 tabular-nums">
                {counts[q] ?? 0}
              </div>
            </div>
          ))}
        </div>

        {err && (
          <div className="px-4 py-1.5 text-2xs text-terminal-dim border-b border-terminal-divider">
            showing reference snapshot
          </div>
        )}

        {/* HERO chart */}
        <div className="px-3 pt-3 pb-1">
          <RRGChart points={points} benchmark={data.benchmark} />
        </div>

        {/* Legend */}
        <div className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-terminal-divider text-2xs">
          {QUAD_ORDER.map((q) => (
            <span key={q} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: QUAD_STYLE[q].dot }} />
              <span className="text-terminal-muted">{q}</span>
            </span>
          ))}
          <span className="ml-auto text-terminal-dim">tail = 6-week trajectory · head = current</span>
        </div>

        {/* Table grouped by quadrant */}
        <div className="px-0 pb-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-terminal-muted border-b border-terminal-divider">
                <th className="text-left font-medium px-4 py-1.5">Symbol</th>
                <th className="text-left font-medium px-2 py-1.5">Name</th>
                <th className="text-right font-medium px-2 py-1.5">RS-Ratio</th>
                <th className="text-right font-medium px-2 py-1.5">RS-Mom</th>
                <th className="text-right font-medium px-4 py-1.5">Quadrant</th>
              </tr>
            </thead>
            <tbody>
              {QUAD_ORDER.flatMap((q) =>
                grouped[q].map((p) => (
                  <tr key={p.symbol} className="border-b border-terminal-divider/60 hover:bg-white/[0.02]">
                    <td className="px-4 py-1.5">
                      <span className="font-mono font-medium text-terminal-text">{p.symbol}</span>
                    </td>
                    <td className="px-2 py-1.5 text-terminal-muted truncate max-w-[180px]">{p.name}</td>
                    <td
                      className={
                        "px-2 py-1.5 text-right font-mono tabular-nums " +
                        (p.rs_ratio >= 100 ? "text-accent-green" : "text-accent-red")
                      }
                    >
                      {p.rs_ratio.toFixed(2)}
                    </td>
                    <td
                      className={
                        "px-2 py-1.5 text-right font-mono tabular-nums " +
                        (p.rs_momentum >= 100 ? "text-accent-green" : "text-accent-red")
                      }
                    >
                      {p.rs_momentum.toFixed(2)}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <span className={"pill border " + QUAD_STYLE[q].pill}>{q}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- inline SVG RRG chart -------------------------------------------------

function RRGChart({ points, benchmark }: { points: RrgPoint[]; benchmark: string }) {
  const W = 640;
  const H = 460;
  const M = { top: 16, right: 16, bottom: 30, left: 38 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  // Compute data extent across all heads + tails, padded, centered on 100.
  const { minX, maxX, minY, maxY } = useMemo(() => {
    let nx = 100, xx = 100, ny = 100, xy = 100;
    for (const p of points) {
      const all = [...p.tail, { rs_ratio: p.rs_ratio, rs_momentum: p.rs_momentum }];
      for (const t of all) {
        nx = Math.min(nx, t.rs_ratio);
        xx = Math.max(xx, t.rs_ratio);
        ny = Math.min(ny, t.rs_momentum);
        xy = Math.max(xy, t.rs_momentum);
      }
    }
    // Symmetric padding so origin sits visually centered, with margin.
    const spanX = Math.max(xx - 100, 100 - nx, 1.2) + 0.6;
    const spanY = Math.max(xy - 100, 100 - ny, 1.2) + 0.6;
    return { minX: 100 - spanX, maxX: 100 + spanX, minY: 100 - spanY, maxY: 100 + spanY };
  }, [points]);

  const sx = (v: number) => M.left + ((v - minX) / (maxX - minX)) * innerW;
  const sy = (v: number) => M.top + (1 - (v - minY) / (maxY - minY)) * innerH;

  const x0 = sx(100);
  const y0 = sy(100);

  // Axis ticks at integer-ish steps.
  const xticks = niceTicks(minX, maxX);
  const yticks = niceTicks(minY, maxY);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 470 }} role="img" aria-label="Relative Rotation Graph">
      <defs>
        {points.map((p) => {
          const st = QUAD_STYLE[(p.quadrant as Quad)] ?? QUAD_STYLE.Leading;
          return (
            <marker
              key={"arrow-" + p.symbol}
              id={"rrg-arrow-" + p.symbol}
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={st.dot} />
            </marker>
          );
        })}
      </defs>

      {/* Quadrant fills */}
      <rect x={x0} y={M.top} width={M.left + innerW - x0} height={y0 - M.top} fill={QUAD_STYLE.Leading.fill} />
      <rect x={M.left} y={M.top} width={x0 - M.left} height={y0 - M.top} fill={QUAD_STYLE.Improving.fill} />
      <rect x={x0} y={y0} width={M.left + innerW - x0} height={M.top + innerH - y0} fill={QUAD_STYLE.Weakening.fill} />
      <rect x={M.left} y={y0} width={x0 - M.left} height={M.top + innerH - y0} fill={QUAD_STYLE.Lagging.fill} />

      {/* Plot border */}
      <rect x={M.left} y={M.top} width={innerW} height={innerH} fill="none" stroke="rgba(255,255,255,0.08)" />

      {/* Grid ticks */}
      {xticks.map((t) => (
        <g key={"xt" + t}>
          <line x1={sx(t)} y1={M.top} x2={sx(t)} y2={M.top + innerH} stroke="rgba(255,255,255,0.04)" />
          <text x={sx(t)} y={M.top + innerH + 14} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.35)" className="font-mono">
            {t.toFixed(0)}
          </text>
        </g>
      ))}
      {yticks.map((t) => (
        <g key={"yt" + t}>
          <line x1={M.left} y1={sy(t)} x2={M.left + innerW} y2={sy(t)} stroke="rgba(255,255,255,0.04)" />
          <text x={M.left - 6} y={sy(t) + 3} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.35)" className="font-mono">
            {t.toFixed(0)}
          </text>
        </g>
      ))}

      {/* Crosshair axes through (100,100) */}
      <line x1={x0} y1={M.top} x2={x0} y2={M.top + innerH} stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" />
      <line x1={M.left} y1={y0} x2={M.left + innerW} y2={y0} stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" />

      {/* Quadrant labels */}
      <text x={M.left + innerW - 8} y={M.top + 14} textAnchor="end" fontSize="11" fontWeight="600" fill={QUAD_STYLE.Leading.dot} className="uppercase">
        Leading
      </text>
      <text x={M.left + 8} y={M.top + 14} textAnchor="start" fontSize="11" fontWeight="600" fill={QUAD_STYLE.Improving.dot} className="uppercase">
        Improving
      </text>
      <text x={M.left + innerW - 8} y={M.top + innerH - 8} textAnchor="end" fontSize="11" fontWeight="600" fill={QUAD_STYLE.Weakening.dot} className="uppercase">
        Weakening
      </text>
      <text x={M.left + 8} y={M.top + innerH - 8} textAnchor="start" fontSize="11" fontWeight="600" fill={QUAD_STYLE.Lagging.dot} className="uppercase">
        Lagging
      </text>

      {/* Axis titles */}
      <text x={M.left + innerW / 2} y={H - 2} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)" className="uppercase tracking-wider">
        JdK RS-Ratio
      </text>
      <text x={11} y={M.top + innerH / 2} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)" transform={`rotate(-90 11 ${M.top + innerH / 2})`} className="uppercase tracking-wider">
        JdK RS-Momentum
      </text>

      {/* Tails + heads */}
      {points.map((p) => {
        const st = QUAD_STYLE[(p.quadrant as Quad)] ?? QUAD_STYLE.Leading;
        const tail = p.tail && p.tail.length >= 2 ? p.tail : [{ rs_ratio: p.rs_ratio, rs_momentum: p.rs_momentum }];
        const segs = [];
        for (let i = 1; i < tail.length; i++) {
          const a = tail[i - 1];
          const b = tail[i];
          const opacity = 0.18 + 0.6 * (i / (tail.length - 1));
          const isHead = i === tail.length - 1;
          segs.push(
            <line
              key={p.symbol + "-seg-" + i}
              x1={sx(a.rs_ratio)}
              y1={sy(a.rs_momentum)}
              x2={sx(b.rs_ratio)}
              y2={sy(b.rs_momentum)}
              stroke={st.dot}
              strokeOpacity={opacity}
              strokeWidth={1.6}
              markerEnd={isHead ? `url(#rrg-arrow-${p.symbol})` : undefined}
            />
          );
        }
        const hx = sx(p.rs_ratio);
        const hy = sy(p.rs_momentum);
        return (
          <g key={p.symbol}>
            {segs}
            {/* trajectory dots */}
            {tail.slice(0, -1).map((t, i) => (
              <circle
                key={p.symbol + "-d" + i}
                cx={sx(t.rs_ratio)}
                cy={sy(t.rs_momentum)}
                r={1.6}
                fill={st.dot}
                fillOpacity={0.25 + 0.5 * (i / tail.length)}
              />
            ))}
            {/* head */}
            <circle cx={hx} cy={hy} r={5.5} fill={st.dot} stroke="rgba(0,0,0,0.45)" strokeWidth={1} />
            <text
              x={hx + 8}
              y={hy + 3.5}
              fontSize="10"
              fontWeight="600"
              fill="rgba(255,255,255,0.92)"
              className="font-mono"
              style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.55)", strokeWidth: 2 }}
            >
              {p.symbol}
            </text>
          </g>
        );
      })}

      {/* origin marker */}
      <circle cx={x0} cy={y0} r={2.5} fill="rgba(255,255,255,0.5)" />
      <text x={x0 + 5} y={y0 - 4} fontSize="8" fill="rgba(255,255,255,0.4)" className="font-mono">
        100 · {benchmark}
      </text>
    </svg>
  );
}

// Generate up to ~6 readable ticks across a range.
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const raw = span / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  let step = candidates[0];
  for (const c of candidates) {
    if (c >= raw) {
      step = c;
      break;
    }
  }
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) {
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}
