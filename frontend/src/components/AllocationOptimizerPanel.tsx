import { useEffect, useMemo, useState } from "react";

// ── Local interfaces (mirror backend app/data/allocation_optimizer.py) ────────
// The panel owns its own contract; it fetches the relative route directly and
// never imports from the shared client/types files (keeps wiring decoupled).

interface WeightRow {
  symbol: string;
  weight: number; // 0..1
}

interface RiskRow {
  symbol: string;
  pct: number; // 0..100, share of total portfolio variance
}

interface MethodRow {
  method: string;
  label: string;
  exp_return: number; // percent
  volatility: number; // percent
  sharpe: number;
}

interface FrontierPoint {
  volatility: number; // percent
  exp_return: number; // percent
}

interface OptimizerResponse {
  universe: string[];
  method: string;
  method_label: string;
  weights: WeightRow[];
  exp_return: number; // percent
  volatility: number; // percent
  sharpe: number;
  risk_free: number;
  risk_contributions: RiskRow[];
  all_methods: MethodRow[];
  correlation_matrix: { symbols: string[]; matrix: number[][] };
  efficient_frontier: FrontierPoint[];
  data_mode: "live" | "sample" | string;
  as_of: string;
  source: string;
}

const DEFAULT_SYMBOLS = "SPY,TLT,GLD,QQQ,IWM,EFA,VNQ,LQD";

const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "equal_weight", label: "Equal Weight" },
  { value: "min_variance", label: "Min Variance" },
  { value: "max_sharpe", label: "Max Sharpe" },
  { value: "risk_parity", label: "Risk Parity" },
];

// Local fallback so the panel renders fully populated before the backend
// responds (clean screenshots, never an empty box).
const FALLBACK: OptimizerResponse = {
  universe: ["SPY", "TLT", "GLD", "QQQ", "IWM", "EFA", "VNQ", "LQD"],
  method: "risk_parity",
  method_label: "Risk Parity",
  weights: [
    { symbol: "SPY", weight: 0.109 },
    { symbol: "TLT", weight: 0.192 },
    { symbol: "GLD", weight: 0.074 },
    { symbol: "QQQ", weight: 0.085 },
    { symbol: "IWM", weight: 0.069 },
    { symbol: "EFA", weight: 0.082 },
    { symbol: "VNQ", weight: 0.128 },
    { symbol: "LQD", weight: 0.261 },
  ],
  exp_return: 11.46,
  volatility: 8.75,
  sharpe: 0.795,
  risk_free: 4.5,
  risk_contributions: [
    { symbol: "SPY", pct: 12.5 },
    { symbol: "TLT", pct: 12.5 },
    { symbol: "GLD", pct: 12.5 },
    { symbol: "QQQ", pct: 12.5 },
    { symbol: "IWM", pct: 12.5 },
    { symbol: "EFA", pct: 12.5 },
    { symbol: "VNQ", pct: 12.5 },
    { symbol: "LQD", pct: 12.5 },
  ],
  all_methods: [
    { method: "equal_weight", label: "Equal Weight", exp_return: 16.63, volatility: 10.92, sharpe: 1.111 },
    { method: "min_variance", label: "Min Variance", exp_return: 3.04, volatility: 5.68, sharpe: -0.256 },
    { method: "max_sharpe", label: "Max Sharpe", exp_return: 14.23, volatility: 10.01, sharpe: 0.972 },
    { method: "risk_parity", label: "Risk Parity", exp_return: 11.46, volatility: 8.75, sharpe: 0.795 },
  ],
  correlation_matrix: { symbols: [], matrix: [] },
  efficient_frontier: [
    { volatility: 5.68, exp_return: 3.04 },
    { volatility: 6.4, exp_return: 5.1 },
    { volatility: 7.2, exp_return: 7.0 },
    { volatility: 8.1, exp_return: 9.3 },
    { volatility: 8.75, exp_return: 11.46 },
    { volatility: 10.01, exp_return: 14.23 },
    { volatility: 10.92, exp_return: 16.63 },
    { volatility: 12.4, exp_return: 17.9 },
    { volatility: 14.1, exp_return: 18.8 },
    { volatility: 17.74, exp_return: 19.83 },
  ],
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

const CLAY = "#c9785c";

export function AllocationOptimizerPanel() {
  const [symbolsInput, setSymbolsInput] = useState(DEFAULT_SYMBOLS);
  const [method, setMethod] = useState("risk_parity");
  const [data, setData] = useState<OptimizerResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (symbols: string, m: string) => {
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({ symbols: symbols.trim() || DEFAULT_SYMBOLS, method: m });
    fetch(`/api/allocation-optimizer?${qs.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as OptimizerResponse;
        if (json && Array.isArray(json.weights) && json.weights.length) {
          setData(json);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        // Keep the last good (or fallback) payload visible.
        setErr(String(e));
        setLoading(false);
      });
  };

  // Initial load + re-fetch when the method changes.
  useEffect(() => {
    run(symbolsInput, method);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  const submit = () => run(symbolsInput, method);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <span>Allocation Optimizer</span>
        <span className="text-terminal-dim normal-case tracking-normal">
          {data.method_label} &middot; {data.universe.length} assets &middot; rf {fmtPct(data.risk_free)}
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={symbolsInput}
            onChange={(e) => setSymbolsInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={DEFAULT_SYMBOLS}
            className="flex-1 min-w-[12rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-accent"
          />
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-terminal-bg disabled:opacity-40"
          >
            {loading ? "Optimizing..." : "Optimize"}
          </button>
        </div>

        {err && (
          <div className="text-2xs text-terminal-dim">
            Live fetch unavailable - showing last computed allocation.
          </div>
        )}

        {/* KPI strip */}
        <KpiStrip data={data} />

        {/* Weights vs risk-contribution visualization */}
        <Section title="Weights vs Risk Contribution">
          <WeightsViz weights={data.weights} risk={data.risk_contributions} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-2xs text-terminal-dim">
            <LegendSwatch color={CLAY} label="Capital weight" />
            <LegendSwatch color="rgba(110,146,196,0.85)" label="Risk share of variance" />
          </div>
        </Section>

        {/* Two-up: method comparison + efficient frontier */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title="Method Comparison">
            <MethodTable rows={data.all_methods} selected={data.method} />
          </Section>
          <Section title="Efficient Frontier">
            <FrontierScatter
              points={data.efficient_frontier}
              current={{ volatility: data.volatility, exp_return: data.exp_return }}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

// ── KPI strip ─────────────────────────────────────────────────────────────────

function KpiStrip({ data }: { data: OptimizerResponse }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      <Kpi
        label="Expected Return"
        figure={fmtPct(data.exp_return)}
        figureClass={data.exp_return >= 0 ? "text-accent-green" : "text-accent-red"}
        sub="annualized"
      />
      <Kpi label="Volatility" figure={fmtPct(data.volatility)} figureClass="text-terminal-text" sub="annualized" />
      <Kpi
        label="Sharpe"
        figure={data.sharpe.toFixed(2)}
        figureClass={data.sharpe >= 1 ? "text-accent-green" : data.sharpe >= 0 ? "text-accent-amber" : "text-accent-red"}
        sub={`rf ${fmtPct(data.risk_free)}`}
      />
      <Kpi label="# Assets" figure={String(data.universe.length)} figureClass="text-terminal-muted" sub="long only" />
    </div>
  );
}

function Kpi({
  label,
  figure,
  figureClass,
  sub,
}: {
  label: string;
  figure: string;
  figureClass: string;
  sub: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 flex flex-col gap-1">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`stat-figure text-2xl leading-none tabular-nums ${figureClass}`}>{figure}</div>
      <div className="text-2xs text-terminal-muted tabular-nums">{sub}</div>
    </div>
  );
}

// ── Weights vs risk-contribution bars ─────────────────────────────────────────

function WeightsViz({ weights, risk }: { weights: WeightRow[]; risk: RiskRow[] }) {
  const riskMap = useMemo(() => {
    const m: Record<string, number> = {};
    risk.forEach((r) => (m[r.symbol] = r.pct));
    return m;
  }, [risk]);

  const maxWeight = useMemo(
    () => Math.max(0.0001, ...weights.map((w) => w.weight)),
    [weights],
  );

  return (
    <div className="flex flex-col gap-1.5">
      {weights.map((w) => {
        const wPct = w.weight * 100;
        const rPct = riskMap[w.symbol] ?? 0;
        const barW = (w.weight / maxWeight) * 100;
        return (
          <div key={w.symbol} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-terminal-text w-12 shrink-0">{w.symbol}</span>
            <div className="flex-1 relative h-4 bg-terminal-panel/60 rounded-sm overflow-hidden">
              {/* Capital weight bar (clay) */}
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${barW}%`, backgroundColor: CLAY, opacity: 0.85 }}
              />
              {/* Risk-share marker (steel line) so weight vs risk reads instantly */}
              <div
                className="absolute inset-y-0 z-10"
                style={{
                  left: `${Math.min((rPct / 100 / maxWeight) * 100, 100)}%`,
                  borderLeft: "2px solid rgba(110,146,196,0.95)",
                }}
                title={`Risk share ${rPct.toFixed(1)}%`}
              />
            </div>
            <span className="font-mono tabular-nums text-terminal-text w-14 text-right shrink-0">
              {wPct.toFixed(1)}%
            </span>
            <span className="font-mono tabular-nums text-accent-blue w-16 text-right shrink-0" title="Risk contribution">
              {rPct.toFixed(1)}%
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-2 text-2xs text-terminal-dim mt-0.5">
        <span className="w-12 shrink-0" />
        <span className="flex-1" />
        <span className="w-14 text-right shrink-0 uppercase tracking-wider">weight</span>
        <span className="w-16 text-right shrink-0 uppercase tracking-wider">risk</span>
      </div>
    </div>
  );
}

// ── Method comparison table ───────────────────────────────────────────────────

function MethodTable({ rows, selected }: { rows: MethodRow[]; selected: string }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-2xs uppercase tracking-wider text-terminal-dim">
          <th className="text-left font-normal pb-1">Method</th>
          <th className="text-right font-normal pb-1">Return</th>
          <th className="text-right font-normal pb-1">Vol</th>
          <th className="text-right font-normal pb-1">Sharpe</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const active = r.method === selected;
          return (
            <tr
              key={r.method}
              className={
                active
                  ? "bg-accent/10 text-terminal-text"
                  : "text-terminal-muted hover:bg-terminal-bg/60"
              }
            >
              <td className="py-1 pl-1">
                <span className="flex items-center gap-1.5">
                  {active && <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CLAY }} />}
                  <span className={active ? "font-medium" : ""}>{r.label}</span>
                </span>
              </td>
              <td className="py-1 text-right font-mono tabular-nums">{fmtPct(r.exp_return)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmtPct(r.volatility)}</td>
              <td
                className={`py-1 pr-1 text-right font-mono tabular-nums ${
                  r.sharpe >= 1 ? "text-accent-green" : r.sharpe >= 0 ? "" : "text-accent-red"
                }`}
              >
                {r.sharpe.toFixed(2)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Efficient frontier scatter (inline SVG) ───────────────────────────────────

function FrontierScatter({
  points,
  current,
}: {
  points: FrontierPoint[];
  current: FrontierPoint;
}) {
  const W = 320;
  const H = 200;
  const pad = { l: 34, r: 8, t: 8, b: 24 };

  const all = points.length ? [...points, current] : [current];
  const xs = all.map((p) => p.volatility);
  const ys = all.map((p) => p.exp_return);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const sx = (v: number) => pad.l + ((v - xMin) / xSpan) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((v - yMin) / ySpan) * (H - pad.t - pad.b);

  const xTicks = [xMin, xMin + xSpan / 2, xMax];
  const yTicks = [yMin, yMin + ySpan / 2, yMax];

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }}>
        {/* Gridlines + axis ticks */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={pad.l} y1={sy(t)} x2={W - pad.r} y2={sy(t)} stroke="#2e2a24" strokeWidth={1} />
            <text x={pad.l - 4} y={sy(t) + 3} textAnchor="end" fontSize={8} fill="#6e665a" fontFamily="JetBrains Mono, monospace">
              {t.toFixed(0)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={sx(t)}
            y={H - pad.b + 12}
            textAnchor="middle"
            fontSize={8}
            fill="#6e665a"
            fontFamily="JetBrains Mono, monospace"
          >
            {t.toFixed(0)}
          </text>
        ))}

        {/* Random-portfolio cloud */}
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.volatility)} cy={sy(p.exp_return)} r={2.4} fill="rgba(110,146,196,0.55)" />
        ))}

        {/* Current portfolio */}
        <circle cx={sx(current.volatility)} cy={sy(current.exp_return)} r={5} fill={CLAY} stroke="#1a1814" strokeWidth={1.5} />
        <text
          x={sx(current.volatility) + 8}
          y={sy(current.exp_return) - 6}
          fontSize={9}
          fill={CLAY}
          fontFamily="JetBrains Mono, monospace"
        >
          {current.exp_return.toFixed(1)}% / {current.volatility.toFixed(1)}%
        </text>

        {/* Axis labels */}
        <text x={(W + pad.l) / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#6e665a">
          Volatility (%)
        </text>
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-2xs text-terminal-dim">
        <LegendSwatch color={CLAY} label="Selected portfolio" />
        <LegendSwatch color="rgba(110,146,196,0.55)" label="Feasible portfolios" />
        <span className="text-terminal-dim">y = expected return (%)</span>
      </div>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block rounded-sm" style={{ width: "0.9rem", height: "0.55rem", backgroundColor: color }} />
      {label}
    </span>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(1)}%`;
}
