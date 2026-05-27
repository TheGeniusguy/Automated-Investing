import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from "lightweight-charts";

import type { Drawing, ExtendedDrawingType, OHLCVBar } from "../api/types";

interface Props {
  chart: IChartApi;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  series: ISeriesApi<any>;
  bars: OHLCVBar[];
  drawings: Drawing[];
  activeTool: "cursor" | ExtendedDrawingType;
  snapToOhlc: boolean;
  onCreate: (type: ExtendedDrawingType, points: { time: string; price: number }[]) => void;
  onUpdate: (id: number, patch: { points?: { time: string; price: number }[]; style?: Record<string, unknown>; label?: string }) => void;
  onDelete: (id: number) => void;
  onEdit: (d: Drawing) => void;
}

interface ScreenPoint { x: number; y: number; }
interface DataPoint   { time: string; price: number; }

const FIB_LEVELS         = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXTENSIONS     = [0, 0.618, 1, 1.272, 1.618, 2, 2.618, 3];
const FIB_TIME_FIBS      = [1, 2, 3, 5, 8, 13, 21, 34];

/**
 * SVG overlay that:
 *   1. Renders persisted drawings on top of the chart
 *   2. Captures mouse events for drawing new shapes
 *   3. Right-click on existing drawing → properties dialog (via onEdit)
 *   4. Optional snap-to-OHLC (Open/High/Low/Close of nearest bar)
 *
 * Coordinate transforms via lightweight-charts' built-in helpers.
 */
export function DrawingsLayer(p: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);  // forces re-render on chart pan/zoom
  const [inProgress, setInProgress] = useState<DataPoint[]>([]);
  const [hover, setHover] = useState<DataPoint | null>(null);

  // Subscribe to chart range changes → re-render so SVG coords stay aligned.
  useEffect(() => {
    const unsubRange = p.chart.timeScale().subscribeVisibleTimeRangeChange(() => setTick((t) => t + 1));
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => {
      unsubRange;
      window.removeEventListener("resize", onResize);
    };
  }, [p.chart]);

  useEffect(() => {
    setInProgress([]);
  }, [p.activeTool]);

  // Coord transforms.
  const toScreen = (pt: DataPoint): ScreenPoint | null => {
    const time = (Date.parse(pt.time + "T00:00:00Z") / 1000) as UTCTimestamp;
    const x = p.chart.timeScale().timeToCoordinate(time as Time);
    const y = p.series.priceToCoordinate(pt.price);
    if (x === null || y === null) return null;
    return { x, y };
  };

  const fromScreen = (e: React.MouseEvent<HTMLDivElement>): DataPoint | null => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = p.chart.timeScale().coordinateToTime(x);
    const price = p.series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    let isoDate: string;
    if (typeof time === "number") {
      isoDate = new Date((time as number) * 1000).toISOString().slice(0, 10);
    } else if (typeof time === "string") {
      isoDate = time;
    } else {
      const t = time as { year: number; month: number; day: number };
      isoDate = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
    }
    return { time: isoDate, price: Number(price) };
  };

  // Snap-to-OHLC: pick the OHLC field closest to the cursor's price.
  const snap = (pt: DataPoint): DataPoint => {
    if (!p.snapToOhlc) return pt;
    const bar = p.bars.find((b) => b.date === pt.time) ?? nearestBarByDate(p.bars, pt.time);
    if (!bar) return pt;
    const candidates = [bar.open, bar.high, bar.low, bar.close];
    let best = candidates[0]; let bestDist = Math.abs(pt.price - best);
    for (const c of candidates) {
      const d = Math.abs(pt.price - c);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return { time: bar.date, price: best };
  };

  // ── Mouse handlers ──
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (p.activeTool === "cursor") {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sp = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const hit = pickDrawing(p.drawings, sp, toScreen);
      if (hit && e.button === 0) {
        p.onEdit(hit);
      }
      return;
    }
    if (e.button !== 0) return;
    const raw = fromScreen(e);
    if (!raw) return;
    const pt = snap(raw);
    const next = [...inProgress, pt];
    const needed = pointsNeededFor(p.activeTool);
    if (next.length >= needed) {
      p.onCreate(p.activeTool, next);
      setInProgress([]);
    } else {
      setInProgress(next);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (p.activeTool === "cursor" || inProgress.length === 0) {
      setHover(null);
      return;
    }
    const raw = fromScreen(e);
    if (!raw) return;
    setHover(snap(raw));
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (p.activeTool !== "cursor") return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = pickDrawing(p.drawings, { x, y }, toScreen);
    if (hit) {
      e.preventDefault();
      if (window.confirm(`Delete ${hit.drawing_type}${hit.label ? " (" + hit.label + ")" : ""}?`)) {
        p.onDelete(hit.id);
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") setInProgress([]);
  };
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const previewPoints: DataPoint[] = hover && inProgress.length > 0
    ? [...inProgress, hover]
    : inProgress;

  void tick;  // keep subscription alive

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHover(null)}
      onContextMenu={handleContextMenu}
      className="absolute inset-0"
      style={{
        cursor: p.activeTool === "cursor" ? "default" : "crosshair",
        pointerEvents: p.activeTool === "cursor" && p.drawings.length === 0 ? "none" : "auto",
      }}
    >
      <svg className="w-full h-full absolute inset-0 pointer-events-none" preserveAspectRatio="none">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffb800" />
          </marker>
        </defs>
        {p.drawings.map((d) => (
          <DrawingShape key={d.id} drawing={d} toScreen={toScreen} />
        ))}
        {previewPoints.length >= 1 && (
          <PreviewShape type={p.activeTool as ExtendedDrawingType} points={previewPoints} toScreen={toScreen} />
        )}
      </svg>
    </div>
  );
}

// ─── Shapes ───────────────────────────────────────────────────────────────

function DrawingShape({ drawing, toScreen }: { drawing: Drawing; toScreen: (p: DataPoint) => ScreenPoint | null }) {
  return <ShapeImpl type={drawing.drawing_type as ExtendedDrawingType} points={drawing.points} style={drawing.style} label={drawing.label} toScreen={toScreen} persisted />;
}

function PreviewShape({ type, points, toScreen }: { type: ExtendedDrawingType; points: DataPoint[]; toScreen: (p: DataPoint) => ScreenPoint | null }) {
  return <ShapeImpl type={type} points={points} style={{ color: "#ffb800", line_width: 1 }} label={null} toScreen={toScreen} persisted={false} />;
}

interface ShapeImplProps {
  type: ExtendedDrawingType;
  points: DataPoint[];
  style: { color?: string; line_width?: number; line_style?: string; fill?: string; opacity?: number };
  label: string | null;
  toScreen: (p: DataPoint) => ScreenPoint | null;
  persisted: boolean;
}

function ShapeImpl({ type, points, style, label, toScreen, persisted }: ShapeImplProps) {
  const color = style.color ?? "#ffb800";
  const width = style.line_width ?? 1;
  const dashArray = style.line_style === "dashed" ? "6,4" : style.line_style === "dotted" ? "2,3" : undefined;
  const opacity = persisted ? 1 : 0.6;

  // trend_line
  if (type === "trend_line" && points.length >= 2) {
    const a = toScreen(points[0]); const b = toScreen(points[1]);
    if (!a || !b) return null;
    return (
      <g opacity={opacity}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width} strokeDasharray={dashArray} />
        <circle cx={a.x} cy={a.y} r={3} fill={color} />
        <circle cx={b.x} cy={b.y} r={3} fill={color} />
        {label && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fontSize={10} fill={color}>{label}</text>}
      </g>
    );
  }

  // hline
  if (type === "hline" && points.length >= 1) {
    const a = toScreen(points[0]); if (!a) return null;
    return (
      <g opacity={opacity}>
        <line x1={0} y1={a.y} x2="100%" y2={a.y} stroke={color} strokeWidth={width} strokeDasharray={dashArray} />
        <text x={6} y={a.y - 3} fontSize={10} fill={color}>{(label ? label + " · " : "") + points[0].price.toFixed(2)}</text>
      </g>
    );
  }

  // vline
  if (type === "vline" && points.length >= 1) {
    const a = toScreen(points[0]); if (!a) return null;
    return (
      <g opacity={opacity}>
        <line x1={a.x} y1={0} x2={a.x} y2="100%" stroke={color} strokeWidth={width} strokeDasharray={dashArray} />
        <text x={a.x + 3} y={12} fontSize={10} fill={color}>{(label ? label + " · " : "") + points[0].time}</text>
      </g>
    );
  }

  // fib_retracement (2 anchor points)
  if (type === "fib_retracement" && points.length >= 2) {
    const a = toScreen(points[0]); const b = toScreen(points[1]);
    if (!a || !b) return null;
    const high = Math.max(points[0].price, points[1].price);
    const low  = Math.min(points[0].price, points[1].price);
    const x1   = Math.min(a.x, b.x);
    return (
      <g opacity={opacity}>
        {FIB_LEVELS.map((lvl) => {
          const price = high - lvl * (high - low);
          const ys = toScreen({ time: points[1].time, price });
          if (!ys) return null;
          return (
            <g key={lvl}>
              <line x1={x1} y1={ys.y} x2="100%" y2={ys.y} stroke={color} strokeWidth={1} strokeDasharray="2,3" />
              <text x={x1 + 4} y={ys.y - 2} fontSize={9} fill={color}>{(lvl * 100).toFixed(1)}% · {price.toFixed(2)}</text>
            </g>
          );
        })}
        <circle cx={a.x} cy={a.y} r={3} fill={color} />
        <circle cx={b.x} cy={b.y} r={3} fill={color} />
      </g>
    );
  }

  // fib_extension (A=origin, B=top, C=retrace pivot)
  if (type === "fib_extension" && points.length >= 3) {
    const A = points[0]; const B = points[1]; const C = points[2];
    const ab = B.price - A.price;
    const sA = toScreen(A); const sB = toScreen(B); const sC = toScreen(C);
    if (!sA || !sB || !sC) return null;
    return (
      <g opacity={opacity}>
        <line x1={sA.x} y1={sA.y} x2={sB.x} y2={sB.y} stroke={color} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
        <line x1={sB.x} y1={sB.y} x2={sC.x} y2={sC.y} stroke={color} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
        {FIB_EXTENSIONS.map((lvl) => {
          const price = C.price + lvl * ab;
          const ys = toScreen({ time: C.time, price });
          if (!ys) return null;
          return (
            <g key={lvl}>
              <line x1={sC.x} y1={ys.y} x2="100%" y2={ys.y} stroke={color} strokeWidth={1} strokeDasharray="2,3" />
              <text x={sC.x + 4} y={ys.y - 2} fontSize={9} fill={color}>{(lvl * 100).toFixed(1)}% · {price.toFixed(2)}</text>
            </g>
          );
        })}
        <circle cx={sA.x} cy={sA.y} r={3} fill={color} />
        <circle cx={sB.x} cy={sB.y} r={3} fill={color} />
        <circle cx={sC.x} cy={sC.y} r={3} fill={color} />
      </g>
    );
  }

  // fib_time_zones — vertical lines at Fibonacci-numbered bar intervals from start time
  if (type === "fib_time_zones" && points.length >= 2) {
    const a = toScreen(points[0]); const b = toScreen(points[1]);
    if (!a || !b) return null;
    const spacing = Math.max(1, Math.abs(b.x - a.x));
    return (
      <g opacity={opacity}>
        {FIB_TIME_FIBS.map((n) => {
          const x = a.x + n * spacing;
          return (
            <g key={n}>
              <line x1={x} y1={0} x2={x} y2="100%" stroke={color} strokeWidth={1} strokeDasharray="2,3" />
              <text x={x + 2} y={12} fontSize={9} fill={color}>{n}</text>
            </g>
          );
        })}
        <circle cx={a.x} cy={a.y} r={3} fill={color} />
        <circle cx={b.x} cy={b.y} r={3} fill={color} />
      </g>
    );
  }

  // parallel_channel — 2 anchors define the base line; 3rd is the offset
  if (type === "parallel_channel" && points.length >= 3) {
    const a = toScreen(points[0]); const b = toScreen(points[1]); const c = toScreen(points[2]);
    if (!a || !b || !c) return null;
    // Vertical offset = c.y - projection-of-c-onto-AB-line.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return null;
    // Project c onto the AB line.
    const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    const ox = c.x - projX;
    const oy = c.y - projY;
    return (
      <g opacity={opacity}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width} strokeDasharray={dashArray} />
        <line x1={a.x + ox} y1={a.y + oy} x2={b.x + ox} y2={b.y + oy} stroke={color} strokeWidth={width} strokeDasharray={dashArray} />
        <polygon
          points={`${a.x},${a.y} ${b.x},${b.y} ${b.x + ox},${b.y + oy} ${a.x + ox},${a.y + oy}`}
          fill={style.fill ?? "rgba(34,211,238,0.06)"} opacity={0.6}
        />
        <circle cx={a.x} cy={a.y} r={3} fill={color} />
        <circle cx={b.x} cy={b.y} r={3} fill={color} />
        <circle cx={c.x} cy={c.y} r={3} fill={color} />
      </g>
    );
  }

  // rectangle
  if (type === "rectangle" && points.length >= 2) {
    const a = toScreen(points[0]); const b = toScreen(points[1]);
    if (!a || !b) return null;
    const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x); const h = Math.abs(b.y - a.y);
    return (
      <g opacity={opacity}>
        <rect x={x} y={y} width={w} height={h} stroke={color} strokeWidth={width} fill={style.fill ?? "rgba(255,184,0,0.1)"} strokeDasharray={dashArray} />
        {label && <text x={x + 4} y={y + 12} fontSize={10} fill={color}>{label}</text>}
      </g>
    );
  }

  // risk_reward (3 points: entry, stop, target)
  if (type === "risk_reward" && points.length >= 3) {
    const entry = points[0]; const stop = points[1]; const target = points[2];
    const sE = toScreen(entry); const sS = toScreen(stop); const sT = toScreen(target);
    if (!sE || !sS || !sT) return null;
    const risk   = Math.abs(entry.price - stop.price);
    const reward = Math.abs(target.price - entry.price);
    const rr     = risk > 0 ? (reward / risk) : 0;
    const x1 = Math.min(sE.x, sS.x, sT.x);
    const x2 = Math.max(sE.x, sS.x, sT.x);
    return (
      <g opacity={opacity}>
        {/* risk box (entry → stop) */}
        <rect
          x={x1} y={Math.min(sE.y, sS.y)}
          width={x2 - x1} height={Math.abs(sE.y - sS.y)}
          fill="rgba(239,83,80,0.15)" stroke="#ef5350" strokeWidth={1}
        />
        {/* reward box (entry → target) */}
        <rect
          x={x1} y={Math.min(sE.y, sT.y)}
          width={x2 - x1} height={Math.abs(sE.y - sT.y)}
          fill="rgba(38,166,154,0.15)" stroke="#26a69a" strokeWidth={1}
        />
        <line x1={x1} y1={sE.y} x2={x2} y2={sE.y} stroke="#ffb800" strokeWidth={2} />
        <text x={x1 + 4} y={sE.y - 2} fontSize={10} fill="#ffb800">Entry {entry.price.toFixed(2)}</text>
        <text x={x1 + 4} y={sS.y + (sS.y > sE.y ? 12 : -2)} fontSize={9} fill="#ef5350">Stop {stop.price.toFixed(2)} · risk {risk.toFixed(2)}</text>
        <text x={x1 + 4} y={sT.y + (sT.y > sE.y ? 12 : -2)} fontSize={9} fill="#26a69a">Target {target.price.toFixed(2)} · reward {reward.toFixed(2)} · {rr.toFixed(2)}R</text>
      </g>
    );
  }

  // arrow
  if (type === "arrow" && points.length >= 2) {
    const a = toScreen(points[0]); const b = toScreen(points[1]);
    if (!a || !b) return null;
    return (
      <g opacity={opacity}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width + 1} markerEnd="url(#arrow)" />
      </g>
    );
  }

  // text
  if (type === "text" && points.length >= 1) {
    const a = toScreen(points[0]); if (!a) return null;
    return <text x={a.x} y={a.y} fontSize={12} fill={color} opacity={opacity}>{label ?? "Note"}</text>;
  }

  // anchored_vwap_anchor — visible vertical marker; the actual VWAP series
  // is rendered separately by the indicator pane.
  if (type === "anchored_vwap_anchor" && points.length >= 1) {
    const a = toScreen(points[0]); if (!a) return null;
    return (
      <g opacity={opacity}>
        <line x1={a.x} y1={0} x2={a.x} y2="100%" stroke={color} strokeWidth={width + 1} strokeDasharray="4,4" />
        <text x={a.x + 4} y={14} fontSize={10} fill={color}>⚓ {points[0].time}</text>
      </g>
    );
  }

  return null;
}

// ─── Picking ──────────────────────────────────────────────────────────────

function pointsNeededFor(t: ExtendedDrawingType): number {
  if (t === "hline" || t === "vline" || t === "text" || t === "anchored_vwap_anchor") return 1;
  if (t === "parallel_channel" || t === "fib_extension" || t === "risk_reward") return 3;
  return 2;
}

function pickDrawing(
  drawings: Drawing[],
  pos: ScreenPoint,
  toScreen: (p: DataPoint) => ScreenPoint | null,
): Drawing | null {
  const TOL = 6;
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    const pts = d.points;
    if (d.drawing_type === "trend_line" || d.drawing_type === "arrow") {
      const a = toScreen(pts[0]); const b = toScreen(pts[1]);
      if (a && b && distanceToSegment(pos, a, b) <= TOL) return d;
    } else if (d.drawing_type === "hline") {
      const a = toScreen(pts[0]); if (a && Math.abs(pos.y - a.y) <= TOL) return d;
    } else if (d.drawing_type === "vline" || d.drawing_type === "anchored_vwap_anchor") {
      const a = toScreen(pts[0]); if (a && Math.abs(pos.x - a.x) <= TOL) return d;
    } else if (d.drawing_type === "rectangle" || d.drawing_type === "parallel_channel" || d.drawing_type === "risk_reward") {
      // Hit anywhere inside.
      const screens = pts.map(toScreen);
      if (screens.every(Boolean)) {
        const xs = screens.map((s) => s!.x);
        const ys = screens.map((s) => s!.y);
        if (pos.x >= Math.min(...xs) - TOL && pos.x <= Math.max(...xs) + TOL &&
            pos.y >= Math.min(...ys) - TOL && pos.y <= Math.max(...ys) + TOL) return d;
      }
    } else if (d.drawing_type === "fib_retracement" || d.drawing_type === "fib_extension" || d.drawing_type === "fib_time_zones") {
      for (const pt of pts) {
        const s = toScreen(pt); if (s && distance(pos, s) <= TOL + 2) return d;
      }
    } else if (d.drawing_type === "text") {
      const a = toScreen(pts[0]); if (a && distance(pos, a) <= 12) return d;
    }
  }
  return null;
}

function nearestBarByDate(bars: OHLCVBar[], date: string): OHLCVBar | null {
  let best: OHLCVBar | null = null; let bestDelta = Infinity;
  const target = Date.parse(date);
  for (const b of bars) {
    const delta = Math.abs(Date.parse(b.date) - target);
    if (delta < bestDelta) { bestDelta = delta; best = b; }
  }
  return best;
}

function distance(a: ScreenPoint, b: ScreenPoint): number {
  const dx = a.x - b.x; const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const proj: ScreenPoint = { x: a.x + t * dx, y: a.y + t * dy };
  return distance(p, proj);
}
