import type { SectorRiskResponse, DrawdownRow } from "../api/types";

interface Props {
  data: SectorRiskResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Risk + Drawdowns panel.
 *
 * Three blocks:
 *   1. Top 5 historical drawdowns with peak/trough/recovery dates, depth %,
 *      duration, and macro regime active at the trough.
 *   2. Tail risk tile grid: realized vol, Sharpe, Sortino, CVaR-95, max DD.
 *   3. Two single-stat indicators: vol regime percentile + sector-SPY corr z.
 */
export function SectorRiskPanel({ data, expanded, onToggle }: Props) {
  return (
    <section className="panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
      >
        <span className="text-terminal-muted uppercase tracking-wider font-semibold">
          Risk + Drawdowns
          {data?.available && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              {data.drawdown_count_total} drawdowns over 10y · max{" "}
              {data.tail_risk?.max_dd_depth_pct?.toFixed(1)}%
              {!data.regime_classifier_available && " · FRED key needed for regime tags"}
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading risk analytics...</div>
          ) : !data.available ? (
            <div className="text-terminal-dim text-xs py-2 italic">{data.reason}</div>
          ) : (
            <>
              <DrawdownsList
                drawdowns={data.drawdowns}
                classifierAvailable={data.regime_classifier_available}
              />
              <TailRiskGrid tail={data.tail_risk as Record<string, number | null>} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <VolRegimeCard vr={data.vol_regime} />
                <CorrelationCard corr={data.correlation_to_spy} etf={data.etf} />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Drawdowns list ─────────────────────────────────────────────────────────

function DrawdownsList({
  drawdowns,
  classifierAvailable,
}: {
  drawdowns: DrawdownRow[];
  classifierAvailable: boolean;
}) {
  if (drawdowns.length === 0) {
    return <div className="text-terminal-dim text-xs italic">No material drawdowns (≥5%) found.</div>;
  }
  const worst = Math.abs(drawdowns[0].depth_pct);
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">
        Top 5 drawdowns (10y history, ≥5% depth)
      </div>
      <table className="w-full text-xs">
        <thead className="text-terminal-dim uppercase tracking-wider text-2xs">
          <tr className="border-b border-terminal-border/30">
            <th className="text-left py-1 px-1">Depth</th>
            <th className="text-left py-1 px-1">Peak</th>
            <th className="text-left py-1 px-1">Trough</th>
            <th className="text-left py-1 px-1">Recovery</th>
            <th className="text-right py-1 px-1">Days</th>
            <th className="text-left py-1 px-1">Regime at trough</th>
          </tr>
        </thead>
        <tbody>
          {drawdowns.map((d) => {
            const bar = (Math.abs(d.depth_pct) / worst) * 100;
            return (
              <tr
                key={`${d.peak_date}-${d.trough_date}`}
                className="border-b border-terminal-border/20 hover:bg-terminal-panel/40"
              >
                <td className="py-1 px-1 font-mono tabular-nums text-rose-400 relative">
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-rose-500/15"
                    style={{ width: `${bar}%` }}
                  />
                  <span className="relative">{d.depth_pct.toFixed(1)}%</span>
                </td>
                <td className="py-1 px-1 font-mono text-terminal-dim text-2xs">{d.peak_date}</td>
                <td className="py-1 px-1 font-mono text-2xs">{d.trough_date}</td>
                <td className="py-1 px-1 font-mono text-2xs">
                  {d.ongoing ? (
                    <span className="text-amber-400">ongoing</span>
                  ) : (
                    <span className="text-green-400">{d.recovery_date}</span>
                  )}
                </td>
                <td className="py-1 px-1 text-right font-mono tabular-nums text-2xs text-terminal-dim">
                  {d.drawdown_days}d ↓
                  {d.recovery_days !== null && <span className="text-terminal-muted">/{d.recovery_days}d ↑</span>}
                </td>
                <td className="py-1 px-1 text-2xs">
                  <RegimeBadge label={d.trough_regime} classifierAvailable={classifierAvailable} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RegimeBadge({
  label,
  classifierAvailable,
}: {
  label: string;
  classifierAvailable: boolean;
}) {
  if (!classifierAvailable || label === "n/a") {
    return <span className="text-terminal-dim italic text-2xs">n/a</span>;
  }
  const cls =
    label === "risk_on"
      ? "bg-green-500/15 text-green-400 border-green-500/30"
      : label === "risk_off"
        ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
        : "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return (
    <span className={`inline-block px-1.5 py-0.5 border rounded text-2xs font-mono ${cls}`}>
      {label}
    </span>
  );
}

// ─── Tail risk grid ─────────────────────────────────────────────────────────

function TailRiskGrid({ tail }: { tail: Record<string, number | null> }) {
  if (!tail || Object.keys(tail).length === 0) {
    return null;
  }
  const items: { label: string; key: string; fmt: (v: number) => string; color?: string }[] = [
    { label: "Ann. return", key: "annual_return_pct", fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%` },
    { label: "Ann. vol",    key: "annual_vol_pct",    fmt: (v) => `${v.toFixed(1)}%` },
    { label: "Sharpe",      key: "sharpe_ann",        fmt: (v) => v.toFixed(2) },
    { label: "Sortino",     key: "sortino_ann",       fmt: (v) => v.toFixed(2) },
    { label: "21D vol",     key: "vol_21d_annualized_pct",  fmt: (v) => `${v.toFixed(1)}%` },
    { label: "252D vol",    key: "vol_252d_annualized_pct", fmt: (v) => `${v.toFixed(1)}%` },
    { label: "CVaR-95 (1d)",key: "cvar_95_daily_pct", fmt: (v) => `${v.toFixed(2)}%`, color: "text-rose-400" },
    { label: "Max DD",      key: "max_dd_depth_pct",  fmt: (v) => `${v.toFixed(1)}%`, color: "text-rose-400" },
  ];
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">Tail risk (10y)</div>
      <div className="grid grid-cols-4 gap-1.5">
        {items.map((it) => {
          const v = tail[it.key];
          return (
            <div
              key={it.key}
              className="border border-terminal-border/40 rounded px-2 py-1.5 bg-terminal-panel/40"
            >
              <div className="text-2xs uppercase tracking-wider text-terminal-dim">{it.label}</div>
              <div
                className={`font-mono tabular-nums text-sm ${
                  it.color ?? (v !== null && v < 0 ? "text-rose-400" : "")
                }`}
              >
                {v === null ? "--" : it.fmt(v)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Vol regime + correlation cards ─────────────────────────────────────────

function VolRegimeCard({ vr }: { vr: SectorRiskResponse["vol_regime"] }) {
  if (vr.current_vol_pct === null || vr.percentile === null) return null;
  const pctile = vr.percentile;
  // Position the current marker on a 0..100 bar.
  const markerLeft = Math.max(0, Math.min(100, pctile));
  const tone =
    pctile >= 80 ? "text-rose-400" : pctile >= 60 ? "text-amber-400" : "text-green-400";
  return (
    <div className="border border-terminal-border/40 rounded p-2">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1">
        Vol regime (21D realized, vs 10y history)
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`font-mono tabular-nums text-base ${tone}`}>{vr.current_vol_pct.toFixed(1)}%</span>
        <span className="text-2xs text-terminal-dim">
          p{pctile.toFixed(0)} · p10={vr.p10?.toFixed(1)}% / p50={vr.p50?.toFixed(1)}% / p90={vr.p90?.toFixed(1)}%
        </span>
      </div>
      <div className="relative h-2 bg-terminal-panel/40 rounded mt-1.5 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-green-500/30 via-amber-500/30 to-rose-500/30" />
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-terminal-text"
          style={{ left: `${markerLeft}%` }}
        />
      </div>
    </div>
  );
}

function CorrelationCard({
  corr,
  etf,
}: {
  corr: SectorRiskResponse["correlation_to_spy"];
  etf: string;
}) {
  if (corr.current === null || corr.z === null) return null;
  const z = corr.z;
  const tone =
    Math.abs(z) >= 2 ? "text-rose-400" : Math.abs(z) >= 1 ? "text-amber-400" : "text-terminal-text";
  const interpretation =
    z >= 2
      ? "Sector trading much more in lockstep with SPY than usual"
      : z >= 1
        ? "Mildly elevated correlation"
        : z <= -2
          ? "Sector detaching from SPY — significant divergence"
          : z <= -1
            ? "Mild divergence from market"
            : "In line with sector's typical correlation";
  return (
    <div className="border border-terminal-border/40 rounded p-2">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1">
        {etf} vs SPY (60D rolling correlation)
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`font-mono tabular-nums text-base ${tone}`}>
          {corr.current.toFixed(2)}
        </span>
        <span className="text-2xs text-terminal-dim">
          z={z.toFixed(2)} · 10y μ={corr.mean?.toFixed(2)} σ={corr.std?.toFixed(2)}
        </span>
      </div>
      <div className="text-2xs text-terminal-dim mt-1">{interpretation}</div>
    </div>
  );
}
