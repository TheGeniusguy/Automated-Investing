import { useEffect, useState } from "react";

import { api } from "../api/client";

/**
 * Panel - Analyst Estimates & Revisions (Bloomberg EE / EM analog).
 *
 * Consumes GET /api/estimates/{symbol} (api.estimates). Surfaces the sell-side
 * picture for one ticker: forward consensus EPS + revenue, the price-target
 * distribution vs the current quote, estimate-revision momentum, front-quarter
 * dispersion, and the realized surprise history. The shape is mirrored here as
 * local interfaces so the panel owns nothing in the shared types module.
 */

interface ConsensusRow {
  period: string;
  eps_est: number | null;
  rev_est: number | null;
  num_analysts: number | null;
}

interface Revisions {
  up: number;
  down: number;
  flat: number;
  trend: string;
  up_90d?: number;
  down_90d?: number;
  flat_90d?: number;
}

interface Dispersion {
  low: number | null;
  mean: number | null;
  high: number | null;
  std: number | null;
  num_analysts: number | null;
}

interface PriceTarget {
  low: number | null;
  mean: number | null;
  median: number | null;
  high: number | null;
  current: number | null;
  upside_pct: number | null;
}

interface SurpriseRow {
  period: string;
  estimate: number | null;
  actual: number | null;
  surprise_pct: number | null;
}

interface EstimatesData {
  symbol: string;
  consensus: ConsensusRow[];
  revisions: Revisions;
  dispersion: Dispersion;
  price_target: PriceTarget;
  surprises: SurpriseRow[];
  data_mode: string;
  as_of: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return `$${v.toFixed(2)}`;
}

function fmtRev(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function EstimatesPanel() {
  const [symbolRaw, setSymbolRaw] = useState<string>("AAPL");
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [data, setData] = useState<EstimatesData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api.estimates(sym)
      .then((d: unknown) => { if (alive) setData(d as EstimatesData); })
      .catch((e: unknown) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol]);

  function submit() {
    const sym = symbolRaw.trim().toUpperCase();
    if (sym) setSymbol(sym);
  }

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Analyst Estimates</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching" : data ? data.symbol : ""}
        </span>
      </div>

      <div className="panel-body p-0 flex flex-col">
        {/* Symbol input */}
        <div className="px-3 py-2 border-b border-terminal-divider flex items-end gap-2">
          <div className="flex-1">
            <label className="text-2xs uppercase tracking-wider text-terminal-muted">symbol</label>
            <input
              value={symbolRaw}
              onChange={(e) => setSymbolRaw(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              spellCheck={false}
              className="mt-1 w-full bg-black/40 border border-terminal-divider
                         text-terminal-text font-mono text-sm px-2 py-1.5 outline-none
                         focus:border-accent-amber/60 uppercase"
            />
          </div>
          <button
            onClick={submit}
            className="px-3 py-1.5 text-2xs uppercase tracking-wider font-semibold
                       border border-terminal-divider text-terminal-text
                       hover:border-accent-amber/60 hover:text-accent-amber transition-colors"
          >
            Load
          </button>
        </div>

        {err && <div className="p-3 text-accent-red text-xs">{err}</div>}

        {!data && loading && (
          <div className="p-4 text-terminal-dim text-xs">Loading estimates...</div>
        )}

        {data && (
          <div className="flex-1 overflow-auto p-3 grid grid-cols-2 gap-3">
            {/* Price target hero + distribution */}
            <div className="col-span-2">
              <PriceTargetCard pt={data.price_target} />
            </div>

            {/* Consensus table */}
            <div className="col-span-2">
              <ConsensusTable rows={data.consensus} />
            </div>

            {/* Revisions */}
            <div className="col-span-1">
              <RevisionsCard rev={data.revisions} disp={data.dispersion} />
            </div>

            {/* Surprise history */}
            <div className="col-span-1">
              <SurpriseHistory rows={data.surprises} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Price target distribution
// ---------------------------------------------------------------------------

function PriceTargetCard({ pt }: { pt: PriceTarget }) {
  const lo = pt.low ?? 0;
  const hi = pt.high ?? 0;
  const cur = pt.current ?? 0;
  // Scale so both the analyst range and the current quote always fit.
  const min = Math.min(lo, cur);
  const max = Math.max(hi, cur);
  const span = max - min || 1;
  const pos = (v: number | null): number => {
    if (v === null || Number.isNaN(v)) return 0;
    return ((v - min) / span) * 100;
  };

  return (
    <div className="border border-terminal-divider rounded-panel p-3 bg-white/[0.01]">
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-2xs uppercase tracking-wider text-terminal-muted">Price Target</div>
          <div className="text-sm text-terminal-text mt-0.5">
            Mean <span className="stat-figure text-terminal-text">{fmtUsd(pt.mean)}</span>
            <span className="text-terminal-dim"> vs current </span>
            <span className="stat-figure text-terminal-text">{fmtUsd(pt.current)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xs uppercase tracking-wider text-terminal-muted">Upside</div>
          <div className={"stat-figure text-3xl " + signClass(pt.upside_pct)}>
            {fmtPct(pt.upside_pct)}
          </div>
        </div>
      </div>

      {/* Distribution bar: low - mean - median - high vs current */}
      <div className="relative h-9 mt-2">
        {/* range track */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-accent-blue/30 rounded-full"
          style={{ left: `${pos(pt.low)}%`, width: `${Math.max(0, pos(pt.high) - pos(pt.low))}%` }}
        />
        {/* low / high ticks */}
        <Marker pos={pos(pt.low)} color="bg-terminal-muted" label={fmtUsd(pt.low)} labelBelow />
        <Marker pos={pos(pt.high)} color="bg-terminal-muted" label={fmtUsd(pt.high)} labelBelow />
        {/* median */}
        <Marker pos={pos(pt.median)} color="bg-accent-blue" label="med" />
        {/* mean (accent) */}
        <Marker pos={pos(pt.mean)} color="bg-accent-amber" label="mean" tall />
        {/* current quote */}
        <Marker
          pos={pos(pt.current)}
          color={(pt.upside_pct ?? 0) >= 0 ? "bg-accent-green" : "bg-accent-red"}
          label="now"
          tall
        />
      </div>
      <div className="flex justify-between text-2xs text-terminal-dim mt-1 font-mono tabular-nums">
        <span>{fmtUsd(pt.low)}</span>
        <span>{fmtUsd(pt.high)}</span>
      </div>
    </div>
  );
}

function Marker({
  pos, color, label, tall, labelBelow,
}: {
  pos: number;
  color: string;
  label: string;
  tall?: boolean;
  labelBelow?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, pos));
  return (
    <div
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex flex-col items-center"
      style={{ left: `${clamped}%` }}
    >
      {!labelBelow && (
        <span className="text-[9px] uppercase tracking-wider text-terminal-dim mb-0.5 whitespace-nowrap">
          {label}
        </span>
      )}
      <span className={`block w-1 ${tall ? "h-5" : "h-3.5"} ${color} rounded-full`} />
      {labelBelow && (
        <span className="text-[9px] text-terminal-dim mt-0.5 whitespace-nowrap font-mono tabular-nums">
          {label}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consensus table
// ---------------------------------------------------------------------------

function ConsensusTable({ rows }: { rows: ConsensusRow[] }) {
  return (
    <div className="border border-terminal-divider rounded-panel overflow-hidden">
      <div className="px-3 py-1.5 text-2xs uppercase tracking-wider text-terminal-muted
                      bg-white/[0.015] border-b border-terminal-divider">
        Consensus Estimates
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead className="text-terminal-muted text-2xs uppercase tracking-wider">
          <tr className="border-b border-terminal-divider">
            <th className="text-left py-1.5 pl-3 pr-2">Period</th>
            <th className="text-right pr-3">EPS Est</th>
            <th className="text-right pr-3">Revenue Est</th>
            <th className="text-right pr-3">Analysts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-terminal-divider">
          {rows.map((r) => (
            <tr key={r.period} className="hover:bg-white/[0.02]">
              <td className="py-1.5 pl-3 pr-2 text-accent-amber whitespace-nowrap">{r.period}</td>
              <td className="pr-3 text-right text-terminal-text font-mono">{fmtUsd(r.eps_est)}</td>
              <td className="pr-3 text-right text-terminal-text font-mono">{fmtRev(r.rev_est)}</td>
              <td className="pr-3 text-right text-terminal-muted font-mono">{r.num_analysts ?? "-"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="p-3 text-terminal-dim text-xs">No consensus data.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revisions + dispersion
// ---------------------------------------------------------------------------

function RevisionsCard({ rev, disp }: { rev: Revisions; disp: Dispersion }) {
  const total = (rev.up || 0) + (rev.down || 0) + (rev.flat || 0) || 1;
  const upPct = ((rev.up || 0) / total) * 100;
  const flatPct = ((rev.flat || 0) / total) * 100;
  const downPct = ((rev.down || 0) / total) * 100;
  const trend = (rev.trend || "flat").toLowerCase();
  const trendColor =
    trend === "up" ? "text-accent-green" : trend === "down" ? "text-accent-red" : "text-terminal-muted";

  return (
    <div className="border border-terminal-divider rounded-panel p-3 bg-white/[0.01] h-full">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs uppercase tracking-wider text-terminal-muted">Revisions (30d)</span>
        <span className={"pill " + trendColor}>{trend}</span>
      </div>

      {/* stacked momentum bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2">
        <span className="bg-accent-green" style={{ width: `${upPct}%` }} />
        <span className="bg-terminal-muted/40" style={{ width: `${flatPct}%` }} />
        <span className="bg-accent-red" style={{ width: `${downPct}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <RevStat label="Up" value={rev.up} extra={rev.up_90d} cls="text-accent-green" />
        <RevStat label="Flat" value={rev.flat} extra={rev.flat_90d} cls="text-terminal-text" />
        <RevStat label="Down" value={rev.down} extra={rev.down_90d} cls="text-accent-red" />
      </div>

      <div className="border-t border-terminal-divider mt-3 pt-2">
        <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">
          Front-Quarter Dispersion
        </div>
        <div className="flex items-baseline justify-between text-xs font-mono tabular-nums">
          <span className="text-terminal-dim">{fmtUsd(disp.low)}</span>
          <span className="stat-figure text-base text-terminal-text">{fmtUsd(disp.mean)}</span>
          <span className="text-terminal-dim">{fmtUsd(disp.high)}</span>
        </div>
        <div className="flex justify-between text-2xs text-terminal-dim mt-0.5">
          <span>low</span>
          <span>std {disp.std !== null && disp.std !== undefined ? disp.std.toFixed(2) : "-"}</span>
          <span>high</span>
        </div>
      </div>
    </div>
  );
}

function RevStat({
  label, value, extra, cls,
}: {
  label: string;
  value: number | null | undefined;
  extra: number | null | undefined;
  cls: string;
}) {
  return (
    <div>
      <div className={"stat-figure text-2xl " + cls}>{value ?? 0}</div>
      <div className="text-2xs uppercase tracking-wider text-terminal-muted">{label}</div>
      {extra !== null && extra !== undefined && (
        <div className="text-2xs text-terminal-dim font-mono">90d {extra}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surprise history
// ---------------------------------------------------------------------------

function SurpriseHistory({ rows }: { rows: SurpriseRow[] }) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.surprise_pct ?? 0)));

  return (
    <div className="border border-terminal-divider rounded-panel p-3 bg-white/[0.01] h-full flex flex-col">
      <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-2">
        Surprise History (EPS)
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-terminal-muted text-2xs uppercase tracking-wider">
            <tr className="border-b border-terminal-divider">
              <th className="text-left py-1 pr-2">Period</th>
              <th className="text-right pr-2">Est</th>
              <th className="text-right pr-2">Act</th>
              <th className="text-right pr-2">Surprise</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-terminal-divider">
            {rows.map((r) => {
              const sp = r.surprise_pct ?? 0;
              const beat = sp >= 0;
              const w = (Math.abs(sp) / maxAbs) * 100;
              return (
                <tr key={r.period} className="hover:bg-white/[0.02]">
                  <td className="py-1 pr-2 text-terminal-muted whitespace-nowrap">{r.period}</td>
                  <td className="pr-2 text-right text-terminal-dim font-mono">{fmtUsd(r.estimate)}</td>
                  <td className="pr-2 text-right text-terminal-text font-mono">{fmtUsd(r.actual)}</td>
                  <td className={"pr-2 text-right font-mono " + signClass(r.surprise_pct)}>
                    {fmtPct(r.surprise_pct)}
                  </td>
                  <td className="pl-1 pr-1">
                    {/* mini diverging bar around a center axis */}
                    <div className="relative h-2 w-full">
                      <span className="absolute top-0 bottom-0 left-1/2 w-px bg-terminal-divider" />
                      <span
                        className={"absolute top-0 bottom-0 rounded-sm " + (beat ? "bg-accent-green" : "bg-accent-red")}
                        style={
                          beat
                            ? { left: "50%", width: `${w / 2}%` }
                            : { right: "50%", width: `${w / 2}%` }
                        }
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="p-3 text-terminal-dim text-xs">No surprise history.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
