import { useState } from "react";

import type {
  DecompositionConstituent,
  IfRemovedRow,
  SectorDecompositionResponse,
} from "../api/types";

interface Props {
  data: SectorDecompositionResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Constituent Decomposition.
 *
 * Shows:
 *   1. Contribution waterfall — top +/- contributors for the selected window
 *   2. "If removed" simulator table — basket return ex-top-1/3/5
 *   3. Concentration stats — Herfindahl + top weight shares
 *   4. Hidden weakness alert — when basket up but breadth weak, who's masking
 *
 * Weights are cap-weighted across the curated key_stocks list, not actual ETF
 * holdings — surfaced in the notes line.
 */
export function SectorDecompositionPanel({ data, expanded, onToggle }: Props) {
  const [window, setWindow] = useState<string>("1m");

  return (
    <section className="panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
      >
        <span className="text-terminal-muted uppercase tracking-wider font-semibold">
          Constituent Decomposition
          {data && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              cap-weighted · {data.constituents.length} names · Herf {data.concentration.herfindahl.toFixed(2)}
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading decomposition...</div>
          ) : (
            <>
              {/* Window selector */}
              <div className="flex gap-1">
                {data.windows.map((w) => (
                  <button
                    key={w.key}
                    type="button"
                    onClick={() => setWindow(w.key)}
                    className={`px-2 py-0.5 text-2xs rounded uppercase tracking-wider ${
                      window === w.key
                        ? "bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40"
                        : "bg-terminal-panel/40 text-terminal-dim border border-terminal-border/40 hover:border-terminal-border"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              {/* Headline reads */}
              <HeadlineRow data={data} window={window} />

              {/* Hidden weakness alert (only if triggered for this window) */}
              {data.hidden_weakness[window] && (
                <HiddenWeaknessAlert hw={data.hidden_weakness[window]!} />
              )}

              {/* Contribution waterfall */}
              <ContributionWaterfall constituents={data.constituents} window={window} />

              {/* If-removed simulator */}
              <IfRemovedTable rows={data.if_removed[window] ?? []} />

              {/* Concentration stats */}
              <ConcentrationStats data={data} />

              <div className="text-2xs text-terminal-dim italic mt-1">
                {data.notes}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function HeadlineRow({
  data,
  window,
}: {
  data: SectorDecompositionResponse;
  window: string;
}) {
  const basket = data.basket_returns_pct[window];
  const etf = data.etf_returns_pct[window];
  const drift = basket !== null && etf !== null ? basket - etf : null;
  return (
    <div className="flex flex-wrap gap-4 text-xs">
      <Stat label="Basket return" value={basket} />
      <Stat label={`${data.etf} actual`} value={etf} />
      {drift !== null && (
        <Stat label="Curated drift" value={drift} muted />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number | null;
  muted?: boolean;
}) {
  const color =
    value === null
      ? "text-terminal-dim"
      : value > 0
        ? "text-green-400"
        : value < 0
          ? "text-rose-400"
          : "text-terminal-dim";
  const sign = value !== null && value > 0 ? "+" : "";
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`font-mono tabular-nums text-base ${muted ? "text-terminal-muted" : color}`}>
        {value === null ? "--" : `${sign}${value.toFixed(2)}%`}
      </div>
    </div>
  );
}

function HiddenWeaknessAlert({
  hw,
}: {
  hw: NonNullable<SectorDecompositionResponse["hidden_weakness"][string]>;
}) {
  const names = hw.masking_names.map((m) => `${m.symbol} (+${m.contribution_pct.toFixed(2)}pp)`).join(", ");
  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-amber-400 font-semibold mb-1">
        ⚠ Hidden weakness
      </div>
      <div className="text-xs text-terminal-muted">
        Basket <span className="text-green-400 font-mono">+{hw.basket_return_pct.toFixed(2)}%</span>
        {" but "}
        <span className="text-rose-400 font-mono">{hw.n_negative}/{hw.n_constituents}</span>
        {" "}constituents negative ({hw.pct_constituents_negative.toFixed(0)}%).
        Masking names: <span className="font-mono text-terminal-text">{names}</span>
      </div>
    </div>
  );
}

function ContributionWaterfall({
  constituents,
  window,
}: {
  constituents: DecompositionConstituent[];
  window: string;
}) {
  const rows = constituents
    .map((c) => ({
      symbol: c.symbol,
      weight: c.weight_pct,
      contribution: c.contributions_pct[window],
      ret: c.returns_pct[window],
    }))
    .filter((r) => r.contribution !== null) as {
      symbol: string;
      weight: number;
      contribution: number;
      ret: number | null;
    }[];

  if (rows.length === 0) {
    return <div className="text-terminal-dim text-xs italic">No contribution data for this window.</div>;
  }

  rows.sort((a, b) => b.contribution - a.contribution);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.contribution)), 0.01);

  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">
        Contribution waterfall (weight × return)
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => {
          const pct = (Math.abs(r.contribution) / maxAbs) * 100;
          const color =
            r.contribution > 0 ? "bg-green-500/50" : r.contribution < 0 ? "bg-rose-500/50" : "bg-terminal-dim/40";
          return (
            <div key={r.symbol} className="flex items-center gap-2 text-xs">
              <div className="w-14 font-mono shrink-0">{r.symbol}</div>
              <div className="w-12 text-right text-terminal-dim font-mono shrink-0 text-2xs">
                {r.weight.toFixed(1)}%
              </div>
              <div className="flex-1 relative h-4 bg-terminal-panel/30 rounded">
                <div
                  className={`absolute top-0 h-full ${color} rounded`}
                  style={{
                    width: `${pct / 2}%`,
                    left: r.contribution > 0 ? "50%" : `${50 - pct / 2}%`,
                  }}
                />
                <div className="absolute inset-0 border-l border-terminal-border/50" style={{ left: "50%" }} />
              </div>
              <div className="w-16 text-right font-mono tabular-nums text-2xs shrink-0">
                <span className={r.contribution > 0 ? "text-green-400" : r.contribution < 0 ? "text-rose-400" : ""}>
                  {r.contribution > 0 ? "+" : ""}{r.contribution.toFixed(2)}pp
                </span>
              </div>
              <div className="w-14 text-right text-terminal-dim font-mono tabular-nums shrink-0 text-2xs">
                {r.ret === null ? "--" : `${r.ret > 0 ? "+" : ""}${r.ret.toFixed(1)}%`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IfRemovedTable({ rows }: { rows: IfRemovedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">
        "If removed" simulator
      </div>
      <table className="w-full text-xs">
        <thead className="text-terminal-dim uppercase tracking-wider text-2xs">
          <tr className="border-b border-terminal-border/30">
            <th className="text-left py-1">Scenario</th>
            <th className="text-right py-1">Return</th>
            <th className="text-right py-1">Δ vs full</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isFull = r.removed.length === 0;
            return (
              <tr key={r.label} className={i === 0 ? "" : "border-t border-terminal-border/20"}>
                <td className={`py-1 ${isFull ? "font-semibold" : "text-terminal-muted"}`}>
                  {r.label}
                </td>
                <td className="py-1 text-right font-mono tabular-nums">
                  {r.return_pct === null ? (
                    <span className="text-terminal-dim">--</span>
                  ) : (
                    <span className={r.return_pct > 0 ? "text-green-400" : r.return_pct < 0 ? "text-rose-400" : ""}>
                      {r.return_pct > 0 ? "+" : ""}{r.return_pct.toFixed(2)}%
                    </span>
                  )}
                </td>
                <td className="py-1 text-right font-mono tabular-nums text-2xs">
                  {isFull || r.delta_vs_full_pct === null ? (
                    <span className="text-terminal-dim">--</span>
                  ) : (
                    <span className={r.delta_vs_full_pct > 0 ? "text-green-400" : "text-rose-400"}>
                      {r.delta_vs_full_pct > 0 ? "+" : ""}{r.delta_vs_full_pct.toFixed(2)}pp
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConcentrationStats({ data }: { data: SectorDecompositionResponse }) {
  const c = data.concentration;
  const herfClass =
    c.herfindahl >= 0.25
      ? "text-rose-400"
      : c.herfindahl >= 0.15
        ? "text-amber-400"
        : "text-green-400";
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">
        Concentration
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <ConcStat label="Herfindahl" value={c.herfindahl.toFixed(3)} valueClass={herfClass} />
        <ConcStat label="Top 1" value={`${c.top1_weight_pct.toFixed(1)}%`} />
        <ConcStat label="Top 3" value={`${c.top3_weight_pct.toFixed(1)}%`} />
        <ConcStat label="Top 5" value={`${c.top5_weight_pct.toFixed(1)}%`} />
        <ConcStat label="Top 10" value={`${c.top10_weight_pct.toFixed(1)}%`} />
        <ConcStat label="Names" value={`${c.constituent_count}`} />
      </div>
    </div>
  );
}

function ConcStat({
  label,
  value,
  valueClass = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`font-mono tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
