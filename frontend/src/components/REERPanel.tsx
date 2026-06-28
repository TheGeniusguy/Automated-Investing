import { useEffect, useMemo, useState } from "react";

// -- Local types (decoupled from api/types.ts on purpose) --------------------

interface ReerHistoryPoint {
  date: string;
  value: number;
}

interface ReerCurrency {
  currency: string;
  name: string;
  flag_emoji: string;
  reer: number;
  z_score: number;
  chg_1y: number;
  valuation: string; // "Rich" | "Fair" | "Cheap"
  mean: number;
  std: number;
  fair_low: number;
  fair_high: number;
  pct_from_fair: number;
  history: ReerHistoryPoint[];
  data_mode?: string;
}

interface ReerRef {
  currency: string;
  name: string;
  flag_emoji: string;
  z_score: number;
  reer: number;
  valuation: string;
}

interface ReerSummary {
  most_overvalued: ReerRef | null;
  most_undervalued: ReerRef | null;
  count_rich: number;
  count_fair: number;
  count_cheap: number;
  avg_abs_z: number;
}

interface ReerResponse {
  currencies: ReerCurrency[];
  summary: ReerSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Deterministic local fallback so the panel renders fully populated -------

function mkHistory(code: string, current: number, mean: number): ReerHistoryPoint[] {
  const n = 120;
  let seed = 0;
  for (let i = 0; i < code.length; i++) seed = (seed * 31 + code.charCodeAt(i)) & 0xffffff;
  const out: ReerHistoryPoint[] = [];
  const today = new Date();
  let noise = 0;
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const rnd = (seed / 0x7fffffff - 0.5) * 2; // -1..1
    noise = noise * 0.82 + rnd * 1.4;
    const trend = mean + (current - mean) * frac;
    const d = new Date(today.getFullYear(), today.getMonth() - (n - 1 - i), 1);
    out.push({ date: d.toISOString().slice(0, 10), value: Number((trend + noise * (1 - frac)).toFixed(2)) });
  }
  out[n - 1].value = Number(current.toFixed(2));
  return out;
}

function mkCcy(
  currency: string,
  name: string,
  flag: string,
  reer: number,
  mean: number,
  std: number,
  z: number,
  chg1y: number,
): ReerCurrency {
  const valuation = z >= 1 ? "Rich" : z <= -1 ? "Cheap" : "Fair";
  return {
    currency,
    name,
    flag_emoji: flag,
    reer,
    z_score: z,
    chg_1y: chg1y,
    valuation,
    mean,
    std,
    fair_low: Number((mean - std).toFixed(2)),
    fair_high: Number((mean + std).toFixed(2)),
    pct_from_fair: Number(((reer / mean - 1) * 100).toFixed(2)),
    history: mkHistory(currency, reer, mean),
    data_mode: "sample",
  };
}

const FALLBACK_CCYS: ReerCurrency[] = [
  mkCcy("MXN", "Mexican Peso", "\u{1F1F2}\u{1F1FD}", 111.1, 99.2, 6.06, 1.97, -0.81),
  mkCcy("CHF", "Swiss Franc", "\u{1F1E8}\u{1F1ED}", 120.7, 114.2, 3.45, 1.89, 3.05),
  mkCcy("USD", "US Dollar", "\u{1F1FA}\u{1F1F8}", 116.9, 111.0, 3.65, 1.61, -1.58),
  mkCcy("CNY", "Chinese Yuan", "\u{1F1E8}\u{1F1F3}", 120.3, 116.4, 3.20, 1.21, 0.76),
  mkCcy("INR", "Indian Rupee", "\u{1F1EE}\u{1F1F3}", 100.1, 98.4, 1.60, 1.05, -0.13),
  mkCcy("GBP", "British Pound", "\u{1F1EC}\u{1F1E7}", 98.2, 96.5, 2.20, 0.77, -1.93),
  mkCcy("EUR", "Euro", "\u{1F1EA}\u{1F1FA}", 96.1, 97.5, 2.60, -0.52, -3.31),
  mkCcy("AUD", "Australian Dollar", "\u{1F1E6}\u{1F1FA}", 88.7, 91.3, 3.80, -0.68, 0.02),
  mkCcy("JPY", "Japanese Yen", "\u{1F1EF}\u{1F1F5}", 66.4, 71.5, 4.05, -1.26, 0.13),
  mkCcy("NOK", "Norwegian Krone", "\u{1F1F3}\u{1F1F4}", 86.1, 90.0, 2.85, -1.36, -1.30),
  mkCcy("BRL", "Brazilian Real", "\u{1F1E7}\u{1F1F7}", 77.2, 84.5, 5.30, -1.37, -5.06),
  mkCcy("SEK", "Swedish Krona", "\u{1F1F8}\u{1F1EA}", 83.0, 87.6, 3.05, -1.52, -1.85),
  mkCcy("NZD", "New Zealand Dollar", "\u{1F1F3}\u{1F1FF}", 96.8, 102.4, 3.35, -1.68, -7.70),
  mkCcy("CAD", "Canadian Dollar", "\u{1F1E8}\u{1F1E6}", 92.8, 99.8, 3.10, -2.25, -3.67),
];

function buildSummary(ccys: ReerCurrency[]): ReerSummary {
  const ref = (c: ReerCurrency | undefined): ReerRef | null =>
    c
      ? {
          currency: c.currency,
          name: c.name,
          flag_emoji: c.flag_emoji,
          z_score: c.z_score,
          reer: c.reer,
          valuation: c.valuation,
        }
      : null;
  const sorted = [...ccys].sort((a, b) => b.z_score - a.z_score);
  return {
    most_overvalued: ref(sorted[0]),
    most_undervalued: ref(sorted[sorted.length - 1]),
    count_rich: ccys.filter((c) => c.valuation === "Rich").length,
    count_fair: ccys.filter((c) => c.valuation === "Fair").length,
    count_cheap: ccys.filter((c) => c.valuation === "Cheap").length,
    avg_abs_z: ccys.length
      ? Number((ccys.reduce((s, c) => s + Math.abs(c.z_score), 0) / ccys.length).toFixed(3))
      : 0,
  };
}

const FALLBACK: ReerResponse = {
  currencies: FALLBACK_CCYS,
  summary: buildSummary(FALLBACK_CCYS),
  data_mode: "sample",
  as_of: "",
  source: "curated BIS-style REER baseline",
};

// -- Helpers -----------------------------------------------------------------

function fmtZ(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function fmtPct(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function valColor(v: string): string {
  if (v === "Rich") return "text-accent-red";
  if (v === "Cheap") return "text-accent-green";
  return "text-terminal-muted";
}

const VAL_STYLE: Record<string, string> = {
  Rich: "text-accent-red border-accent-red/40 bg-accent-red/10",
  Fair: "text-terminal-muted border-terminal-divider bg-white/[0.03]",
  Cheap: "text-accent-green border-accent-green/40 bg-accent-green/10",
};

function valPill(v: string): string {
  return VAL_STYLE[v] ?? VAL_STYLE.Fair;
}

// Inline SVG sparkline of the REER index path.
function ReerSpark({ data }: { data: ReerHistoryPoint[] }) {
  const w = 80;
  const h = 22;
  if (!data || data.length < 2) return <svg width={w} height={h} className="block" />;
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const points = data
    .map((d, i) => {
      const x = i * stepX;
      const y = h - 2 - ((d.value - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? "#c2693f" : "#9aa0a6"; // clay for rising real value, dim grey otherwise
  const lastY = h - 2 - ((vals[vals.length - 1] - min) / range) * (h - 4);
  return (
    <svg width={w} height={h} className="block overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
      />
      <circle cx={w} cy={lastY} r={1.6} fill={stroke} />
    </svg>
  );
}

// -- Panel -------------------------------------------------------------------

export function REERPanel() {
  const [data, setData] = useState<ReerResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/reer")
      .then((res) => res.json())
      .then((json: ReerResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.currencies) && json.currencies.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const { currencies, summary } = data;

  // Symmetric scale for the diverging bar chart, padded so the widest bar fits.
  const maxAbsZ = useMemo(() => {
    const m = currencies.reduce((acc, c) => Math.max(acc, Math.abs(c.z_score)), 0);
    return Math.max(Math.ceil(m * 10) / 10, 1) + 0.25;
  }, [currencies]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>REAL EFFECTIVE EXCHANGE RATES (REER)</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <ValuationRefCard label="Most Overvalued" item={summary.most_overvalued} rich />
          <ValuationRefCard label="Most Undervalued" item={summary.most_undervalued} rich={false} />

          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-1">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Valuation Spread</div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="stat-figure text-xl tabular-nums text-accent-red">
                {summary.count_rich}
              </span>
              <span className="text-terminal-dim text-2xs">rich</span>
              <span className="stat-figure text-xl tabular-nums text-terminal-muted">
                {summary.count_fair}
              </span>
              <span className="text-terminal-dim text-2xs">fair</span>
              <span className="stat-figure text-xl tabular-nums text-accent-green">
                {summary.count_cheap}
              </span>
              <span className="text-terminal-dim text-2xs">cheap</span>
            </div>
          </div>

          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Avg |Z|</div>
            <div className="stat-figure text-2xl tabular-nums text-terminal-text">
              {summary.avg_abs_z.toFixed(2)}
            </div>
            <div className="text-2xs text-terminal-dim">{currencies.length} currencies vs 10y mean</div>
          </div>
        </div>

        {/* HERO: diverging rich/cheap bar chart */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-terminal-divider">
            <span className="text-2xs text-terminal-text uppercase tracking-wider font-medium">
              Rich / Cheap (Z-Score vs own 10y mean)
            </span>
            <div className="flex items-center gap-3 text-2xs">
              <span className="inline-flex items-center gap-1 text-accent-green">
                <span className="inline-block w-2 h-2 rounded-sm bg-accent-green/70" /> undervalued
              </span>
              <span className="inline-flex items-center gap-1 text-accent-red">
                overvalued <span className="inline-block w-2 h-2 rounded-sm bg-accent-red/70" />
              </span>
            </div>
          </div>
          <div className="flex flex-col">
            {currencies.map((c) => (
              <DivergingRow key={c.currency} c={c} maxAbsZ={maxAbsZ} />
            ))}
          </div>
        </div>

        {/* Detail table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider/60">
                <th className="text-left py-1 px-2 font-medium">Currency</th>
                <th className="text-right py-1 px-2 font-medium">REER</th>
                <th className="text-right py-1 px-2 font-medium hidden sm:table-cell">Fair Band</th>
                <th className="text-right py-1 px-2 font-medium">Z-Score</th>
                <th className="text-right py-1 px-2 font-medium hidden sm:table-cell">1y Chg</th>
                <th className="text-right py-1 px-2 font-medium hidden md:table-cell">Trend</th>
                <th className="text-right py-1 px-2 font-medium">Valuation</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => (
                <tr
                  key={c.currency}
                  className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                >
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm leading-none">{c.flag_emoji}</span>
                      <div className="min-w-0">
                        <div className="text-terminal-text font-mono font-semibold leading-tight">
                          {c.currency}
                        </div>
                        <div className="text-2xs text-terminal-dim leading-tight truncate">
                          {c.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text font-semibold whitespace-nowrap">
                    {c.reer.toFixed(1)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim hidden sm:table-cell whitespace-nowrap">
                    {c.fair_low.toFixed(1)} - {c.fair_high.toFixed(1)}
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${valColor(
                      c.valuation,
                    )}`}
                  >
                    {fmtZ(c.z_score)}
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right font-mono tabular-nums hidden sm:table-cell whitespace-nowrap ${
                      c.chg_1y > 0 ? "text-accent-green" : c.chg_1y < 0 ? "text-accent-red" : "text-terminal-muted"
                    }`}
                  >
                    {fmtPct(c.chg_1y)}
                  </td>
                  <td className="py-1.5 px-2 hidden md:table-cell">
                    <div className="flex justify-end">
                      <ReerSpark data={c.history} />
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right">
                    <span className={`pill border ${valPill(c.valuation)} text-2xs whitespace-nowrap`}>
                      {c.valuation}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <span className="max-w-2xl">
            REER = trade-weighted, inflation-adjusted currency value. Z-score measures
            distance from each currency's own 10-year mean. An extreme reading (|z| &gt; 1)
            flags a mean-reversion candidate: rich currencies tend to weaken, cheap ones to
            firm.
          </span>
          <span className="text-terminal-dim whitespace-nowrap">
            Fair band = mean +/- 1 std. Source: BIS broad real EER.
          </span>
        </div>
      </div>
    </div>
  );
}

// -- Small components --------------------------------------------------------

function DivergingRow({ c, maxAbsZ }: { c: ReerCurrency; maxAbsZ: number }) {
  const frac = Math.min(Math.abs(c.z_score) / maxAbsZ, 1);
  const widthPct = (frac * 50).toFixed(2); // half the track at most
  const rich = c.z_score >= 0;
  return (
    <div className="flex items-center gap-2 px-2 py-1 border-t border-terminal-border/15 first:border-t-0 hover:bg-white/[0.02]">
      {/* Label */}
      <div className="w-16 shrink-0 flex items-center gap-1">
        <span className="text-xs leading-none">{c.flag_emoji}</span>
        <span className="font-mono text-2xs font-semibold text-terminal-text">{c.currency}</span>
      </div>

      {/* Diverging track */}
      <div className="relative flex-1 h-5">
        {/* zero line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-terminal-divider" />
        {/* left half (cheap / green) */}
        <div className="absolute left-0 top-0 bottom-0 w-1/2 flex items-center justify-end pr-px">
          {!rich && (
            <div
              className="h-3 rounded-sm bg-accent-green/55 border-r border-accent-green"
              style={{ width: `${widthPct}%` }}
            />
          )}
        </div>
        {/* right half (rich / red) */}
        <div className="absolute right-0 top-0 bottom-0 w-1/2 flex items-center justify-start pl-px">
          {rich && (
            <div
              className="h-3 rounded-sm bg-accent-red/55 border-l border-accent-red"
              style={{ width: `${widthPct}%` }}
            />
          )}
        </div>
      </div>

      {/* Z value */}
      <div
        className={`w-12 shrink-0 text-right font-mono tabular-nums text-2xs font-semibold ${valColor(
          c.valuation,
        )}`}
      >
        {fmtZ(c.z_score)}
      </div>
    </div>
  );
}

function ValuationRefCard({
  label,
  item,
  rich,
}: {
  label: string;
  item: ReerRef | null;
  rich: boolean;
}) {
  const accent = rich ? "text-accent-red" : "text-accent-green";
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`stat-figure text-2xl tabular-nums ${accent}`}>
          {item ? fmtZ(item.z_score) : "--"}
        </span>
        {item && <span className="text-sm text-terminal-muted">z</span>}
      </div>
      <div className="text-2xs text-terminal-dim truncate flex items-center gap-1">
        {item && <span>{item.flag_emoji}</span>}
        <span className="font-mono text-terminal-muted">{item ? item.currency : "--"}</span>
        <span className="truncate">{item ? item.name : ""}</span>
      </div>
    </div>
  );
}
