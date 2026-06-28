import { useEffect, useMemo, useRef, useState } from "react";

// ── Local types (decoupled from api/types.ts on purpose) ─────────────────────
interface StrategyLeg {
  action: "Buy" | "Sell";
  type: "Call" | "Put" | "Stock";
  strike: number;
  premium: number;
  qty: number;
  iv: number | null;
}
interface PayoffPoint {
  price: number;
  pnl: number;
}
interface StrategyResponse {
  symbol: string;
  strategy: string;
  strategy_name: string;
  description: string;
  spot: number;
  expiry_days: number;
  legs: StrategyLeg[];
  net_debit: number;
  max_profit: number | null;
  max_loss: number | null;
  breakevens: number[];
  payoff: PayoffPoint[];
  net_delta: number;
  net_gamma: number;
  net_theta: number;
  net_vega: number;
  data_mode: string;
  as_of: string;
  source: string;
}

// Hardcoded locally so the dropdown renders without the list route; labels are
// refreshed from /api/options-strategy-list when it resolves.
const STRATEGY_OPTIONS: { id: string; name: string }[] = [
  { id: "long_call", name: "Long Call" },
  { id: "long_put", name: "Long Put" },
  { id: "covered_call", name: "Covered Call" },
  { id: "bull_call_spread", name: "Bull Call Spread" },
  { id: "bear_put_spread", name: "Bear Put Spread" },
  { id: "straddle", name: "Long Straddle" },
  { id: "strangle", name: "Long Strangle" },
  { id: "iron_condor", name: "Iron Condor" },
  { id: "butterfly", name: "Call Butterfly" },
];

// ── Local fallback so the panel renders fully populated immediately ──────────
const FALLBACK_LEGS = [
  { action: "Sell", type: "Put", strike: 202.5, premium: 3.07, qty: 1 },
  { action: "Buy", type: "Put", strike: 190.0, premium: 1.02, qty: 1 },
  { action: "Sell", type: "Call", strike: 222.5, premium: 3.41, qty: 1 },
  { action: "Buy", type: "Call", strike: 235.0, premium: 1.18, qty: 1 },
] as const;

const FALLBACK: StrategyResponse = {
  symbol: "AAPL",
  strategy: "iron_condor",
  strategy_name: "Iron Condor",
  description: "Range-bound, net credit. Profits if price stays inside the short strikes.",
  spot: 212.5,
  expiry_days: 37,
  legs: [
    { action: "Sell", type: "Put", strike: 202.5, premium: 3.07, qty: 1, iv: 0.28 },
    { action: "Buy", type: "Put", strike: 190.0, premium: 1.02, qty: 1, iv: 0.28 },
    { action: "Sell", type: "Call", strike: 222.5, premium: 3.41, qty: 1, iv: 0.28 },
    { action: "Buy", type: "Call", strike: 235.0, premium: 1.18, qty: 1, iv: 0.28 },
  ],
  net_debit: -428.0,
  max_profit: 428.0,
  max_loss: -822.0,
  breakevens: [198.22, 226.78],
  payoff: buildFallbackPayoff(),
  net_delta: 2.1,
  net_gamma: -0.83,
  net_theta: 6.4,
  net_vega: -18.7,
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "sample",
};

function buildFallbackPayoff(): PayoffPoint[] {
  const spot = 212.5;
  const legs = FALLBACK_LEGS;
  const lo = spot * 0.75;
  const hi = spot * 1.25;
  const pts: PayoffPoint[] = [];
  for (let i = 0; i < 41; i++) {
    const px = lo + ((hi - lo) * i) / 40;
    let pnl = 0;
    for (const l of legs) {
      const sign = l.action === "Buy" ? 1 : -1;
      const intr =
        l.type === "Call" ? Math.max(px - l.strike, 0) : Math.max(l.strike - px, 0);
      pnl += sign * (intr - l.premium) * l.qty * 100;
    }
    pts.push({ price: Math.round(px * 100) / 100, pnl: Math.round(pnl * 100) / 100 });
  }
  return pts;
}

// ── Formatting helpers ───────────────────────────────────────────────────────
const fmtMoney = (v: number | null, unlimited = "Unlimited"): string => {
  if (v === null) return unlimited;
  const a = Math.abs(v);
  const s = a >= 1000 ? `$${(a / 1000).toFixed(2)}k` : `$${a.toFixed(0)}`;
  return v < 0 ? `-${s}` : s;
};
const fmtNum = (v: number, d = 2) => v.toFixed(d);

export function OptionsStrategyPanel() {
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [strategy, setStrategy] = useState("iron_condor");
  const [data, setData] = useState<StrategyResponse>(FALLBACK);
  const [labels, setLabels] = useState(STRATEGY_OPTIONS);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // One-time: refresh dropdown labels from the list route.
  useEffect(() => {
    let alive = true;
    fetch("/api/options-strategy-list")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j || !Array.isArray(j.strategies) || j.strategies.length === 0) return;
        setLabels(j.strategies.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
      })
      .catch(() => void 0);
    return () => {
      alive = false;
    };
  }, []);

  // Fetch the analysis whenever symbol or strategy changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/options-strategy/${encodeURIComponent(symbol)}?strategy=${encodeURIComponent(strategy)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: StrategyResponse) => {
        if (!alive) return;
        if (j && Array.isArray(j.payoff) && j.payoff.length > 0) setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol, strategy]);

  const submitSymbol = () => {
    const s = symbolInput.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>OPTIONS STRATEGY BUILDER</span>
        <span className="text-2xs font-mono text-terminal-dim">
          {data.symbol} - {data.expiry_days}D - IV 28%
        </span>
      </div>

      <div className="panel-body flex-1 overflow-auto flex flex-col gap-3">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-2xs uppercase tracking-wide text-terminal-dim">Symbol</span>
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSymbol()}
              className="w-24 bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase text-terminal-text focus:border-accent focus:outline-none"
              placeholder="AAPL"
            />
          </div>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm text-terminal-text focus:border-accent focus:outline-none"
          >
            {labels.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="text-2xs font-mono text-terminal-muted ml-auto">
            Spot <span className="text-terminal-text tabular-nums">${fmtNum(data.spot)}</span>
            {loading && <span className="text-accent-amber ml-2">Loading...</span>}
            {err && !loading && <span className="text-terminal-dim ml-2">offline - showing model</span>}
          </span>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-2">
          <Kpi
            label="Max Profit"
            value={fmtMoney(data.max_profit)}
            tone={data.max_profit === null || data.max_profit >= 0 ? "green" : "red"}
          />
          <Kpi label="Max Loss" value={fmtMoney(data.max_loss)} tone="red" />
          <Kpi
            label={data.net_debit >= 0 ? "Net Debit" : "Net Credit"}
            value={fmtMoney(Math.abs(data.net_debit))}
            tone={data.net_debit >= 0 ? "amber" : "green"}
          />
          <Kpi
            label={data.breakevens.length > 1 ? "Breakevens" : "Breakeven"}
            value={
              data.breakevens.length
                ? data.breakevens.map((b) => `$${fmtNum(b)}`).join(" / ")
                : "n/a"
            }
            tone="blue"
            small
          />
        </div>

        {/* Payoff diagram (hero) */}
        <PayoffChart data={data} />

        {/* Legs + greeks */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <div className="text-2xs uppercase tracking-wide text-terminal-dim mb-1">
              Position Legs - {data.strategy_name}
            </div>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-terminal-dim border-b border-terminal-divider">
                  <th className="text-left font-normal py-1">Action</th>
                  <th className="text-left font-normal py-1">Type</th>
                  <th className="text-right font-normal py-1">Strike</th>
                  <th className="text-right font-normal py-1">Premium</th>
                  <th className="text-right font-normal py-1">Qty</th>
                  <th className="text-right font-normal py-1">IV</th>
                </tr>
              </thead>
              <tbody>
                {data.legs.map((l, i) => (
                  <tr key={i} className="border-b border-terminal-divider/40">
                    <td
                      className={`py-1 font-semibold ${
                        l.action === "Buy" ? "text-accent-green" : "text-accent-red"
                      }`}
                    >
                      {l.action}
                    </td>
                    <td className="py-1 text-terminal-text">{l.type}</td>
                    <td className="py-1 text-right tabular-nums text-terminal-text">
                      {l.type === "Stock" ? "-" : `$${fmtNum(l.strike)}`}
                    </td>
                    <td className="py-1 text-right tabular-nums text-terminal-muted">
                      ${fmtNum(l.premium)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-terminal-text">{l.qty}</td>
                    <td className="py-1 text-right tabular-nums text-terminal-dim">
                      {l.iv === null ? "-" : `${(l.iv * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
                {data.legs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-2 text-center text-terminal-dim">
                      No legs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-2xs uppercase tracking-wide text-terminal-dim mb-1">
              Position Greeks
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Greek label="Delta" value={fmtNum(data.net_delta)} signed={data.net_delta} />
              <Greek label="Gamma" value={fmtNum(data.net_gamma, 3)} signed={data.net_gamma} />
              <Greek
                label="Theta /day"
                value={`$${fmtNum(data.net_theta)}`}
                signed={data.net_theta}
              />
              <Greek
                label="Vega /pt"
                value={`$${fmtNum(data.net_vega)}`}
                signed={data.net_vega}
              />
            </div>
          </div>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim pt-1 border-t border-terminal-divider mt-auto">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "rgba(52,211,153,0.45)" }} />
              Profit
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "rgba(248,113,113,0.45)" }} />
              Loss
            </span>
          </span>
          <span className="font-mono">P&amp;L at expiry - per contract block (x100)</span>
        </div>
      </div>
    </div>
  );
}

// ── KPI cell ─────────────────────────────────────────────────────────────────
function Kpi({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber" | "blue";
  small?: boolean;
}) {
  const toneClass = {
    green: "text-accent-green",
    red: "text-accent-red",
    amber: "text-accent-amber",
    blue: "text-accent-blue",
  }[tone];
  return (
    <div className="bg-terminal-bg border border-terminal-border rounded-panel px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-terminal-dim">{label}</div>
      <div className={`${small ? "text-sm" : "stat-figure text-xl"} ${toneClass} tabular-nums leading-tight`}>
        {value}
      </div>
    </div>
  );
}

// ── Greek cell ───────────────────────────────────────────────────────────────
function Greek({ label, value, signed }: { label: string; value: string; signed: number }) {
  const tone = signed > 0 ? "text-accent-green" : signed < 0 ? "text-accent-red" : "text-terminal-text";
  return (
    <div className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wide text-terminal-dim">{label}</div>
      <div className={`text-sm font-mono tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

// ── Payoff diagram (inline SVG, the hero) ────────────────────────────────────
function PayoffChart({ data }: { data: StrategyResponse }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const H = 240;
  const PAD = { t: 14, r: 14, b: 26, l: 50 };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 100) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const pts = data.payoff;
    if (pts.length === 0) return null;
    const xs = pts.map((p) => p.price);
    const ys = pts.map((p) => p.pnl);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    let yMin = Math.min(...ys, 0);
    let yMax = Math.max(...ys, 0);
    const padY = (yMax - yMin) * 0.08 || 1;
    yMin -= padY;
    yMax += padY;

    const iw = w - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const sx = (px: number) => PAD.l + ((px - xMin) / (xMax - xMin || 1)) * iw;
    const sy = (py: number) => PAD.t + (1 - (py - yMin) / (yMax - yMin || 1)) * ih;

    const zeroY = sy(0);
    const line = pts.map((p) => `${sx(p.price)},${sy(p.pnl)}`).join(" ");

    // Profit polygon (clip line to zero baseline) and loss polygon.
    const profitArea = areaToBaseline(pts, sx, sy, zeroY, "profit");
    const lossArea = areaToBaseline(pts, sx, sy, zeroY, "loss");

    return { xMin, xMax, yMin, yMax, sx, sy, zeroY, line, profitArea, lossArea, iw, ih };
  }, [data, w]);

  if (!geom) {
    return (
      <div ref={wrapRef} className="bg-terminal-bg border border-terminal-border rounded-panel h-[240px] flex items-center justify-center text-terminal-dim text-xs">
        No payoff data.
      </div>
    );
  }

  const yTicks = niceTicks(geom.yMin, geom.yMax, 4);
  const xTicks = niceTicks(geom.xMin, geom.xMax, 5);

  return (
    <div ref={wrapRef} className="bg-terminal-bg border border-terminal-border rounded-panel shadow-panel px-1 py-1">
      <svg width={w} height={H} className="block">
        <defs>
          <linearGradient id="osa-profit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(52,211,153,0.42)" />
            <stop offset="100%" stopColor="rgba(52,211,153,0.04)" />
          </linearGradient>
          <linearGradient id="osa-loss" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgba(248,113,113,0.42)" />
            <stop offset="100%" stopColor="rgba(248,113,113,0.04)" />
          </linearGradient>
        </defs>

        {/* Y grid + labels */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD.l}
              x2={w - PAD.r}
              y1={geom.sy(t)}
              y2={geom.sy(t)}
              stroke="currentColor"
              className="text-terminal-divider"
              strokeWidth={0.5}
              opacity={0.5}
            />
            <text x={PAD.l - 6} y={geom.sy(t) + 3} textAnchor="end" className="fill-terminal-dim" fontSize={9} fontFamily="monospace">
              {t >= 0 ? "" : "-"}${Math.abs(Math.round(t))}
            </text>
          </g>
        ))}

        {/* X labels */}
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={geom.sx(t)} y={H - 8} textAnchor="middle" className="fill-terminal-dim" fontSize={9} fontFamily="monospace">
            ${Math.round(t)}
          </text>
        ))}

        {/* Filled profit / loss regions */}
        <path d={geom.profitArea} fill="url(#osa-profit)" />
        <path d={geom.lossArea} fill="url(#osa-loss)" />

        {/* Zero line */}
        <line
          x1={PAD.l}
          x2={w - PAD.r}
          y1={geom.zeroY}
          y2={geom.zeroY}
          stroke="currentColor"
          className="text-terminal-muted"
          strokeWidth={1}
        />

        {/* Spot marker */}
        <line
          x1={geom.sx(data.spot)}
          x2={geom.sx(data.spot)}
          y1={PAD.t}
          y2={H - PAD.b}
          stroke="currentColor"
          className="text-accent-blue"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.8}
        />
        <text x={geom.sx(data.spot)} y={PAD.t + 8} textAnchor="middle" className="fill-accent-blue" fontSize={9} fontFamily="monospace">
          Spot ${fmtNum(data.spot)}
        </text>

        {/* Breakeven markers */}
        {data.breakevens.map((b, i) => (
          <g key={`be${i}`}>
            <line
              x1={geom.sx(b)}
              x2={geom.sx(b)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="currentColor"
              className="text-accent-amber"
              strokeWidth={0.75}
              strokeDasharray="2 4"
              opacity={0.7}
            />
            <circle cx={geom.sx(b)} cy={geom.zeroY} r={3} className="fill-accent-amber" />
            <text x={geom.sx(b)} y={H - PAD.b + 0} textAnchor="middle" className="fill-accent-amber" fontSize={8} fontFamily="monospace">
              BE ${fmtNum(b)}
            </text>
          </g>
        ))}

        {/* P&L curve */}
        <polyline points={geom.line} fill="none" stroke="currentColor" className="text-terminal-text" strokeWidth={1.75} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// Build an area path that fills only the profit (above 0) or loss (below 0)
// portion of the payoff curve down/up to the zero baseline, splitting segments
// at zero crossings so the fills meet cleanly.
function areaToBaseline(
  pts: PayoffPoint[],
  sx: (n: number) => number,
  sy: (n: number) => number,
  zeroY: number,
  which: "profit" | "loss"
): string {
  const want = (pnl: number) => (which === "profit" ? pnl >= 0 : pnl <= 0);
  let d = "";
  let i = 0;
  const n = pts.length;
  while (i < n) {
    if (!want(pts[i].pnl)) {
      i++;
      continue;
    }
    // start of a run
    const run: { x: number; y: number }[] = [];
    // entry crossing from previous point
    if (i > 0 && !want(pts[i - 1].pnl)) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (0 - a.pnl) / (b.pnl - a.pnl || 1);
      const cx = a.price + (b.price - a.price) * t;
      run.push({ x: sx(cx), y: zeroY });
    }
    while (i < n && want(pts[i].pnl)) {
      run.push({ x: sx(pts[i].price), y: sy(pts[i].pnl) });
      i++;
    }
    // exit crossing to next point
    if (i < n) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (0 - a.pnl) / (b.pnl - a.pnl || 1);
      const cx = a.price + (b.price - a.price) * t;
      run.push({ x: sx(cx), y: zeroY });
    }
    if (run.length >= 2) {
      d += `M ${run[0].x} ${zeroY} `;
      for (const p of run) d += `L ${p.x} ${p.y} `;
      d += `L ${run[run.length - 1].x} ${zeroY} Z `;
    }
  }
  return d;
}

// Generate evenly-spaced "nice" tick values across a range.
function niceTicks(min: number, max: number, count: number): number[] {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}
