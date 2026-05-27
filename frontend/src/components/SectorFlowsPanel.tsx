import type { PairSpread, SectorFlowsResponse } from "../api/types";

interface Props {
  data: SectorFlowsResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Flows panel.
 *
 * Two blocks:
 *   1. Pair spreads — sector ETF normalized vs SPY and vs a curated pair
 *      partner that captures the risk-on/off axis (e.g. XLK/XLU for tech).
 *      Each pair has a 1y normalized chart + current value + change windows.
 *   2. Options summary — 30d + 90d ATM IV, term structure (delta + inversion
 *      flag), P/C ratios, IV skew, implied move, IV-vs-realized ratio.
 *      When IV/realized > 3, flag as noisy data.
 */
export function SectorFlowsPanel({ data, expanded, onToggle }: Props) {
  const noisy = !!data?.options.iv_vs_realized_ratio && data.options.iv_vs_realized_ratio > 3;
  return (
    <section className="panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
      >
        <span className="text-terminal-muted uppercase tracking-wider font-semibold">
          Flows + Options
          {data && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              pair vs {data.pair_partner} · 30d/90d options
              {data.options.term_inverted && !noisy && " · ⚠ term inversion"}
              {noisy && " · ⚠ options data noisy"}
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading flows...</div>
          ) : !data.available ? (
            <div className="text-terminal-dim text-xs py-2 italic">No flow data available.</div>
          ) : (
            <>
              <PairSpreadsBlock pairs={data.pairs} />
              <OptionsBlock opts={data.options} etf={data.etf} noisy={noisy} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Pair spreads ───────────────────────────────────────────────────────────

function PairSpreadsBlock({ pairs }: { pairs: PairSpread[] }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5">
        Pair spreads (normalized to 100 at start)
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {pairs.map((p) => (
          <PairCard key={p.label} pair={p} />
        ))}
      </div>
    </div>
  );
}

function PairCard({ pair }: { pair: PairSpread }) {
  const isUp = (pair.current ?? 100) >= 100;
  const tone = isUp ? "text-green-400" : "text-rose-400";
  return (
    <div className="border border-terminal-border/40 rounded p-2 bg-terminal-panel/30">
      <div className="text-2xs text-terminal-dim font-mono truncate" title={pair.label}>
        {pair.label}
      </div>
      <div className="flex items-end justify-between gap-2 mt-1">
        <div>
          <div className={`text-lg font-mono tabular-nums leading-tight ${tone}`}>
            {pair.current?.toFixed(2) ?? "--"}
          </div>
          <div className="text-2xs text-terminal-dim flex gap-2 mt-0.5">
            <ChangeChip label="1w" v={pair.change_1w_pct} />
            <ChangeChip label="1m" v={pair.change_1m_pct} />
            <ChangeChip label="3m" v={pair.change_3m_pct} />
            <ChangeChip label="YTD" v={pair.change_ytd_pct} />
          </div>
        </div>
        <PairSparkline points={pair.spark} />
      </div>
    </div>
  );
}

function ChangeChip({ label, v }: { label: string; v: number | null }) {
  if (v === null) return <span className="text-terminal-dim">{label} --</span>;
  const color = v > 0 ? "text-green-400" : v < 0 ? "text-rose-400" : "text-terminal-dim";
  const sign = v > 0 ? "+" : "";
  return (
    <span className="text-terminal-dim">
      {label} <span className={`font-mono ${color}`}>{sign}{v.toFixed(1)}%</span>
    </span>
  );
}

function PairSparkline({ points }: { points: { date: string; value: number }[] }) {
  if (points.length < 2) return <div className="w-24 h-10" />;
  const values = points.map((p) => p.value);
  const min = Math.min(...values, 100);
  const max = Math.max(...values, 100);
  const range = max - min || 1;
  const W = 96;
  const H = 40;
  const step = W / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = H - ((p.value - min) / range) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1].value;
  const first = points[0].value;
  const stroke = last >= first ? "#34d399" : "#fb7185";
  // Baseline at 100 for ratio normalization.
  const baselineY = H - ((100 - min) / range) * H;
  return (
    <svg width={W} height={H} className="shrink-0">
      <line
        x1={0}
        x2={W}
        y1={baselineY}
        y2={baselineY}
        stroke="rgba(148,163,184,0.25)"
        strokeDasharray="2 2"
      />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} />
    </svg>
  );
}

// ─── Options block ──────────────────────────────────────────────────────────

function OptionsBlock({
  opts,
  etf,
  noisy,
}: {
  opts: SectorFlowsResponse["options"];
  etf: string;
  noisy: boolean;
}) {
  const ivVsR = opts.iv_vs_realized_ratio;
  const realizedPct = opts.realized_vol_21d_ann ? opts.realized_vol_21d_ann * 100 : null;
  const iv30Pct = opts.atm_iv_30d ? opts.atm_iv_30d * 100 : null;
  const iv90Pct = opts.atm_iv_90d ? opts.atm_iv_90d * 100 : null;
  const termDeltaBp = opts.term_structure_delta ? opts.term_structure_delta * 100 * 100 : null;
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1.5 flex justify-between">
        <span>{etf} options summary</span>
        {noisy && (
          <span className="text-amber-400 normal-case">
            ⚠ IV/realized = {ivVsR?.toFixed(2)}x — data may be noisy
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
        <OptTile
          label="ATM IV 30d"
          value={iv30Pct === null ? "--" : `${iv30Pct.toFixed(1)}%`}
          sub={opts.expiry_30 ? `exp ${opts.expiry_30}` : ""}
          danger={noisy}
        />
        <OptTile
          label="ATM IV 90d"
          value={iv90Pct === null ? "--" : `${iv90Pct.toFixed(1)}%`}
          sub={opts.expiry_90 ? `exp ${opts.expiry_90}` : ""}
        />
        <OptTile
          label="Term Δ (30-90)"
          value={termDeltaBp === null ? "--" : `${termDeltaBp > 0 ? "+" : ""}${termDeltaBp.toFixed(0)}bp`}
          sub={opts.term_inverted ? "inverted (stress)" : "contango"}
          danger={opts.term_inverted}
        />
        <OptTile
          label="P/C ratio (OI)"
          value={opts.pc_ratio_oi_30d?.toFixed(2) ?? "--"}
          sub={pcInterpretation(opts.pc_ratio_oi_30d)}
        />
        <OptTile
          label="P/C ratio (vol)"
          value={opts.pc_ratio_vol_30d?.toFixed(2) ?? "--"}
          sub="30d flow"
        />
        <OptTile
          label="Impl. move 30d (1σ)"
          value={opts.implied_move_1sigma_30d ? `$${opts.implied_move_1sigma_30d.toFixed(2)}` : "--"}
          sub={
            opts.implied_move_1sigma_30d && opts.spot
              ? `${((opts.implied_move_1sigma_30d / opts.spot) * 100).toFixed(1)}% of spot`
              : ""
          }
        />
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5 mt-1.5">
        <OptTile
          label="IV skew 30d"
          value={opts.iv_skew_30d === null ? "--" : (opts.iv_skew_30d * 100).toFixed(2)}
          sub={
            opts.iv_skew_30d === null
              ? ""
              : opts.iv_skew_30d > 0
                ? "put-skewed"
                : "call-skewed"
          }
        />
        <OptTile
          label="IV skew 90d"
          value={opts.iv_skew_90d === null ? "--" : (opts.iv_skew_90d * 100).toFixed(2)}
          sub={
            opts.iv_skew_90d === null
              ? ""
              : opts.iv_skew_90d > 0
                ? "put-skewed"
                : "call-skewed"
          }
        />
        <OptTile
          label="Realized vol 21d"
          value={realizedPct === null ? "--" : `${realizedPct.toFixed(1)}%`}
          sub="annualized"
        />
        <OptTile
          label="IV vs realized"
          value={ivVsR === null ? "--" : `${ivVsR?.toFixed(2)}x`}
          sub={ivInterp(ivVsR)}
          danger={noisy}
        />
        <OptTile
          label="Spot"
          value={opts.spot ? `$${opts.spot.toFixed(2)}` : "--"}
          sub=""
        />
        <OptTile
          label="DTE"
          value={opts.days_to_30 !== null ? `${opts.days_to_30}d` : "--"}
          sub={opts.days_to_90 !== null ? `90d: ${opts.days_to_90}d` : ""}
        />
      </div>

      {(opts.error_30 || opts.error_90) && (
        <div className="text-2xs text-rose-400 italic mt-2">
          {opts.error_30 && <div>30d chain: {opts.error_30}</div>}
          {opts.error_90 && <div>90d chain: {opts.error_90}</div>}
        </div>
      )}
    </div>
  );
}

function OptTile({
  label,
  value,
  sub,
  danger = false,
}: {
  label: string;
  value: string;
  sub: string;
  danger?: boolean;
}) {
  return (
    <div
      className={`border rounded px-2 py-1.5 ${
        danger ? "border-amber-500/40 bg-amber-500/5" : "border-terminal-border/40 bg-terminal-panel/30"
      }`}
    >
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div
        className={`font-mono tabular-nums text-sm leading-tight ${
          danger ? "text-amber-400" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-2xs text-terminal-dim/80 truncate">{sub}</div>}
    </div>
  );
}

function pcInterpretation(pc: number | null): string {
  if (pc === null) return "";
  if (pc >= 1.3) return "put-heavy (fear)";
  if (pc <= 0.7) return "call-heavy (greed)";
  return "balanced";
}

function ivInterp(r: number | null): string {
  if (r === null) return "";
  if (r > 3) return "noisy / suspect";
  if (r >= 1.3) return "rich (premium)";
  if (r <= 0.7) return "cheap";
  return "fair";
}
