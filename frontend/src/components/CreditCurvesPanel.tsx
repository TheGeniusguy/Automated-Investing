import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";

/**
 * Credit & CDS Curves Panel (Bloomberg Wave D - CRVD).
 *
 * IG vs HY OAS term structures (two lines over tenors), the IG-HY spread plus a
 * credit-vs-equity divergence read, an issuer rating table, and a per-issuer CDS
 * drill-down (spread curve + cumulative default-probability + survival curve).
 *
 * Shapes are mirrored locally from backend/app/data/credit_curves.py. The
 * api.creditCurves() / api.creditIssuer() methods are owned by the wiring agent;
 * we reach them through a locally-typed accessor so this file type-checks on its
 * own regardless of wiring order.
 */

// ── Local mirrors of the backend shape ────────────────────────────────────────

interface CurvePoint {
  tenor: number;
  spread_bps: number;
}

interface CdsPoint {
  tenor: number;
  spread_bps: number;
  pd_pct: number;
  survival_pct: number;
}

interface IssuerRow {
  name: string;
  ticker: string;
  rating: string;
  sector: string;
  spread_5y_bps: number | null;
  pd_5y_pct: number | null;
  cds: CdsPoint[];
}

interface Divergence {
  hy_spread_change_bps_1m: number | null;
  equity_return_pct_1m: number | null;
  signal: string;
  diverging: boolean;
  interpretation: string;
  data_mode?: string;
}

interface CreditCurvesData {
  ig_curve: CurvePoint[];
  hy_curve: CurvePoint[];
  ig_5y_bps: number;
  hy_5y_bps: number;
  ig_hy_spread_bps: number;
  recovery_rate: number;
  tenors: number[];
  issuers: IssuerRow[];
  divergence: Divergence;
  data_mode: string;
  as_of: string;
  source: string;
}

interface IssuerCreditData {
  issuer: string;
  name: string;
  ticker: string;
  rating: string;
  sector: string;
  recovery_rate: number;
  cds: CdsPoint[];
  spread_5y_bps: number | null;
  pd_5y_pct: number | null;
  curve_shape: string;
  vs_ig_5y_bps: number | null;
  vs_hy_5y_bps: number | null;
  interpretation: string;
  data_mode: string;
  as_of: string;
  source: string;
}

interface CreditApi {
  creditCurves: () => Promise<CreditCurvesData>;
  creditIssuer: (issuer: string) => Promise<IssuerCreditData>;
}

const creditApi = api as unknown as CreditApi;

const IG_COLOR = "#60a5fa";
const HY_COLOR = "#f59e0b";
const PD_COLOR = "#f87171";
const SURVIVAL_COLOR = "#34d399";

// ── Panel ─────────────────────────────────────────────────────────────────────

export function CreditCurvesPanel() {
  const [data, setData] = useState<CreditCurvesData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<IssuerCreditData | null>(null);
  const [issuerLoading, setIssuerLoading] = useState(false);
  const [issuerErr, setIssuerErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    creditApi
      .creditCurves()
      .then((d) => {
        if (!alive) return;
        setData(d);
        if (d.issuers.length > 0) setSelected(d.issuers[0].ticker);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setIssuer(null);
      return;
    }
    let alive = true;
    setIssuerLoading(true);
    setIssuerErr(null);
    creditApi
      .creditIssuer(selected)
      .then((d) => {
        if (!alive) return;
        setIssuer(d);
        setIssuerLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setIssuerErr(String(e));
        setIssuerLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header">
          <span>Credit &amp; CDS Curves</span>
        </div>
        <div className="panel-body text-accent-red text-xs py-4">{err}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel h-full">
        <div className="panel-header">
          <span>Credit &amp; CDS Curves</span>
        </div>
        <div className="panel-body text-terminal-dim text-xs py-4">loading...</div>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">
          Credit &amp; CDS Curves
        </span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">
          recovery {(data.recovery_rate * 100).toFixed(0)}%
        </span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Divergence + spread hero */}
        <DivergenceHero data={data} />

        {/* IG vs HY term structure */}
        <Section title="IG vs HY OAS Term Structure">
          <TermStructureChart ig={data.ig_curve} hy={data.hy_curve} />
          <div className="flex flex-wrap gap-4 mt-2 px-1">
            <Legend color={IG_COLOR} label="IG (investment grade)" value={`${data.ig_5y_bps.toFixed(0)} bps 5Y`} />
            <Legend color={HY_COLOR} label="HY (high yield)" value={`${data.hy_5y_bps.toFixed(0)} bps 5Y`} />
          </div>
        </Section>

        {/* Issuer table */}
        <Section title="Issuer Credit (5Y CDS)">
          <IssuerTable
            issuers={data.issuers}
            selected={selected}
            onSelect={setSelected}
          />
        </Section>

        {/* Selected issuer drill-down */}
        <Section title={issuer ? `${issuer.name} (${issuer.ticker}) CDS Curve` : "Issuer CDS Curve"}>
          {issuerErr && <div className="text-accent-red text-xs py-2">{issuerErr}</div>}
          {issuerLoading && !issuer && (
            <div className="text-terminal-dim text-xs py-4 text-center">loading issuer...</div>
          )}
          {issuer && <IssuerDetail issuer={issuer} igFive={data.ig_5y_bps} hyFive={data.hy_5y_bps} />}
        </Section>
      </div>
    </div>
  );
}

// ── Divergence hero ───────────────────────────────────────────────────────────

function DivergenceHero({ data }: { data: CreditCurvesData }) {
  const d = data.divergence;
  const diverging = d.diverging;
  // Diverging = a warning (gauges disagree with the usual inverse relationship).
  const spreadColor = data.ig_hy_spread_bps >= 0 ? "text-accent-amber" : "text-accent-green";
  const signalColor = diverging ? "text-accent-red" : "text-accent-green";

  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="flex flex-col">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider">IG - HY spread</span>
        <span className={"font-serif text-4xl leading-tight tabular-nums " + spreadColor}>
          {data.ig_hy_spread_bps.toFixed(0)}
          <span className="text-base text-terminal-dim ml-1">bps</span>
        </span>
        <span className="text-2xs text-terminal-dim mt-1">
          HY {data.hy_5y_bps.toFixed(0)} over IG {data.ig_5y_bps.toFixed(0)} (5Y OAS)
        </span>
      </div>

      <div className="flex flex-col">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider">Credit vs equity</span>
        <span className={"font-serif text-2xl leading-tight capitalize " + signalColor}>
          {d.signal}
        </span>
        <div className="flex gap-4 mt-1">
          <Mini label="HY 1M" value={fmtBps(d.hy_spread_change_bps_1m)} color={signedColor(d.hy_spread_change_bps_1m, true)} />
          <Mini label="SPX 1M" value={fmtPct(d.equity_return_pct_1m)} color={signedColor(d.equity_return_pct_1m)} />
        </div>
      </div>

      <div className="flex flex-col justify-center">
        <span className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">Read</span>
        <p className="text-2xs text-terminal-muted leading-relaxed">{d.interpretation}</p>
      </div>
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs text-terminal-dim uppercase">{label}</span>
      <span className={"text-sm tabular-nums " + color}>{value}</span>
    </div>
  );
}

// ── Issuer table ──────────────────────────────────────────────────────────────

function IssuerTable({
  issuers,
  selected,
  onSelect,
}: {
  issuers: IssuerRow[];
  selected: string | null;
  onSelect: (ticker: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Issuer</th>
            <th className="text-left py-1 px-2">Rating</th>
            <th className="text-left py-1 px-2">Sector</th>
            <th className="text-right py-1 px-2">5Y CDS</th>
            <th className="text-right py-1 px-2">5Y PD</th>
          </tr>
        </thead>
        <tbody>
          {issuers.map((iss) => {
            const active = iss.ticker === selected;
            return (
              <tr
                key={iss.ticker}
                onClick={() => onSelect(iss.ticker)}
                className={
                  "border-t border-terminal-border/20 cursor-pointer " +
                  (active ? "bg-accent/10" : "hover:bg-terminal-panel/60")
                }
              >
                <td className="py-1.5 px-2">
                  <span className="text-terminal-fg font-semibold">{iss.ticker}</span>
                  <span className="text-terminal-dim ml-2 truncate">{iss.name}</span>
                </td>
                <td className="py-1.5 px-2">
                  <span className={"pill text-2xs " + ratingClass(iss.rating)}>{iss.rating}</span>
                </td>
                <td className="py-1.5 px-2 text-terminal-muted">{iss.sector}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">
                  {iss.spread_5y_bps == null ? "--" : `${iss.spread_5y_bps.toFixed(0)} bps`}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-accent-amber">
                  {iss.pd_5y_pct == null ? "--" : `${iss.pd_5y_pct.toFixed(2)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Issuer drill-down ─────────────────────────────────────────────────────────

function IssuerDetail({
  issuer,
  igFive,
  hyFive,
}: {
  issuer: IssuerCreditData;
  igFive: number;
  hyFive: number;
}) {
  const cds = issuer.cds;
  const spreadSeries = cds.map((c) => ({ tenor: c.tenor, spread_bps: c.spread_bps }));

  return (
    <div className="flex flex-col gap-3">
      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatBox label="5Y CDS" value={issuer.spread_5y_bps == null ? "--" : `${issuer.spread_5y_bps.toFixed(0)} bps`} />
        <StatBox label="5Y default prob" value={issuer.pd_5y_pct == null ? "--" : `${issuer.pd_5y_pct.toFixed(2)}%`} accent="amber" />
        <StatBox label="Curve shape" value={issuer.curve_shape} capitalize />
        <StatBox label="Recovery" value={`${(issuer.recovery_rate * 100).toFixed(0)}%`} />
      </div>

      {/* Relative value vs indices */}
      <div className="flex flex-wrap gap-4 text-2xs px-1">
        <RelVal label="vs IG index" base={igFive} delta={issuer.vs_ig_5y_bps} />
        <RelVal label="vs HY index" base={hyFive} delta={issuer.vs_hy_5y_bps} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div>
          <div className="text-2xs text-terminal-muted uppercase mb-1">CDS spread by tenor</div>
          <TermStructureChart ig={spreadSeries} igLabel={issuer.ticker} igColor={HY_COLOR} />
        </div>
        <div>
          <div className="text-2xs text-terminal-muted uppercase mb-1">Cumulative default prob &amp; survival</div>
          <PdSurvivalChart cds={cds} />
        </div>
      </div>

      {/* CDS table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
              <th className="text-left py-1 px-2">Tenor</th>
              <th className="text-right py-1 px-2">Spread</th>
              <th className="text-right py-1 px-2">Cum. PD</th>
              <th className="text-right py-1 px-2">Survival</th>
            </tr>
          </thead>
          <tbody>
            {cds.map((c) => (
              <tr key={c.tenor} className="border-t border-terminal-border/20">
                <td className="py-1.5 px-2 text-terminal-muted">{c.tenor}Y</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">{c.spread_bps.toFixed(0)} bps</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-accent-red">{c.pd_pct.toFixed(2)}%</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-accent-green">{c.survival_pct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-2xs text-terminal-muted leading-relaxed px-1">{issuer.interpretation}</p>
    </div>
  );
}

function RelVal({ label, base, delta }: { label: string; base: number; delta: number | null }) {
  const color = delta == null ? "text-terminal-dim" : delta >= 0 ? "text-accent-red" : "text-accent-green";
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-terminal-dim uppercase">{label}</span>
      <span className="text-terminal-muted tabular-nums">{base.toFixed(0)} bps</span>
      <span className={"tabular-nums " + color}>
        {delta == null ? "" : `(${delta >= 0 ? "+" : ""}${delta.toFixed(0)})`}
      </span>
    </span>
  );
}

function StatBox({
  label,
  value,
  accent,
  capitalize,
}: {
  label: string;
  value: string;
  accent?: "amber";
  capitalize?: boolean;
}) {
  const valCls =
    accent === "amber" ? "text-accent-amber" : "text-terminal-fg";
  return (
    <div className="bg-terminal-panel border border-terminal-border/40 rounded p-2 flex flex-col">
      <span className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</span>
      <span className={"font-serif text-xl tabular-nums " + valCls + (capitalize ? " capitalize" : "")}>
        {value}
      </span>
    </div>
  );
}

// ── Charts (SVG over tenor categories) ────────────────────────────────────────

function TermStructureChart({
  ig,
  hy,
  igLabel,
  igColor = IG_COLOR,
}: {
  ig: CurvePoint[];
  hy?: CurvePoint[];
  igLabel?: string;
  igColor?: string;
}) {
  const lines = useMemo(() => {
    const out: { color: string; points: CurvePoint[] }[] = [{ color: igColor, points: ig }];
    if (hy && hy.length) out.push({ color: HY_COLOR, points: hy });
    return out;
  }, [ig, hy, igColor]);

  // X axis is categorical over the union of tenors (ordered).
  const tenors = useMemo(() => {
    const s = new Set<number>();
    lines.forEach((l) => l.points.forEach((p) => s.add(p.tenor)));
    return [...s].sort((a, b) => a - b);
  }, [lines]);

  const allVals = lines.flatMap((l) => l.points.map((p) => p.spread_bps));
  const yMax = Math.max(...allVals, 1) * 1.12;
  const yMin = 0;

  const W = 520;
  const H = 220;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const xFor = (tenor: number) => {
    const i = tenors.indexOf(tenor);
    const n = Math.max(1, tenors.length - 1);
    return pad.l + (tenors.length === 1 ? innerW / 2 : (i / n) * innerW);
  };
  const yFor = (v: number) => pad.t + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let i = 0; i <= 4; i++) ticks.push(yMin + ((yMax - yMin) / 4) * i);
    return ticks;
  }, [yMax]);

  const pathFor = (points: CurvePoint[]) =>
    [...points]
      .sort((a, b) => a.tenor - b.tenor)
      .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.tenor).toFixed(1)},${yFor(p.spread_bps).toFixed(1)}`)
      .join(" ");

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} preserveAspectRatio="xMidYMid meet">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={yFor(t)} y2={yFor(t)} stroke="#1f1f1f" />
            <text x={pad.l - 6} y={yFor(t) + 3} fill="#8b8b8b" fontSize={9} textAnchor="end" fontFamily="monospace">
              {t.toFixed(0)}
            </text>
          </g>
        ))}
        {tenors.map((t) => (
          <text key={t} x={xFor(t)} y={H - 8} fill="#8b8b8b" fontSize={9} textAnchor="middle" fontFamily="monospace">
            {t}Y
          </text>
        ))}
        {lines.map((l, li) => (
          <g key={li}>
            <path d={pathFor(l.points)} fill="none" stroke={l.color} strokeWidth={2} />
            {l.points.map((p) => (
              <circle key={p.tenor} cx={xFor(p.tenor)} cy={yFor(p.spread_bps)} r={2.5} fill={l.color}>
                <title>
                  {p.tenor}Y: {p.spread_bps.toFixed(0)} bps
                </title>
              </circle>
            ))}
          </g>
        ))}
        <text x={pad.l} y={pad.t} fill="#6b7280" fontSize={9} fontFamily="monospace">
          bps {igLabel ? `(${igLabel})` : ""}
        </text>
      </svg>
    </div>
  );
}

function PdSurvivalChart({ cds }: { cds: CdsPoint[] }) {
  const tenors = useMemo(() => [...cds].map((c) => c.tenor).sort((a, b) => a - b), [cds]);

  const W = 520;
  const H = 220;
  const pad = { l: 40, r: 40, t: 12, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const pdMax = Math.max(...cds.map((c) => c.pd_pct), 1) * 1.2;

  const xFor = (tenor: number) => {
    const i = tenors.indexOf(tenor);
    const n = Math.max(1, tenors.length - 1);
    return pad.l + (tenors.length === 1 ? innerW / 2 : (i / n) * innerW);
  };
  // Left axis: PD (0..pdMax). Survival drawn on its own 0..100 scale (right).
  const yPd = (v: number) => pad.t + innerH - (v / (pdMax || 1)) * innerH;
  const ySurv = (v: number) => pad.t + innerH - (v / 100) * innerH;

  const sorted = [...cds].sort((a, b) => a.tenor - b.tenor);
  const pdPath = sorted.map((c, i) => `${i === 0 ? "M" : "L"}${xFor(c.tenor).toFixed(1)},${yPd(c.pd_pct).toFixed(1)}`).join(" ");
  const survPath = sorted.map((c, i) => `${i === 0 ? "M" : "L"}${xFor(c.tenor).toFixed(1)},${ySurv(c.survival_pct).toFixed(1)}`).join(" ");

  const pdTicks = useMemo(() => {
    const t: number[] = [];
    for (let i = 0; i <= 4; i++) t.push((pdMax / 4) * i);
    return t;
  }, [pdMax]);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} preserveAspectRatio="xMidYMid meet">
        {pdTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={yPd(t)} y2={yPd(t)} stroke="#1f1f1f" />
            <text x={pad.l - 6} y={yPd(t) + 3} fill={PD_COLOR} fontSize={9} textAnchor="end" fontFamily="monospace">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {/* right axis survival labels */}
        {[0, 25, 50, 75, 100].map((s) => (
          <text key={s} x={W - pad.r + 6} y={ySurv(s) + 3} fill={SURVIVAL_COLOR} fontSize={9} textAnchor="start" fontFamily="monospace">
            {s}
          </text>
        ))}
        {tenors.map((t) => (
          <text key={t} x={xFor(t)} y={H - 8} fill="#8b8b8b" fontSize={9} textAnchor="middle" fontFamily="monospace">
            {t}Y
          </text>
        ))}

        <path d={survPath} fill="none" stroke={SURVIVAL_COLOR} strokeWidth={2} strokeDasharray="4 3" />
        {sorted.map((c) => (
          <circle key={`s-${c.tenor}`} cx={xFor(c.tenor)} cy={ySurv(c.survival_pct)} r={2.5} fill={SURVIVAL_COLOR}>
            <title>
              {c.tenor}Y survival: {c.survival_pct.toFixed(2)}%
            </title>
          </circle>
        ))}

        <path d={pdPath} fill="none" stroke={PD_COLOR} strokeWidth={2} />
        {sorted.map((c) => (
          <circle key={`p-${c.tenor}`} cx={xFor(c.tenor)} cy={yPd(c.pd_pct)} r={2.5} fill={PD_COLOR}>
            <title>
              {c.tenor}Y default prob: {c.pd_pct.toFixed(2)}%
            </title>
          </circle>
        ))}

        <text x={pad.l} y={pad.t} fill={PD_COLOR} fontSize={9} fontFamily="monospace">
          PD %
        </text>
        <text x={W - pad.r} y={pad.t} fill={SURVIVAL_COLOR} fontSize={9} textAnchor="end" fontFamily="monospace">
          survival %
        </text>
      </svg>
      <div className="flex gap-4 mt-1 px-1">
        <Legend color={PD_COLOR} label="cumulative default prob" />
        <Legend color={SURVIVAL_COLOR} label="survival" dashed />
      </div>
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        {title.replace("&amp;", "&")}
      </div>
      {children}
    </div>
  );
}

function Legend({ color, label, value, dashed }: { color: string; label: string; value?: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      <span
        className="inline-block"
        style={
          dashed
            ? { width: 16, borderTop: `2px dashed ${color}` }
            : { width: 16, height: 2, borderRadius: 2, backgroundColor: color }
        }
      />
      {label}
      {value && <span className="text-terminal-muted tabular-nums ml-1">{value}</span>}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ratingClass(rating: string): string {
  const ig = new Set(["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-"]);
  if (ig.has(rating)) return "bg-accent-blue/15 text-accent-blue";
  return "bg-accent-amber/15 text-accent-amber";
}

function signedColor(v: number | null | undefined, invert = false): string {
  if (v == null) return "text-terminal-dim";
  const positive = invert ? v <= 0 : v >= 0;
  return positive ? "text-accent-green" : "text-accent-red";
}

function fmtBps(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(0)} bps`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
