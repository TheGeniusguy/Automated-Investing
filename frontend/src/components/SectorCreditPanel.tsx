import type { SectorCreditKpi, SectorCreditResponse } from "../api/types";

interface Props {
  data: SectorCreditResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Credit + Bond layer.
 *
 * Top: credit-equity divergence indicator (amber when flagged).
 * Body: bucketed credit KPI tiles — broad spreads, IG ladder, HY ladder,
 *       universal bond ETFs, sector-specific block.
 */
export function SectorCreditPanel({ data, expanded, onToggle }: Props) {
  const hasData = !!data && data.available;
  const fredMissing = !!data && !data.fred_available;
  return (
    <section className="panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-terminal-border/20"
      >
        <span className="text-terminal-muted uppercase tracking-wider font-semibold">
          Credit + Bond Layer
          {data && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              IG/HY ladder + sector credit
              {fredMissing && " · FRED key needed for OAS spreads"}
              {data.divergence?.flagged && " · ⚠ divergence flagged"}
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading credit data...</div>
          ) : !hasData ? (
            <div className="text-terminal-dim text-xs py-2 italic">No credit data available.</div>
          ) : (
            <>
              <DivergenceCard div={data.divergence} />
              {data.buckets.map((bucket) => (
                <BucketBlock
                  key={bucket.label}
                  label={bucket.label}
                  kpis={bucket.kpis}
                  accent={!!bucket.sector_specific}
                />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Divergence card ────────────────────────────────────────────────────────

function DivergenceCard({ div }: { div: SectorCreditResponse["divergence"] }) {
  if (!div.available) {
    return (
      <div className="text-2xs text-terminal-dim italic">
        Credit-equity divergence indicator: {div.reason ?? "unavailable"}
      </div>
    );
  }
  const flagged = !!div.flagged;
  const corr = div.current_corr ?? 0;
  const tone = flagged
    ? "border-amber-500/50 bg-amber-500/5"
    : corr <= -0.30
      ? "border-green-500/40 bg-green-500/5"
      : "border-terminal-border/40 bg-terminal-panel/30";
  return (
    <div className={`border rounded p-2 ${tone}`}>
      <div className={`text-2xs uppercase tracking-wider mb-1 font-semibold ${flagged ? "text-amber-400" : "text-terminal-dim"}`}>
        {flagged ? "⚠ " : ""}Credit-equity divergence (60D rolling)
      </div>
      <div className="flex items-baseline gap-3 text-xs">
        <Stat label="Current corr" value={corr} fmt={(v) => v.toFixed(2)} colored />
        <Stat label="5y μ" value={div.baseline_mean ?? null} fmt={(v) => v.toFixed(2)} />
        <Stat label="5y σ" value={div.baseline_std ?? null} fmt={(v) => v.toFixed(2)} />
        <Stat label="z" value={div.z_score ?? null} fmt={(v) => v.toFixed(2)} colored />
      </div>
      <div className="text-2xs text-terminal-muted mt-1">{div.interpretation}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  fmt,
  colored = false,
}: {
  label: string;
  value: number | null;
  fmt: (v: number) => string;
  colored?: boolean;
}) {
  const color = !colored
    ? "text-terminal-text"
    : value === null
      ? "text-terminal-dim"
      : value > 0
        ? "text-rose-400"
        : value < 0
          ? "text-green-400"
          : "text-terminal-dim";
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</div>
      <div className={`font-mono tabular-nums ${color}`}>
        {value === null ? "--" : fmt(value)}
      </div>
    </div>
  );
}

// ─── Bucket + tile ──────────────────────────────────────────────────────────

function BucketBlock({
  label,
  kpis,
  accent = false,
}: {
  label: string;
  kpis: SectorCreditKpi[];
  accent?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-2xs uppercase tracking-wider mb-1.5 ${
          accent ? "text-accent-cyan" : "text-terminal-dim"
        }`}
      >
        {label}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-1.5">
        {kpis.map((k) => (
          <CreditTile key={`${label}-${k.id}`} k={k} />
        ))}
      </div>
    </div>
  );
}

function CreditTile({ k }: { k: SectorCreditKpi }) {
  const isRate = k.unit === "%" || k.unit === "bp";
  // For spreads, falling = good for risk. Use inverted color sense for rate tiles.
  const primary = isRate ? k.change_1d_abs : k.change_1d_pct;
  const primaryLabel = isRate ? "Δ1d" : "%1d";

  if (!k.available) {
    return (
      <div className="border border-terminal-border/40 rounded px-2 py-1.5 bg-terminal-panel/30">
        <div className="flex items-baseline justify-between gap-1">
          <span className="text-terminal-muted text-xs font-semibold truncate" title={k.label}>{k.label}</span>
          <span className="text-terminal-dim text-2xs font-mono">{k.id}</span>
        </div>
        <div className="text-terminal-dim text-2xs mt-1 italic">{k.reason ?? "Unavailable"}</div>
      </div>
    );
  }

  return (
    <div
      className="border border-terminal-border/50 rounded px-2 py-1.5 bg-terminal-panel/40 hover:border-terminal-border transition-colors"
      title={k.desc}
    >
      <div className="flex items-baseline justify-between gap-1 mb-0.5">
        <span className="text-terminal-muted text-xs font-semibold truncate">{k.label}</span>
        <span className="text-terminal-dim text-2xs font-mono shrink-0">{k.id}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-base font-mono tabular-nums leading-tight">
            {formatValue(k.last_value, k.unit)}
          </div>
          <div className="text-2xs text-terminal-dim mt-0.5 flex gap-1.5">
            <ChangeChip label={primaryLabel} value={primary} isRate={isRate} invert={isRate} />
            {k.change_1w_pct !== null && (
              <ChangeChip label="%1w" value={k.change_1w_pct} isRate={false} invert={isRate} />
            )}
            {k.change_1m_pct !== null && (
              <ChangeChip label="%1m" value={k.change_1m_pct} isRate={false} invert={isRate} />
            )}
          </div>
        </div>
        <Sparkline points={k.spark} invert={isRate} />
      </div>
      <div className="text-2xs text-terminal-dim mt-1 flex justify-between">
        <span>
          YTD:{" "}
          <span className={ytdColor(k.change_ytd_pct, isRate)}>{formatPct(k.change_ytd_pct)}</span>
        </span>
        <span className="text-terminal-dim/70">{k.last_date ?? ""}</span>
      </div>
    </div>
  );
}

function ChangeChip({
  label,
  value,
  isRate,
  invert = false,
}: {
  label: string;
  value: number | null;
  isRate: boolean;
  invert?: boolean;
}) {
  if (value === null) {
    return (
      <span className="text-terminal-dim">
        {label} <span className="font-mono">--</span>
      </span>
    );
  }
  // For spreads (rates), a higher value = worse for risk. Invert the color sense.
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  const color = good ? "text-green-400" : bad ? "text-rose-400" : "text-terminal-dim";
  const sign = value > 0 ? "+" : "";
  const formatted = isRate
    ? `${sign}${(value * 100).toFixed(0)}bp`
    : `${sign}${value.toFixed(1)}%`;
  return (
    <span className="text-terminal-dim">
      {label} <span className={`font-mono ${color}`}>{formatted}</span>
    </span>
  );
}

function ytdColor(v: number | null, invert: boolean): string {
  if (v === null) return "text-terminal-dim";
  const good = invert ? v < 0 : v > 0;
  const bad = invert ? v > 0 : v < 0;
  if (good) return "text-green-400";
  if (bad) return "text-rose-400";
  return "text-terminal-dim";
}

function formatPct(v: number | null): string {
  if (v === null) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function formatValue(v: number | null, unit: string): string {
  if (v === null) return "--";
  const abs = Math.abs(v);
  if (unit === "%" || unit === "bp") return v.toFixed(2);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

function Sparkline({
  points,
  invert = false,
}: {
  points: { date: string; value: number }[];
  invert?: boolean;
}) {
  if (points.length < 2) {
    return <div className="w-14 h-7" />;
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 56;
  const H = 28;
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
  const rising = last >= first;
  const stroke = (rising !== invert) ? "#34d399" : "#fb7185";
  return (
    <svg width={W} height={H} className="shrink-0">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}
