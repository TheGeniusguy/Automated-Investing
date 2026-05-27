import type { SectorOperationalKpi, SectorOperationalResponse } from "../api/types";

interface Props {
  data: SectorOperationalResponse | null;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Sector Operational KPIs — the per-sector "factory dashboard."
 *
 * Renders one collapsible section per bucket (Prices, Inventories, Yield Curve,
 * Mortgage Market, etc.) with KPI tiles showing last value, 1d/1w/1m change,
 * and an inline SVG sparkline. Derived KPIs (e.g. 3-2-1 crack spread,
 * 30Y mortg - 10Y spread) render as a separate row at the bottom.
 */
export function SectorOperationalPanel({ data, expanded, onToggle }: Props) {
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
          Operational Dashboard
          {data && (
            <span className="ml-2 text-terminal-dim normal-case font-normal">
              factory-floor KPIs · {countTiles(data)} indicators
              {fredMissing && " · FRED key needed for full view"}
            </span>
          )}
        </span>
        <span className="text-terminal-dim">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!data ? (
            <div className="text-terminal-dim text-xs py-2">Loading operational KPIs...</div>
          ) : !hasData && data.reason ? (
            <div className="text-terminal-dim text-xs py-2 italic">{data.reason}</div>
          ) : (
            <>
              {data.buckets.map((bucket) => (
                <BucketBlock key={bucket.label} label={bucket.label} kpis={bucket.kpis} />
              ))}
              {data.derived.length > 0 && (
                <BucketBlock label="Derived" kpis={data.derived} accent />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function countTiles(d: SectorOperationalResponse): number {
  return d.buckets.reduce((acc, b) => acc + b.kpis.length, 0) + d.derived.length;
}

function BucketBlock({
  label,
  kpis,
  accent = false,
}: {
  label: string;
  kpis: SectorOperationalKpi[];
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
          <KpiTile key={`${label}-${k.id}`} k={k} />
        ))}
      </div>
    </div>
  );
}

function KpiTile({ k }: { k: SectorOperationalKpi }) {
  const isRate = k.unit === "%" || k.unit === "bp";
  // For rates, show absolute bp change. For everything else, show pct.
  const primary = isRate ? k.change_1d_abs : k.change_1d_pct;
  const primaryLabel = isRate ? "Δ1d" : "%1d";

  if (!k.available) {
    return (
      <div className="border border-terminal-border/40 rounded px-2 py-1.5 bg-terminal-panel/30">
        <div className="flex items-baseline justify-between gap-1">
          <span className="text-terminal-muted text-xs font-semibold truncate" title={k.label}>
            {k.label}
          </span>
          <span className="text-terminal-dim text-2xs font-mono">{k.id}</span>
        </div>
        <div className="text-terminal-dim text-2xs mt-1 italic">
          {k.reason ?? "Unavailable"}
        </div>
      </div>
    );
  }

  return (
    <div
      className="border border-terminal-border/50 rounded px-2 py-1.5 bg-terminal-panel/40 hover:border-terminal-border transition-colors"
      title={k.desc}
    >
      <div className="flex items-baseline justify-between gap-1 mb-0.5">
        <span className="text-terminal-muted text-xs font-semibold truncate" title={k.label}>
          {k.label}
        </span>
        <span className="text-terminal-dim text-2xs font-mono shrink-0">{k.id}</span>
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-base font-mono tabular-nums leading-tight">
            {formatValue(k.last_value, k.unit)}
          </div>
          <div className="text-2xs text-terminal-dim mt-0.5 flex gap-1.5">
            <ChangeChip label={primaryLabel} value={primary} isRate={isRate} />
            {k.change_1w_pct !== null && (
              <ChangeChip label="%1w" value={k.change_1w_pct} isRate={false} />
            )}
            {k.change_1m_pct !== null && (
              <ChangeChip label="%1m" value={k.change_1m_pct} isRate={false} />
            )}
          </div>
        </div>
        <Sparkline points={k.spark} />
      </div>

      <div className="text-2xs text-terminal-dim mt-1 flex justify-between">
        <span>YTD: <span className={ytdColor(k.change_ytd_pct)}>{formatPct(k.change_ytd_pct)}</span></span>
        <span className="text-terminal-dim/70">{k.last_date ?? ""}</span>
      </div>
    </div>
  );
}

function ChangeChip({
  label,
  value,
  isRate,
}: {
  label: string;
  value: number | null;
  isRate: boolean;
}) {
  if (value === null) {
    return (
      <span className="text-terminal-dim">
        {label} <span className="font-mono">--</span>
      </span>
    );
  }
  const color =
    value > 0 ? "text-green-400" : value < 0 ? "text-rose-400" : "text-terminal-dim";
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

function ytdColor(v: number | null): string {
  if (v === null) return "text-terminal-dim";
  if (v > 0) return "text-green-400";
  if (v < 0) return "text-rose-400";
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
  // Large numbers (inventory in thousands, payrolls in thousands) get a thousands separator.
  if (abs >= 1000) {
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (unit === "%" || unit === "bp") {
    return v.toFixed(2);
  }
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

function Sparkline({ points }: { points: { date: string; value: number }[] }) {
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
  const stroke = last >= first ? "#34d399" : "#fb7185";
  return (
    <svg width={W} height={H} className="shrink-0">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}
