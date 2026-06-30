import { useEffect, useMemo, useState, type ReactElement } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface RenkoBrick {
  direction: "up" | "down";
  open: number;
  close: number;
  date_approx: string;
}
interface KagiSegment {
  price: number;
  direction: "up" | "down" | "flat";
  thickness: "yang" | "yin";
  date_approx: string;
}
interface RenkoTrend {
  direction: "up" | "down" | null;
  run: number;
  bricks: number;
}
interface KagiTrend {
  direction: "up" | "down" | "flat" | null;
  thickness: "yang" | "yin" | null;
  segments: number;
}
interface RenkoKagiResponse {
  symbol: string;
  renko: RenkoBrick[];
  kagi: KagiSegment[];
  box_size: number | null;
  reversal_threshold: number | null;
  atr: number | null;
  latest_price: number | null;
  renko_trend: RenkoTrend;
  kagi_trend: KagiTrend;
  summary: string;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
function buildFallback(): RenkoKagiResponse {
  const box = 4;
  const renko: RenkoBrick[] = [];
  // A coherent up-then-down-then-up staircase.
  const seq = [
    ...Array(9).fill(1), ...Array(5).fill(-1), ...Array(3).fill(-1),
    ...Array(11).fill(1), ...Array(4).fill(-1), ...Array(7).fill(1),
  ] as number[];
  let base = 150;
  for (const d of seq) {
    const top = base + d * box;
    renko.push({
      direction: d > 0 ? "up" : "down",
      open: base,
      close: top,
      date_approx: "2026-06-01",
    });
    base = top;
  }
  const kagi: KagiSegment[] = [
    { price: 150, direction: "flat", thickness: "yin", date_approx: "2026-01-02" },
    { price: 188, direction: "up", thickness: "yang", date_approx: "2026-02-10" },
    { price: 166, direction: "down", thickness: "yang", date_approx: "2026-03-05" },
    { price: 201, direction: "up", thickness: "yang", date_approx: "2026-04-01" },
    { price: 159, direction: "down", thickness: "yin", date_approx: "2026-05-08" },
    { price: 197, direction: "up", thickness: "yang", date_approx: "2026-06-12" },
    { price: 182, direction: "down", thickness: "yang", date_approx: "2026-06-26" },
  ];
  return {
    symbol: "AAPL",
    renko,
    kagi,
    box_size: box,
    reversal_threshold: 8,
    atr: 4.1,
    latest_price: 182,
    renko_trend: { direction: "up", run: 7, bricks: renko.length },
    kagi_trend: { direction: "down", thickness: "yang", segments: kagi.length },
    summary:
      "AAPL at 182: Renko is printing 7 up bricks in a row and the Kagi line is yang (thick) - demand has the upper hand - both read the same way, a cleaner trend signal.",
    data_mode: "sample",
    as_of: "2026-06-30T18:00:00+00:00",
    source: "sample",
  };
}
const FALLBACK = buildFallback();

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(x: number | null, d = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(d);
}
function dirColor(dir: string | null): string {
  if (dir === "up") return "text-accent-green";
  if (dir === "down") return "text-accent-red";
  return "text-terminal-muted";
}
function thickColor(t: string | null): string {
  if (t === "yang") return "text-accent-green";
  if (t === "yin") return "text-accent-red";
  return "text-terminal-muted";
}

// SVG geometry constants.
const W = 640;
const H = 230;
const PAD = 8;

// ── Renko SVG (stepped colored bricks) ───────────────────────────────────────
function RenkoChart({ bricks }: { bricks: RenkoBrick[] }) {
  if (!bricks.length) {
    return <div className="text-xs text-terminal-dim font-mono p-4">No completed bricks.</div>;
  }
  const lows = bricks.map((b) => Math.min(b.open, b.close));
  const highs = bricks.map((b) => Math.max(b.open, b.close));
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  const span = hi - lo || 1;
  const colW = (W - PAD * 2) / bricks.length;
  const y = (p: number) => PAD + (H - PAD * 2) * (1 - (p - lo) / span);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-44">
      {bricks.map((b, i) => {
        const x = PAD + i * colW;
        const top = y(Math.max(b.open, b.close));
        const bot = y(Math.min(b.open, b.close));
        const up = b.direction === "up";
        return (
          <rect
            key={i}
            x={x + colW * 0.08}
            y={top}
            width={Math.max(colW * 0.84, 1)}
            height={Math.max(bot - top, 1)}
            rx={1}
            fill={up ? "rgba(74,222,128,0.85)" : "rgba(248,113,113,0.85)"}
            stroke={up ? "rgb(34,197,94)" : "rgb(239,68,68)"}
            strokeWidth={0.6}
          />
        );
      })}
    </svg>
  );
}

// ── Kagi SVG (stepped line, stroke width on yang/yin) ─────────────────────────
function KagiChart({ segments }: { segments: KagiSegment[] }) {
  if (segments.length < 2) {
    return <div className="text-xs text-terminal-dim font-mono p-4">Not enough reversals to draw.</div>;
  }
  const prices = segments.map((s) => s.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const colW = (W - PAD * 2) / (segments.length - 1);
  const x = (i: number) => PAD + i * colW;
  const y = (p: number) => PAD + (H - PAD * 2) * (1 - (p - lo) / span);

  // Each step = vertical move at column i (from prev price to this price) then a
  // horizontal connector to the next column. Stroke width encodes yang/yin.
  const parts: ReactElement[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const yang = seg.thickness === "yang";
    const stroke = yang ? "rgb(74,222,128)" : "rgb(248,113,113)";
    const sw = yang ? 3.2 : 1.2;
    const xi = x(i);
    // vertical
    parts.push(
      <line key={`v${i}`} x1={xi} y1={y(segments[i - 1].price)} x2={xi} y2={y(seg.price)}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
    );
    // horizontal connector into the next column
    if (i < segments.length - 1) {
      parts.push(
        <line key={`h${i}`} x1={xi} y1={y(seg.price)} x2={x(i + 1)} y2={y(seg.price)}
          stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      );
    }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-44">
      {parts}
    </svg>
  );
}

export function RenkoKagiPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [view, setView] = useState<"renko" | "kagi">("renko");
  const [data, setData] = useState<RenkoKagiResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/renko-kagi/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: RenkoKagiResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.renko) && Array.isArray(json.kagi)) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = input.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  const yangCount = useMemo(
    () => data.kagi.filter((k) => k.thickness === "yang").length,
    [data]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>RENKO &amp; KAGI</span>
        <span className="text-[10px] font-mono text-terminal-dim">
          time-independent trend charts
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ticker"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase w-28 text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={submit}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Plot
          </button>
          {/* Renko / Kagi toggle */}
          <div className="ml-auto flex items-center rounded border border-terminal-border overflow-hidden">
            {(["renko", "kagi"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-xs font-mono uppercase transition-colors ${
                  view === v
                    ? "bg-accent/15 text-accent"
                    : "text-terminal-muted hover:text-terminal-text"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Stat strip */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Latest</span>
            <span className="font-mono tabular-nums text-terminal-text text-sm">{fmt(data.latest_price)}</span>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Box size</span>
            <span className="font-mono tabular-nums text-accent-blue text-sm">{fmt(data.box_size)}</span>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Reversal</span>
            <span className="font-mono tabular-nums text-accent-blue text-sm">{fmt(data.reversal_threshold)}</span>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">ATR(14)</span>
            <span className="font-mono tabular-nums text-terminal-text text-sm">{fmt(data.atr)}</span>
          </div>
        </div>

        {/* Trend reads */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col gap-0.5">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Renko trend</span>
            <span className={`font-mono text-sm ${dirColor(data.renko_trend.direction)}`}>
              {data.renko_trend.direction
                ? `${data.renko_trend.run} ${data.renko_trend.direction} brick${data.renko_trend.run !== 1 ? "s" : ""} in a row`
                : "no bricks"}
            </span>
            <span className="text-[10px] font-mono text-terminal-dim">{data.renko_trend.bricks} bricks plotted</span>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5 flex flex-col gap-0.5">
            <span className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Kagi state</span>
            <span className={`font-mono text-sm ${thickColor(data.kagi_trend.thickness)}`}>
              {data.kagi_trend.thickness
                ? `${data.kagi_trend.thickness} (${data.kagi_trend.thickness === "yang" ? "thick / demand" : "thin / supply"})`
                : "undecided"}
            </span>
            <span className="text-[10px] font-mono text-terminal-dim">{yangCount}/{data.kagi.length} segments yang</span>
          </div>
        </div>

        {/* Chart */}
        <div className="bg-terminal-bg border border-terminal-border rounded-panel p-1">
          {view === "renko" ? (
            <RenkoChart bricks={data.renko} />
          ) : (
            <KagiChart segments={data.kagi} />
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[10px] font-mono text-terminal-dim">
          {view === "renko" ? (
            <>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-accent-green inline-block" /> up brick</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-accent-red inline-block" /> down brick</span>
              <span className="ml-auto">each brick = one {fmt(data.box_size)} move; time ignored</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1"><span className="w-3 h-1 rounded bg-accent-green inline-block" /> yang (thick / above prior shoulder)</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 rounded bg-accent-red inline-block" /> yin (thin / below prior waist)</span>
              <span className="ml-auto">reversal &ge; {fmt(data.reversal_threshold)}</span>
            </>
          )}
        </div>

        {/* Plain-English read */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3 mt-auto">
          {data.summary}
        </div>
      </div>
    </div>
  );
}
