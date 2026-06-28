import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface CDSInputs {
  spread_bps: number;
  recovery: number;
  tenor_years: number;
  coupon_bps: number;
  notional: number;
}

interface SurvivalPoint {
  year: number;
  survival: number;
}

interface ReferenceName {
  name: string;
  ticker: string;
  sector: string;
  indicative_spread_bps: number;
  rating: string;
}

interface CDSResponse {
  inputs: CDSInputs;
  par_spread_bps: number;
  upfront: number;
  points_upfront_pct: number;
  protection_pv: number;
  premium_pv: number;
  rpv01: number;
  hazard_rate: number;
  default_prob: number;
  survival_curve: SurvivalPoint[];
  reference_names: ReferenceName[];
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated even before/without the
// backend. Mirrors price_cds(100, 0.40, 5, 100, 10mm): a 100bp running name with
// 40% recovery quoted at par - upfront ~ 0, hazard ~ 1.67%, ~8% cumulative default
// over five years.

const FALLBACK_REFERENCE: ReferenceName[] = [
  { name: "Apple Inc.", ticker: "AAPL", sector: "Technology", indicative_spread_bps: 28, rating: "AA+" },
  { name: "Microsoft Corp.", ticker: "MSFT", sector: "Technology", indicative_spread_bps: 24, rating: "AAA" },
  { name: "JPMorgan Chase & Co.", ticker: "JPM", sector: "Financials", indicative_spread_bps: 55, rating: "A-" },
  { name: "Bank of America Corp.", ticker: "BAC", sector: "Financials", indicative_spread_bps: 62, rating: "A-" },
  { name: "Goldman Sachs Group Inc.", ticker: "GS", sector: "Financials", indicative_spread_bps: 72, rating: "BBB+" },
  { name: "AT&T Inc.", ticker: "T", sector: "Communications", indicative_spread_bps: 98, rating: "BBB" },
  { name: "Verizon Communications Inc.", ticker: "VZ", sector: "Communications", indicative_spread_bps: 88, rating: "BBB+" },
  { name: "Ford Motor Company", ticker: "F", sector: "Consumer Cyclical", indicative_spread_bps: 235, rating: "BB+" },
  { name: "Boeing Company", ticker: "BA", sector: "Industrials", indicative_spread_bps: 165, rating: "BBB-" },
  { name: "Carnival Corp.", ticker: "CCL", sector: "Consumer Cyclical", indicative_spread_bps: 420, rating: "B+" },
  { name: "Occidental Petroleum Corp.", ticker: "OXY", sector: "Energy", indicative_spread_bps: 188, rating: "BB+" },
  { name: "American Airlines Group Inc.", ticker: "AAL", sector: "Industrials", indicative_spread_bps: 640, rating: "B-" },
  { name: "Tesla Inc.", ticker: "TSLA", sector: "Consumer Cyclical", indicative_spread_bps: 145, rating: "BBB" },
  { name: "Walmart Inc.", ticker: "WMT", sector: "Consumer Defensive", indicative_spread_bps: 30, rating: "AA" },
  { name: "Pfizer Inc.", ticker: "PFE", sector: "Health Care", indicative_spread_bps: 58, rating: "A" },
  { name: "General Electric Co.", ticker: "GE", sector: "Industrials", indicative_spread_bps: 110, rating: "BBB+" },
];

const FALLBACK: CDSResponse = {
  inputs: { spread_bps: 100, recovery: 0.4, tenor_years: 5, coupon_bps: 100, notional: 10_000_000 },
  par_spread_bps: 100,
  upfront: -0.62,
  points_upfront_pct: 0,
  protection_pv: 429990.7,
  premium_pv: 429991.32,
  rpv01: 4299.91,
  hazard_rate: 0.016667,
  default_prob: 0.079956,
  survival_curve: [
    { year: 0, survival: 1 },
    { year: 1, survival: 0.983471 },
    { year: 2, survival: 0.967216 },
    { year: 3, survival: 0.951229 },
    { year: 4, survival: 0.935507 },
    { year: 5, survival: 0.920044 },
  ],
  reference_names: FALLBACK_REFERENCE,
  data_mode: "computed",
  as_of: "",
  source: "isda-credit-triangle",
};

// Formatters

function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtUsdFull(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: number | null | undefined, digits = 2, signed = false): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtBps(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(digits)} bp`;
}

function upfrontColor(v: number): string {
  if (v > 0.0005) return "text-accent-red";   // protection buyer pays today
  if (v < -0.0005) return "text-accent-green"; // protection buyer receives
  return "text-terminal-text";
}

// SVG hero geometry for the survival curve

const VW = 1000;
const VH = 300;
const PAD = { top: 18, right: 18, bottom: 26, left: 40 };

interface CurveGeom {
  line: string;
  area: string;
  dots: { cx: number; cy: number }[];
  xTicks: { x: number; label: string }[];
  yGrid: { y: number; label: string }[];
}

function buildGeom(curve: SurvivalPoint[]): CurveGeom {
  const innerW = VW - PAD.left - PAD.right;
  const innerH = VH - PAD.top - PAD.bottom;
  const pts = curve.length ? curve : [{ year: 0, survival: 1 }];
  const maxYear = Math.max(...pts.map((p) => p.year), 1);
  const lo = Math.min(...pts.map((p) => p.survival), 1);
  const yMin = Math.max(0, Math.floor((lo - 0.02) * 100) / 100);
  const yMax = 1;

  const x = (yr: number) => PAD.left + (maxYear <= 0 ? 0 : (yr / maxYear) * innerW);
  const y = (s: number) => PAD.top + (1 - (s - yMin) / (yMax - yMin || 1)) * innerH;

  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.year).toFixed(1)},${y(p.survival).toFixed(1)}`)
    .join(" ");
  const baseY = (PAD.top + innerH).toFixed(1);
  const area = `${line} L${x(maxYear).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  const dots = pts.map((p) => ({ cx: x(p.year), cy: y(p.survival) }));

  const xTicks = pts.map((p) => ({ x: x(p.year), label: `${p.year}y` }));

  const yGrid: { y: number; label: string }[] = [];
  const steps = 4;
  for (let g = 0; g <= steps; g++) {
    const v = yMin + (g / steps) * (yMax - yMin);
    yGrid.push({ y: y(v), label: `${(v * 100).toFixed(0)}%` });
  }

  return { line, area, dots, xTicks, yGrid };
}

// Panel

export function CDSPricerPanel() {
  const [spread, setSpread] = useState("100");
  const [recovery, setRecovery] = useState("40");
  const [tenor, setTenor] = useState("5");
  const [coupon, setCoupon] = useState("100");
  const [notional, setNotional] = useState("10000000");

  const [data, setData] = useState<CDSResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const runPricer = (s: string, r: string, t: string, c: string, n: string) => {
    const sp = Number(s);
    const rec = Number(r) / 100;
    const tn = Number(t);
    const cp = Number(c);
    const no = Number(n);
    const q =
      `/api/cds-pricer?spread_bps=${encodeURIComponent(sp)}` +
      `&recovery=${encodeURIComponent(rec)}` +
      `&tenor_years=${encodeURIComponent(tn)}` +
      `&coupon_bps=${encodeURIComponent(cp)}` +
      `&notional=${encodeURIComponent(no)}`;
    const id = ++reqIdRef.current;
    setLoading(true);
    fetch(q)
      .then((res) => res.json())
      .then((json: CDSResponse) => {
        if (id !== reqIdRef.current) return; // stale response
        if (json && json.inputs && Array.isArray(json.survival_curve) && json.survival_curve.length) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (id === reqIdRef.current) setLoading(false);
      });
  };

  // Debounced refetch whenever any input changes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runPricer(spread, recovery, tenor, coupon, notional);
    }, 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spread, recovery, tenor, coupon, notional]);

  const geom = useMemo(() => buildGeom(data.survival_curve), [data.survival_curve]);

  const loadName = (n: ReferenceName) => {
    setSpread(String(n.indicative_spread_bps));
    setCoupon(String(n.indicative_spread_bps));
  };

  const protPv = data.protection_pv;
  const premPv = data.premium_pv;
  const legMax = Math.max(protPv, premPv, 1);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CDS Pricer (CDSW)</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Pricing...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <NumField label="Spread" unit="bps" value={spread} onChange={setSpread} step="1" />
          <NumField label="Recovery" unit="%" value={recovery} onChange={setRecovery} step="1" />
          <NumField label="Tenor" unit="yrs" value={tenor} onChange={setTenor} step="0.5" />
          <NumField label="Coupon" unit="bps" value={coupon} onChange={setCoupon} step="1" />
          <NumField label="Notional" unit="$" value={notional} onChange={setNotional} step="1000000" />
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1 justify-between">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Upfront</div>
            <div className={`stat-figure text-2xl ${upfrontColor(data.upfront)}`}>{fmtUsd(data.upfront)}</div>
            <div className={`text-2xs font-mono tabular-nums ${upfrontColor(data.upfront)}`}>
              {fmtPct(data.points_upfront_pct, 3, true)} points
            </div>
          </div>
          <Kpi label="Par Spread" value={fmtBps(data.par_spread_bps)} sub="zeroes the upfront" accent="text-accent-blue" />
          <Kpi
            label="RPV01"
            value={fmtUsd(data.rpv01)}
            sub="premium leg / 1bp"
            accent="text-accent-amber"
          />
          <Kpi
            label="Default Probability"
            value={fmtPct(data.default_prob * 100, 2)}
            sub={`over ${data.inputs.tenor_years}y - hazard ${(data.hazard_rate * 100).toFixed(2)}%/y`}
            accent="text-accent-red"
          />
        </div>

        {/* Plain-language line */}
        <div className="text-2xs text-terminal-muted leading-relaxed px-0.5">
          A CDS is insurance on default: the protection buyer pays the running coupon and is made whole on the
          loss-given-default if the name fails. The upfront is today's cash settlement that reconciles the fixed
          {" "}{data.inputs.coupon_bps.toFixed(0)}bp coupon to the market-implied {data.par_spread_bps.toFixed(0)}bp fair spread.
        </div>

        {/* Hero survival curve */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <SectionLabel>Survival Probability Curve</SectionLabel>
            <div className="flex items-center gap-3 text-2xs flex-wrap text-terminal-dim font-mono tabular-nums">
              <span>S(0) = 100%</span>
              <span>
                S({data.inputs.tenor_years}y) ={" "}
                <span className="text-accent-green">
                  {(((data.survival_curve.at(-1)?.survival ?? 1) * 100)).toFixed(2)}%
                </span>
              </span>
            </div>
          </div>
          <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
            {/* y gridlines */}
            {geom.yGrid.map((g, i) => (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={VW - PAD.right}
                  y1={g.y}
                  y2={g.y}
                  className="stroke-terminal-divider"
                  strokeWidth={0.75}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
                <text x={4} y={g.y + 3} className="fill-terminal-dim" style={{ fontSize: "10px" }}>
                  {g.label}
                </text>
              </g>
            ))}

            {/* area under survival curve */}
            <path d={geom.area} className="fill-accent/[0.08]" />

            {/* survival line */}
            <path
              d={geom.line}
              className="stroke-accent"
              strokeWidth={2.25}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />

            {/* node dots */}
            {geom.dots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r={3} className="fill-accent" />
            ))}

            {/* x ticks */}
            {geom.xTicks.map((t, i) => (
              <text
                key={i}
                x={t.x}
                y={VH - 8}
                textAnchor="middle"
                className="fill-terminal-dim"
                style={{ fontSize: "10px" }}
              >
                {t.label}
              </text>
            ))}
          </svg>
        </div>

        {/* Premium vs Protection leg breakdown */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <SectionLabel>Leg Valuation</SectionLabel>
          <div className="flex flex-col gap-2 mt-2">
            <LegBar
              label="Protection leg"
              hint="(1 - R) x Sum DF x dPD"
              value={protPv}
              pct={(protPv / legMax) * 100}
              color="bg-accent-green/70"
              valueText={fmtUsdFull(protPv)}
            />
            <LegBar
              label="Premium leg"
              hint="coupon x RPV01 x notional"
              value={premPv}
              pct={(premPv / legMax) * 100}
              color="bg-accent-blue/70"
              valueText={fmtUsdFull(premPv)}
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-2 border-t border-terminal-divider/60">
            <MiniStat label="Net upfront" value={fmtUsdFull(data.upfront)} cls={upfrontColor(data.upfront)} />
            <MiniStat label="Hazard rate" value={`${(data.hazard_rate * 100).toFixed(3)}%`} />
            <MiniStat label="Recovery" value={`${(data.inputs.recovery * 100).toFixed(0)}%`} />
            <MiniStat label="Notional" value={fmtUsdFull(data.inputs.notional)} />
          </div>
        </div>

        {/* Reference names */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>Reference Single-Names</SectionLabel>
            <span className="text-2xs text-terminal-dim">click to load indicative 5Y spread</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
                  <th className="text-left py-1 pr-2 font-medium">Issuer</th>
                  <th className="text-left py-1 px-2 font-medium">Ticker</th>
                  <th className="text-left py-1 px-2 font-medium">Sector</th>
                  <th className="text-center py-1 px-2 font-medium">Rating</th>
                  <th className="text-right py-1 pl-2 font-medium">5Y Spread</th>
                </tr>
              </thead>
              <tbody>
                {data.reference_names.map((n) => {
                  const active = Number(spread) === n.indicative_spread_bps;
                  return (
                    <tr
                      key={n.ticker}
                      onClick={() => loadName(n)}
                      className={`border-t border-terminal-border/20 cursor-pointer transition-colors ${
                        active ? "bg-accent/[0.08]" : "hover:bg-white/[0.025]"
                      }`}
                    >
                      <td className="py-1.5 pr-2 text-terminal-text truncate max-w-[12rem]" title={n.name}>
                        {n.name}
                      </td>
                      <td className="py-1.5 px-2 font-mono text-terminal-muted">{n.ticker}</td>
                      <td className="py-1.5 px-2 text-terminal-muted truncate">{n.sector}</td>
                      <td className="py-1.5 px-2 text-center">
                        <span className={`pill border ${ratingClasses(n.rating)}`}>{n.rating}</span>
                      </td>
                      <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-terminal-text">
                        {n.indicative_spread_bps.toFixed(0)} bp
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="text-2xs text-terminal-dim font-mono tabular-nums px-0.5">
          ISDA reduced-form credit triangle - quarterly accrual, accrual-on-default, flat 4.3% risk-free discounting.
          Hazard lambda = s / (1 - R); survival S(t) = exp(-lambda t).
        </div>
      </div>
    </div>
  );
}

// Sub-components

function NumField({
  label,
  unit,
  value,
  onChange,
  step,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider">
        {label} <span className="text-terminal-dim/70 lowercase">({unit})</span>
      </span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs font-mono tabular-nums text-terminal-text focus:outline-none focus:border-accent"
      />
    </label>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1 justify-between">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-2xl ${accent ?? "text-terminal-text"}`}>{value}</div>
      {sub && <div className="text-2xs text-terminal-dim font-mono tabular-nums">{sub}</div>}
    </div>
  );
}

function LegBar({
  label,
  hint,
  pct,
  color,
  valueText,
}: {
  label: string;
  hint: string;
  value: number;
  pct: number;
  color: string;
  valueText: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 shrink-0">
        <div className="text-2xs text-terminal-text">{label}</div>
        <div className="text-2xs text-terminal-dim font-mono">{hint}</div>
      </div>
      <div className="flex-1 h-5 bg-terminal-panel rounded-sm overflow-hidden relative">
        <div className={`h-full ${color} rounded-sm`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
      <div className="w-28 text-right text-xs font-mono tabular-nums text-terminal-text">{valueText}</div>
    </div>
  );
}

function MiniStat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</span>
      <span className={`text-xs font-mono tabular-nums ${cls ?? "text-terminal-text"}`}>{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs text-terminal-muted uppercase tracking-wider">{children}</div>;
}

function ratingClasses(rating: string): string {
  const r = rating.toUpperCase();
  if (r.startsWith("AAA") || r.startsWith("AA")) return "bg-accent-green/15 text-accent-green border-accent-green/30";
  if (r.startsWith("A") || r.startsWith("BBB")) return "bg-accent-blue/15 text-accent-blue border-accent-blue/30";
  if (r.startsWith("BB")) return "bg-accent-amber/15 text-accent-amber border-accent-amber/30";
  return "bg-accent-red/15 text-accent-red border-accent-red/30";
}
