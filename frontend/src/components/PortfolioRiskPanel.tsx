import { useEffect, useMemo, useState } from "react";

// ── Local interfaces (mirror backend app/data/portfolio_risk.py) ──────────────
// The panel owns its own contract; it fetches the relative route directly and
// never imports from the shared client/types files (keeps wiring decoupled).

interface Holding {
  symbol: string;
  weight: number; // 0..1
}

interface StressScenario {
  scenario: string;
  pnl_pct: number; // percent, can be +/-
  description: string;
}

interface RiskContribution {
  symbol: string;
  pct: number; // 0..100, share of total portfolio variance
}

interface DistBucket {
  bucket: number; // daily return %, bin center
  count: number;
}

interface RiskResponse {
  holdings: Holding[];
  volatility: number; // annualized %
  beta: number;
  var_95_1d: number; // positive % loss
  var_99_1d: number;
  var_95_10d: number;
  var_99_10d: number;
  var_95_parametric: number;
  var_99_parametric: number;
  expected_shortfall_95: number;
  max_drawdown: number; // positive %
  sharpe: number;
  stress_scenarios: StressScenario[];
  risk_contributions: RiskContribution[];
  return_distribution: DistBucket[];
  data_mode: "live" | "sample" | string;
  as_of: string;
  source: string;
}

const DEFAULT_SYMBOLS = "SPY,QQQ,TLT,GLD,IWM,EFA,VNQ";
const DEFAULT_WEIGHTS = "35,15,15,10,10,10,5";

const CLAY = "#c9785c";
const RED = "#cc6a5a";
const STEEL = "rgba(110,146,196,0.85)";

// Local fallback so the panel renders fully populated before the backend
// responds (clean screenshots, never an empty box).
const FALLBACK: RiskResponse = {
  holdings: [
    { symbol: "SPY", weight: 0.35 },
    { symbol: "QQQ", weight: 0.15 },
    { symbol: "TLT", weight: 0.15 },
    { symbol: "GLD", weight: 0.1 },
    { symbol: "IWM", weight: 0.1 },
    { symbol: "EFA", weight: 0.1 },
    { symbol: "VNQ", weight: 0.05 },
  ],
  volatility: 11.81,
  beta: 0.886,
  var_95_1d: 1.25,
  var_99_1d: 1.77,
  var_95_10d: 3.94,
  var_99_10d: 5.59,
  var_95_parametric: 1.15,
  var_99_parametric: 1.66,
  expected_shortfall_95: 1.67,
  max_drawdown: 8.68,
  sharpe: 1.194,
  stress_scenarios: [
    { scenario: "2008 GFC", pnl_pct: -35.97, description: "Global financial crisis - equity collapse, credit seizure, flight to Treasuries." },
    { scenario: "COVID Crash Mar-2020", pnl_pct: -23.4, description: "Pandemic shock - fastest 30% equity drawdown on record, oil negative, gold and Treasuries bid." },
    { scenario: "2022 Rate Shock", pnl_pct: -16.8, description: "Fed hiking cycle - bonds and stocks fall together, long duration punished." },
    { scenario: "Rates +100bp", pnl_pct: -5.1, description: "Parallel +100bp curve shift - duration-driven loss on bonds, mild equity drag." },
    { scenario: "Oil +20%", pnl_pct: -0.6, description: "Crude spikes 20% - energy and commodities rally, broad equities soften." },
    { scenario: "USD +5%", pnl_pct: -1.4, description: "Dollar strengthens 5% - international, EM, gold and commodities pressured." },
  ],
  risk_contributions: [
    { symbol: "SPY", pct: 34.1 },
    { symbol: "QQQ", pct: 22.6 },
    { symbol: "TLT", pct: 4.2 },
    { symbol: "GLD", pct: 1.8 },
    { symbol: "IWM", pct: 15.9 },
    { symbol: "EFA", pct: 12.7 },
    { symbol: "VNQ", pct: 8.7 },
  ],
  return_distribution: [
    { bucket: -2.6, count: 1 }, { bucket: -2.3, count: 1 }, { bucket: -2.0, count: 2 },
    { bucket: -1.7, count: 3 }, { bucket: -1.4, count: 6 }, { bucket: -1.1, count: 10 },
    { bucket: -0.8, count: 16 }, { bucket: -0.5, count: 24 }, { bucket: -0.2, count: 34 },
    { bucket: 0.1, count: 38 }, { bucket: 0.4, count: 33 }, { bucket: 0.7, count: 25 },
    { bucket: 1.0, count: 17 }, { bucket: 1.3, count: 9 }, { bucket: 1.6, count: 5 },
    { bucket: 1.9, count: 3 }, { bucket: 2.2, count: 2 }, { bucket: 2.5, count: 1 },
    { bucket: 2.8, count: 1 }, { bucket: 3.1, count: 0 }, { bucket: 3.4, count: 1 },
  ],
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

export function PortfolioRiskPanel() {
  const [symbolsInput, setSymbolsInput] = useState(DEFAULT_SYMBOLS);
  const [weightsInput, setWeightsInput] = useState(DEFAULT_WEIGHTS);
  const [data, setData] = useState<RiskResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (symbols: string, weights: string) => {
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams();
    if (symbols.trim()) qs.set("symbols", symbols.trim());
    if (weights.trim()) qs.set("weights", weights.trim());
    fetch(`/api/portfolio-risk${qs.toString() ? `?${qs.toString()}` : ""}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RiskResponse;
        if (json && Array.isArray(json.holdings) && json.holdings.length) {
          setData(json);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    run(symbolsInput, weightsInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => run(symbolsInput, weightsInput);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <span>Portfolio Risk / VaR</span>
        <span className="text-terminal-dim normal-case tracking-normal">
          {data.holdings.length} holdings &middot; 95% / 99% confidence &middot; 1d horizon
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={symbolsInput}
            onChange={(e) => setSymbolsInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={DEFAULT_SYMBOLS}
            title="Comma-separated tickers"
            className="flex-1 min-w-[11rem] bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-accent"
          />
          <input
            type="text"
            value={weightsInput}
            onChange={(e) => setWeightsInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={DEFAULT_WEIGHTS}
            title="Comma-separated weights (auto-normalized)"
            className="w-40 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-terminal-bg disabled:opacity-40"
          >
            {loading ? "Computing..." : "Run Risk"}
          </button>
        </div>

        {err && (
          <div className="text-2xs text-terminal-dim">
            Live fetch unavailable - showing last computed risk profile.
          </div>
        )}

        {/* KPI strip */}
        <KpiStrip data={data} />

        {/* Distribution + stress, two-up on wide layouts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title="Daily Return Distribution / VaR Tail">
            <DistributionChart data={data} />
          </Section>
          <Section title="Stress Scenarios (estimated P&amp;L)">
            <StressTable rows={data.stress_scenarios} />
          </Section>
        </div>

        {/* Risk contribution */}
        <Section title="Risk Contribution vs Capital Weight">
          <RiskContribViz holdings={data.holdings} contributions={data.risk_contributions} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-2xs text-terminal-dim">
            <LegendSwatch color={CLAY} label="Risk share of total variance" />
            <LegendSwatch color={STEEL} label="Capital weight" />
          </div>
        </Section>

        {/* Footer / methodology */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-terminal-dim pt-1">
          <span>
            VaR: historical percentile + parametric (Gaussian). ES = mean loss beyond 95% VaR.
            Stress P&amp;L from per-holding beta + asset-class shock.
          </span>
          <span className="font-mono tabular-nums">
            10d VaR-95 {fmtPct(data.var_95_10d)} &middot; param VaR-95 {fmtPct(data.var_95_parametric)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── KPI strip ─────────────────────────────────────────────────────────────────

function KpiStrip({ data }: { data: RiskResponse }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
      <Kpi
        label="1-Day VaR 95%"
        figure={fmtPct(data.var_95_1d)}
        figureClass="text-accent-red"
        sub={`99%: ${fmtPct(data.var_99_1d)}`}
        emphasis
      />
      <Kpi
        label="Exp. Shortfall"
        figure={fmtPct(data.expected_shortfall_95)}
        figureClass="text-accent-red"
        sub="CVaR 95%"
      />
      <Kpi label="Volatility" figure={fmtPct(data.volatility)} figureClass="text-terminal-text" sub="annualized" />
      <Kpi
        label="Beta"
        figure={data.beta.toFixed(2)}
        figureClass={data.beta >= 1 ? "text-accent-amber" : "text-terminal-text"}
        sub="vs SPY"
      />
      <Kpi label="Max Drawdown" figure={fmtPct(data.max_drawdown)} figureClass="text-accent-red" sub="trailing 1y" />
      <Kpi
        label="Sharpe"
        figure={data.sharpe.toFixed(2)}
        figureClass={data.sharpe >= 1 ? "text-accent-green" : data.sharpe >= 0 ? "text-accent-amber" : "text-accent-red"}
        sub="rf 4.5%"
      />
    </div>
  );
}

function Kpi({
  label,
  figure,
  figureClass,
  sub,
  emphasis,
}: {
  label: string;
  figure: string;
  figureClass: string;
  sub: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`bg-terminal-bg border rounded p-3 flex flex-col gap-1 ${
        emphasis ? "border-accent-red/40" : "border-terminal-border/50"
      }`}
    >
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`stat-figure ${emphasis ? "text-3xl" : "text-2xl"} leading-none tabular-nums ${figureClass}`}>
        {figure}
      </div>
      <div className="text-2xs text-terminal-muted tabular-nums">{sub}</div>
    </div>
  );
}

// ── Return distribution histogram (inline SVG) ────────────────────────────────

function DistributionChart({ data }: { data: RiskResponse }) {
  const W = 340;
  const H = 200;
  const pad = { l: 8, r: 8, t: 10, b: 26 };

  const bins = data.return_distribution.length
    ? data.return_distribution
    : FALLBACK.return_distribution;

  const xs = bins.map((b) => b.bucket);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));

  const sx = (v: number) => pad.l + ((v - xMin) / xSpan) * (W - pad.l - pad.r);
  const sy = (c: number) => H - pad.b - (c / maxCount) * (H - pad.t - pad.b);

  // VaR thresholds are positive loss numbers; the loss sits on the negative
  // (left) side of the return axis.
  const var95x = sx(-data.var_95_1d);
  const var99x = sx(-data.var_99_1d);

  const barW = (W - pad.l - pad.r) / bins.length;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }}>
        {/* Shaded loss tail beyond VaR-95 */}
        <rect
          x={pad.l}
          y={pad.t}
          width={Math.max(0, var95x - pad.l)}
          height={H - pad.t - pad.b}
          fill="rgba(204,106,90,0.10)"
        />

        {/* Histogram bars */}
        {bins.map((b, i) => {
          const x = sx(b.bucket) - barW / 2 + 0.6;
          const y = sy(b.count);
          const h = H - pad.b - y;
          // Color bars in the loss tail (left of VaR-95) red, body clay.
          const inTail = b.bucket <= -data.var_95_1d;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={Math.max(barW - 1.2, 0.8)}
              height={Math.max(h, 0)}
              rx={0.8}
              fill={inTail ? RED : CLAY}
              opacity={inTail ? 0.9 : 0.78}
            />
          );
        })}

        {/* Zero line */}
        <line x1={sx(0)} y1={pad.t} x2={sx(0)} y2={H - pad.b} stroke="#3a352d" strokeWidth={1} strokeDasharray="2 2" />

        {/* VaR-95 marker */}
        <line x1={var95x} y1={pad.t} x2={var95x} y2={H - pad.b} stroke={RED} strokeWidth={1.4} />
        <text x={var95x} y={pad.t + 8} textAnchor="middle" fontSize={8} fill={RED} fontFamily="JetBrains Mono, monospace">
          95% {fmtPct(data.var_95_1d)}
        </text>

        {/* VaR-99 marker */}
        <line x1={var99x} y1={pad.t} x2={var99x} y2={H - pad.b} stroke="#9c4f43" strokeWidth={1.2} strokeDasharray="3 2" />
        <text x={var99x} y={pad.t + 18} textAnchor="middle" fontSize={8} fill="#9c4f43" fontFamily="JetBrains Mono, monospace">
          99% {fmtPct(data.var_99_1d)}
        </text>

        {/* X axis ticks */}
        {[xMin, xMin + xSpan / 2, xMax].map((t, i) => (
          <text
            key={i}
            x={sx(t)}
            y={H - pad.b + 12}
            textAnchor="middle"
            fontSize={8}
            fill="#6e665a"
            fontFamily="JetBrains Mono, monospace"
          >
            {t.toFixed(1)}%
          </text>
        ))}
        <text x={(W) / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#6e665a">
          daily return (%)
        </text>
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-2xs text-terminal-dim">
        <LegendSwatch color={CLAY} label="Daily returns" />
        <LegendSwatch color={RED} label="Loss tail (beyond VaR-95)" />
      </div>
    </div>
  );
}

// ── Stress scenarios table ────────────────────────────────────────────────────

function StressTable({ rows }: { rows: StressScenario[] }) {
  const worst = useMemo(() => Math.max(1, ...rows.map((r) => Math.abs(r.pnl_pct))), [rows]);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const neg = r.pnl_pct < 0;
        const barW = (Math.abs(r.pnl_pct) / worst) * 100;
        return (
          <div key={r.scenario} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-terminal-text w-40 shrink-0 truncate" title={r.description}>
                {r.scenario}
              </span>
              <div className="flex-1 relative h-3.5 bg-terminal-panel/60 rounded-sm overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{ width: `${barW}%`, backgroundColor: neg ? RED : "#5f9c6a", opacity: 0.85 }}
                />
              </div>
              <span
                className={`font-mono tabular-nums w-16 text-right shrink-0 ${
                  neg ? "text-accent-red" : "text-accent-green"
                }`}
              >
                {neg ? "" : "+"}
                {r.pnl_pct.toFixed(1)}%
              </span>
            </div>
            <div className="text-2xs text-terminal-dim pl-0.5 leading-snug line-clamp-1" title={r.description}>
              {r.description}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Risk contribution vs weight bars ──────────────────────────────────────────

function RiskContribViz({
  holdings,
  contributions,
}: {
  holdings: Holding[];
  contributions: RiskContribution[];
}) {
  const weightMap = useMemo(() => {
    const m: Record<string, number> = {};
    holdings.forEach((h) => (m[h.symbol] = h.weight * 100));
    return m;
  }, [holdings]);

  const rows = useMemo(
    () => [...contributions].sort((a, b) => b.pct - a.pct),
    [contributions],
  );

  const maxVal = useMemo(
    () => Math.max(1, ...rows.map((r) => Math.max(r.pct, weightMap[r.symbol] ?? 0))),
    [rows, weightMap],
  );

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const wPct = weightMap[r.symbol] ?? 0;
        const riskW = (r.pct / maxVal) * 100;
        return (
          <div key={r.symbol} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-terminal-text w-12 shrink-0">{r.symbol}</span>
            <div className="flex-1 relative h-4 bg-terminal-panel/60 rounded-sm overflow-hidden">
              {/* Risk share bar (clay) */}
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${riskW}%`, backgroundColor: CLAY, opacity: 0.88 }}
              />
              {/* Capital weight marker (steel line) */}
              <div
                className="absolute inset-y-0 z-10"
                style={{ left: `${Math.min((wPct / maxVal) * 100, 100)}%`, borderLeft: `2px solid ${STEEL}` }}
                title={`Capital weight ${wPct.toFixed(1)}%`}
              />
            </div>
            <span className="font-mono tabular-nums text-accent w-14 text-right shrink-0" title="Risk contribution">
              {r.pct.toFixed(1)}%
            </span>
            <span className="font-mono tabular-nums text-terminal-muted w-14 text-right shrink-0" title="Capital weight">
              {wPct.toFixed(1)}%
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-2 text-2xs text-terminal-dim mt-0.5">
        <span className="w-12 shrink-0" />
        <span className="flex-1" />
        <span className="w-14 text-right shrink-0 uppercase tracking-wider">risk</span>
        <span className="w-14 text-right shrink-0 uppercase tracking-wider">weight</span>
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
  return `${v.toFixed(2)}%`;
}
