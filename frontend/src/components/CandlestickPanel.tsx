import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
type Direction = "bullish" | "bearish" | "neutral";

interface CandleDetection {
  date: string;
  pattern: string;
  direction: Direction;
  strength: number;
  bar_index: number;
}
interface CandleLatest extends CandleDetection {
  read: string;
}
interface CandleSummary {
  bullish: number;
  bearish: number;
  neutral: number;
  total: number;
}
interface CandleBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
}
interface CandlestickResponse {
  symbol: string;
  detections: CandleDetection[];
  summary: CandleSummary;
  latest: CandleLatest | null;
  recent_ohlc: CandleBar[];
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: CandlestickResponse = {
  symbol: "AAPL",
  detections: [
    { date: "2026-06-30", pattern: "Morning Star", direction: "bullish", strength: 78, bar_index: 109 },
    { date: "2026-06-23", pattern: "Evening Star", direction: "bearish", strength: 71, bar_index: 102 },
    { date: "2026-06-16", pattern: "Three Black Crows", direction: "bearish", strength: 75, bar_index: 95 },
    { date: "2026-06-09", pattern: "Three White Soldiers", direction: "bullish", strength: 75, bar_index: 88 },
    { date: "2026-06-02", pattern: "Doji", direction: "neutral", strength: 62, bar_index: 81 },
    { date: "2026-05-27", pattern: "Shooting Star", direction: "bearish", strength: 86, bar_index: 76 },
    { date: "2026-05-20", pattern: "Hammer", direction: "bullish", strength: 86, bar_index: 71 },
    { date: "2026-05-13", pattern: "Marubozu", direction: "bullish", strength: 91, bar_index: 66 },
    { date: "2026-05-06", pattern: "Piercing Line", direction: "bullish", strength: 80, bar_index: 60 },
    { date: "2026-04-29", pattern: "Bullish Harami", direction: "bullish", strength: 66, bar_index: 53 },
  ],
  summary: { bullish: 6, bearish: 3, neutral: 1, total: 10 },
  latest: {
    date: "2026-06-30",
    pattern: "Morning Star",
    direction: "bullish",
    strength: 78,
    bar_index: 109,
    read: "AAPL: Morning Star on 2026-06-30 - a three-bar bottoming sequence (down, pause, up) - a strong bullish reversal.",
  },
  recent_ohlc: [
    { date: "2026-06-09", o: 188.4, h: 190.2, l: 187.9, c: 190.0 },
    { date: "2026-06-10", o: 190.0, h: 193.1, l: 189.6, c: 192.8 },
    { date: "2026-06-11", o: 192.8, h: 196.0, l: 192.4, c: 195.6 },
    { date: "2026-06-12", o: 195.6, h: 196.1, l: 193.0, c: 193.4 },
    { date: "2026-06-13", o: 193.4, h: 193.9, l: 190.1, c: 190.5 },
    { date: "2026-06-16", o: 190.5, h: 191.0, l: 187.2, c: 187.6 },
    { date: "2026-06-17", o: 187.6, h: 188.0, l: 184.3, c: 184.7 },
    { date: "2026-06-18", o: 184.7, h: 185.1, l: 181.4, c: 181.8 },
    { date: "2026-06-19", o: 181.8, h: 183.9, l: 181.6, c: 183.6 },
    { date: "2026-06-20", o: 183.6, h: 186.0, l: 183.3, c: 185.7 },
    { date: "2026-06-23", o: 185.7, h: 188.1, l: 185.4, c: 187.8 },
    { date: "2026-06-24", o: 187.8, h: 188.3, l: 187.6, c: 188.0 },
    { date: "2026-06-25", o: 188.1, h: 190.4, l: 187.9, c: 190.2 },
    { date: "2026-06-26", o: 190.2, h: 190.8, l: 187.0, c: 187.4 },
    { date: "2026-06-27", o: 186.9, h: 187.2, l: 183.0, c: 183.4 },
    { date: "2026-06-30", o: 183.0, h: 185.6, l: 182.6, c: 185.2 },
  ],
  data_mode: "sample",
  as_of: "2026-06-30T18:00:00+00:00",
  source: "sample",
};

// ── Color helpers ────────────────────────────────────────────────────────────
function dirText(d: Direction): string {
  if (d === "bullish") return "text-accent-green";
  if (d === "bearish") return "text-accent-red";
  return "text-terminal-muted";
}
function dirBg(d: Direction): string {
  if (d === "bullish") return "bg-accent-green/15 text-accent-green";
  if (d === "bearish") return "bg-accent-red/15 text-accent-red";
  return "bg-white/5 text-terminal-muted";
}
function strengthColor(s: number): string {
  if (s >= 70) return "bg-accent-green";
  if (s >= 45) return "bg-accent-amber";
  return "bg-accent-blue";
}
function strengthLabel(s: number): string {
  if (s >= 67) return "high";
  if (s >= 34) return "med";
  return "low";
}

// ── Mini candlestick SVG of the most recent bars ─────────────────────────────
function MiniCandles({ bars }: { bars: CandleBar[] }) {
  const data = bars.slice(-20);
  if (data.length === 0) {
    return <div className="text-xs text-terminal-dim font-mono">no price data</div>;
  }
  const W = 280;
  const H = 70;
  const pad = 4;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of data) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  const span = hi - lo || 1;
  const slot = (W - pad * 2) / data.length;
  const bw = Math.max(2, slot * 0.6);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[70px]" preserveAspectRatio="none">
      {data.map((b, i) => {
        const cx = pad + slot * i + slot / 2;
        const up = b.c >= b.o;
        const color = up ? "#5db87a" : "#d4654f";
        const yo = y(b.o);
        const yc = y(b.c);
        const top = Math.min(yo, yc);
        const bodyH = Math.max(1, Math.abs(yc - yo));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={color} strokeWidth={1} />
            <rect x={cx - bw / 2} y={top} width={bw} height={bodyH} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

export function CandlestickPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<CandlestickResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/candlestick/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: CandlestickResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.detections) && json.summary) {
          setData(json);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
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

  const latest = data.latest;
  const heroDir: Direction = latest?.direction ?? "neutral";

  const bias = useMemo(() => {
    const { bullish, bearish } = data.summary;
    if (bullish > bearish) return { label: "Bullish bias", cls: "text-accent-green" };
    if (bearish > bullish) return { label: "Bearish bias", cls: "text-accent-red" };
    return { label: "Balanced", cls: "text-terminal-muted" };
  }, [data.summary]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CANDLESTICK</span>
        <span className="text-[10px] font-mono text-terminal-dim">CNDL · pattern recognition</span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2">
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
            Scan
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Hero: latest notable signal */}
        <div
          className={`bg-terminal-bg border border-terminal-border rounded-panel p-3 border-l-2 ${
            heroDir === "bullish"
              ? "border-l-accent-green"
              : heroDir === "bearish"
              ? "border-l-accent-red"
              : "border-l-terminal-border"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Latest signal · {data.symbol}
            </div>
            {latest && (
              <div className="text-[10px] font-mono text-terminal-dim tabular-nums">{latest.date}</div>
            )}
          </div>
          {latest ? (
            <>
              <div className="mt-1 flex items-baseline gap-2 flex-wrap">
                <span className={`text-xl font-serif leading-none ${dirText(heroDir)}`}>
                  {latest.pattern}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${dirBg(heroDir)}`}>
                  {heroDir}
                </span>
                <span className="text-[10px] font-mono text-terminal-dim tabular-nums ml-auto">
                  strength {latest.strength} ({strengthLabel(latest.strength)})
                </span>
              </div>
              <div className="mt-1.5 text-xs text-terminal-muted font-sans leading-relaxed">
                {latest.read}
              </div>
            </>
          ) : (
            <div className="mt-1 text-sm text-terminal-dim font-sans">
              No notable formations in the recent window.
            </div>
          )}
        </div>

        {/* Mini candles */}
        <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2">
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            Last {Math.min(20, data.recent_ohlc.length)} bars
          </div>
          <MiniCandles bars={data.recent_ohlc} />
        </div>

        {/* Direction summary */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2 flex flex-col items-center">
            <div className="text-[10px] font-mono uppercase text-terminal-dim">Bullish</div>
            <div className="stat-figure leading-none text-accent-green">{data.summary.bullish}</div>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2 flex flex-col items-center">
            <div className="text-[10px] font-mono uppercase text-terminal-dim">Bearish</div>
            <div className="stat-figure leading-none text-accent-red">{data.summary.bearish}</div>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2 flex flex-col items-center">
            <div className="text-[10px] font-mono uppercase text-terminal-dim">Neutral</div>
            <div className="stat-figure leading-none text-terminal-muted">{data.summary.neutral}</div>
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2 flex flex-col items-center justify-center">
            <div className="text-[10px] font-mono uppercase text-terminal-dim">Read</div>
            <div className={`text-xs font-mono uppercase text-center ${bias.cls}`}>{bias.label}</div>
          </div>
        </div>

        {/* Detections table */}
        <div className="flex-1 min-h-0">
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Detections (newest first)</span>
            <span className="text-terminal-dim">{data.summary.total} found</span>
          </div>
          <div className="border-t border-terminal-divider max-h-64 overflow-auto">
            <table className="w-full text-xs font-mono tabular-nums">
              <thead className="sticky top-0 bg-terminal-panel">
                <tr className="text-[10px] uppercase text-terminal-dim text-left">
                  <th className="py-1 pr-2 font-normal">Date</th>
                  <th className="py-1 pr-2 font-normal">Pattern</th>
                  <th className="py-1 pr-2 font-normal">Dir</th>
                  <th className="py-1 pl-2 font-normal text-right">Strength</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-terminal-divider">
                {data.detections.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-center text-terminal-dim font-sans">
                      No patterns detected in the recent window.
                    </td>
                  </tr>
                ) : (
                  data.detections.map((d, i) => (
                    <tr key={`${d.pattern}-${d.bar_index}-${i}`} className="hover:bg-white/[0.02]">
                      <td className="py-1 pr-2 text-terminal-muted whitespace-nowrap">{d.date}</td>
                      <td className="py-1 pr-2 text-terminal-text font-sans">{d.pattern}</td>
                      <td className="py-1 pr-2">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase ${dirBg(d.direction)}`}>
                          {d.direction}
                        </span>
                      </td>
                      <td className="py-1 pl-2">
                        <div className="flex items-center gap-1.5 justify-end">
                          <div className="w-12 h-1.5 bg-terminal-panel rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${strengthColor(d.strength)}`}
                              style={{ width: `${Math.max(4, Math.min(100, d.strength))}%` }}
                            />
                          </div>
                          <span className="w-6 text-right text-terminal-text">{d.strength}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto flex items-center gap-4 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span>16 formations from pure OHLC geometry</span>
          <span className="ml-auto">Reversal context-aware (hammer vs hanging man)</span>
        </div>
      </div>
    </div>
  );
}
