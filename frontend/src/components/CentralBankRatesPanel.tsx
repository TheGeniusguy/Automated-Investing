import { useEffect, useMemo, useState } from "react";

// -- Local types (decoupled from api/types.ts on purpose) --------------------

interface RateHistoryPoint {
  date: string;
  rate: number;
}

interface CentralBank {
  bank: string;
  country: string;
  flag_emoji: string;
  currency: string;
  policy_rate: number;
  cpi_yoy: number;
  last_move_bps: number;
  last_move_date: string;
  days_since_change: number;
  real_rate: number;
  next_meeting_date: string;
  bias: string;
  rate_history: RateHistoryPoint[];
  data_mode?: string;
}

interface RealRateRef {
  bank: string;
  country: string;
  flag_emoji: string;
  real_rate: number;
  policy_rate: number;
}

interface CBSummary {
  count_total: number;
  count_hiking: number;
  count_holding: number;
  count_cutting: number;
  global_avg_rate: number;
  highest_real_rate: RealRateRef | null;
  lowest_real_rate: RealRateRef | null;
}

interface CBResponse {
  banks: CentralBank[];
  summary: CBSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Local fallback so the panel renders fully populated, even offline -------

function mkHistory(bank: string, current: number, moveBps: number): RateHistoryPoint[] {
  const n = 11;
  let seed = 0;
  for (let i = 0; i < bank.length; i++) seed = (seed * 31 + bank.charCodeAt(i)) & 0xffffff;
  const swing = Math.max(Math.abs(current) * 0.55, 1.0);
  let start = current;
  if (moveBps > 0) start = Math.max(current - swing, 0);
  else if (moveBps < 0) start = current + swing;
  const out: RateHistoryPoint[] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    let val = start + (current - start) * frac;
    const wobble = (((seed >> (i % 7)) & 0x7) - 3) * 0.04;
    if (i > 0 && i < n - 1) val += wobble;
    if (moveBps >= 0) val = Math.max(val, 0);
    const d = new Date(today.getFullYear(), today.getMonth() - (n - 1 - i) * 3, 1);
    out.push({ date: d.toISOString().slice(0, 10), rate: Number(val.toFixed(2)) });
  }
  out[n - 1].rate = Number(current.toFixed(2));
  return out;
}

function mkBank(
  bank: string,
  country: string,
  flag: string,
  currency: string,
  rate: number,
  cpi: number,
  moveBps: number,
  moveDate: string,
  nextMeeting: string,
  bias: string,
): CentralBank {
  const today = new Date();
  const md = new Date(moveDate);
  const days = Math.max(Math.round((today.getTime() - md.getTime()) / 86400000), 0);
  return {
    bank,
    country,
    flag_emoji: flag,
    currency,
    policy_rate: rate,
    cpi_yoy: cpi,
    last_move_bps: moveBps,
    last_move_date: moveDate,
    days_since_change: days,
    real_rate: Number((rate - cpi).toFixed(2)),
    next_meeting_date: nextMeeting,
    bias,
    rate_history: mkHistory(bank, rate, moveBps),
    data_mode: "sample",
  };
}

const FALLBACK_BANKS: CentralBank[] = [
  // Developed markets
  mkBank("Federal Reserve", "United States", "\u{1F1FA}\u{1F1F8}", "USD", 4.5, 2.6, -25, "2025-12-10", "2026-07-29", "Neutral"),
  mkBank("European Central Bank", "Euro Area", "\u{1F1EA}\u{1F1FA}", "EUR", 2.15, 2.1, -25, "2026-03-12", "2026-07-24", "Neutral"),
  mkBank("Bank of England", "United Kingdom", "\u{1F1EC}\u{1F1E7}", "GBP", 4.0, 3.1, -25, "2026-05-08", "2026-08-07", "Cutting"),
  mkBank("Bank of Japan", "Japan", "\u{1F1EF}\u{1F1F5}", "JPY", 0.75, 2.8, 25, "2026-01-24", "2026-07-31", "Hiking"),
  mkBank("Swiss National Bank", "Switzerland", "\u{1F1E8}\u{1F1ED}", "CHF", 0.0, 0.4, -25, "2026-03-20", "2026-09-25", "Dovish"),
  mkBank("Bank of Canada", "Canada", "\u{1F1E8}\u{1F1E6}", "CAD", 2.75, 2.3, -25, "2026-04-15", "2026-07-30", "Neutral"),
  mkBank("Reserve Bank of Australia", "Australia", "\u{1F1E6}\u{1F1FA}", "AUD", 3.6, 2.9, -25, "2026-05-20", "2026-07-08", "Cutting"),
  mkBank("Reserve Bank of New Zealand", "New Zealand", "\u{1F1F3}\u{1F1FF}", "NZD", 3.0, 2.4, -25, "2026-05-28", "2026-07-09", "Cutting"),
  mkBank("Sveriges Riksbank", "Sweden", "\u{1F1F8}\u{1F1EA}", "SEK", 1.75, 1.9, -25, "2026-01-29", "2026-08-20", "Neutral"),
  mkBank("Norges Bank", "Norway", "\u{1F1F3}\u{1F1F4}", "NOK", 4.0, 2.7, -25, "2026-03-19", "2026-08-13", "Neutral"),
  // Emerging markets
  mkBank("People's Bank of China", "China", "\u{1F1E8}\u{1F1F3}", "CNY", 2.9, 0.6, -10, "2026-04-21", "2026-07-21", "Dovish"),
  mkBank("Banco de Mexico", "Mexico", "\u{1F1F2}\u{1F1FD}", "MXN", 7.75, 3.8, -50, "2026-05-15", "2026-08-07", "Cutting"),
  mkBank("Banco Central do Brasil", "Brazil", "\u{1F1E7}\u{1F1F7}", "BRL", 14.25, 4.6, 25, "2026-03-19", "2026-07-30", "Hawkish"),
  mkBank("Reserve Bank of India", "India", "\u{1F1EE}\u{1F1F3}", "INR", 5.5, 3.2, -50, "2026-06-06", "2026-08-06", "Neutral"),
  mkBank("Central Bank of Turkey", "Turkiye", "\u{1F1F9}\u{1F1F7}", "TRY", 43.0, 33.5, -250, "2026-06-12", "2026-07-24", "Cutting"),
  mkBank("South African Reserve Bank", "South Africa", "\u{1F1FF}\u{1F1E6}", "ZAR", 7.0, 3.4, -25, "2026-05-29", "2026-07-31", "Neutral"),
];

function buildSummary(banks: CentralBank[]): CBSummary {
  const hiking = banks.filter((b) => b.last_move_bps > 0).length;
  const cutting = banks.filter((b) => b.last_move_bps < 0).length;
  const holding = banks.filter((b) => b.last_move_bps === 0).length;
  const avg = banks.length
    ? Number((banks.reduce((s, b) => s + b.policy_rate, 0) / banks.length).toFixed(2))
    : 0;
  const sorted = [...banks].sort((a, b) => b.real_rate - a.real_rate);
  const hi = sorted[0];
  const lo = sorted[sorted.length - 1];
  const ref = (b: CentralBank | undefined): RealRateRef | null =>
    b
      ? {
          bank: b.bank,
          country: b.country,
          flag_emoji: b.flag_emoji,
          real_rate: b.real_rate,
          policy_rate: b.policy_rate,
        }
      : null;
  return {
    count_total: banks.length,
    count_hiking: hiking,
    count_holding: holding,
    count_cutting: cutting,
    global_avg_rate: avg,
    highest_real_rate: ref(hi),
    lowest_real_rate: ref(lo),
  };
}

const FALLBACK: CBResponse = {
  banks: FALLBACK_BANKS,
  summary: buildSummary(FALLBACK_BANKS),
  data_mode: "sample",
  as_of: "",
  source: "curated central-bank schedule",
};

// -- Helpers -----------------------------------------------------------------

function fmtRate(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtReal(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtBps(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v} bps`;
}

function fmtDate(iso: string): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function fmtMeeting(iso: string): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function realColor(v: number): string {
  if (v > 0.25) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

function moveColor(bps: number): string {
  if (bps > 0) return "text-accent-red"; // hike = tightening = red
  if (bps < 0) return "text-accent-green"; // cut = easing = green
  return "text-terminal-muted";
}

const BIAS_STYLE: Record<string, string> = {
  Hawkish: "text-accent-red border-accent-red/40 bg-accent-red/10",
  Hiking: "text-accent-red border-accent-red/40 bg-accent-red/10",
  Neutral: "text-terminal-muted border-terminal-divider bg-white/[0.03]",
  Dovish: "text-accent-green border-accent-green/40 bg-accent-green/10",
  Cutting: "text-accent-green border-accent-green/40 bg-accent-green/10",
};

function biasPill(bias: string): string {
  return BIAS_STYLE[bias] ?? BIAS_STYLE.Neutral;
}

// Inline SVG sparkline of the policy-rate path.
function RateSpark({ data }: { data: RateHistoryPoint[] }) {
  const w = 72;
  const h = 20;
  if (!data || data.length < 2) return <svg width={w} height={h} className="block" />;
  const vals = data.map((d) => d.rate);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const points = data
    .map((d, i) => {
      const x = i * stepX;
      const y = h - 2 - ((d.rate - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? "#e5564b" : "#5bb97f"; // rates up = tightening (red), down = easing (green)
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

export function CentralBankRatesPanel() {
  const [data, setData] = useState<CBResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/central-bank-rates")
      .then((res) => res.json())
      .then((json: CBResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.banks) && json.banks.length > 0) {
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

  const { banks, summary } = data;

  const dmCount = 10;
  const dmBanks = useMemo(() => banks.slice(0, dmCount), [banks]);
  const emBanks = useMemo(() => banks.slice(dmCount), [banks]);

  const groups = useMemo(
    () =>
      [
        { label: "Developed Markets", rows: dmBanks },
        { label: "Emerging Markets", rows: emBanks },
      ].filter((g) => g.rows.length > 0),
    [dmBanks, emBanks],
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>GLOBAL CENTRAL-BANK RATES</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Global Avg Rate</div>
            <div className="stat-figure text-2xl tabular-nums text-terminal-text">
              {summary.global_avg_rate.toFixed(2)}
              <span className="text-base text-terminal-muted">%</span>
            </div>
            <div className="text-2xs text-terminal-dim">across {summary.count_total} banks</div>
          </div>

          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-1">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Policy Stance</div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="stat-figure text-xl tabular-nums text-accent-red">
                {summary.count_hiking}
              </span>
              <span className="text-terminal-dim text-2xs">hike</span>
              <span className="stat-figure text-xl tabular-nums text-terminal-muted">
                {summary.count_holding}
              </span>
              <span className="text-terminal-dim text-2xs">hold</span>
              <span className="stat-figure text-xl tabular-nums text-accent-green">
                {summary.count_cutting}
              </span>
              <span className="text-terminal-dim text-2xs">cut</span>
            </div>
          </div>

          <RealRateCard label="Highest Real Rate" item={summary.highest_real_rate} positive />
          <RealRateCard label="Lowest Real Rate" item={summary.lowest_real_rate} positive={false} />
        </div>

        {/* World board tables, grouped DM then EM */}
        {groups.map((group) => (
          <div
            key={group.label}
            className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden"
          >
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-terminal-divider">
              <span className="text-2xs text-terminal-text uppercase tracking-wider font-medium">
                {group.label}
              </span>
              <span className="text-2xs text-terminal-dim">{group.rows.length} banks</span>
            </div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider/60">
                  <th className="text-left py-1 px-2 font-medium">Bank / Country</th>
                  <th className="text-right py-1 px-2 font-medium">Policy</th>
                  <th className="text-right py-1 px-2 font-medium">Last Move</th>
                  <th className="text-right py-1 px-2 font-medium hidden sm:table-cell">Days</th>
                  <th className="text-right py-1 px-2 font-medium">Real</th>
                  <th className="text-right py-1 px-2 font-medium hidden md:table-cell">Path</th>
                  <th className="text-right py-1 px-2 font-medium hidden lg:table-cell">Next Mtg</th>
                  <th className="text-right py-1 px-2 font-medium">Bias</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((b) => (
                  <tr
                    key={b.bank}
                    className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                  >
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm leading-none">{b.flag_emoji}</span>
                        <div className="min-w-0">
                          <div className="text-terminal-text font-medium leading-tight truncate">
                            {b.bank}
                          </div>
                          <div className="text-2xs text-terminal-dim leading-tight">
                            {b.country} <span className="font-mono">{b.currency}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap font-semibold">
                      {fmtRate(b.policy_rate)}
                    </td>
                    <td className="py-1.5 px-2 text-right whitespace-nowrap">
                      <div className={`font-mono tabular-nums font-semibold ${moveColor(b.last_move_bps)}`}>
                        {fmtBps(b.last_move_bps)}
                      </div>
                      <div className="text-2xs text-terminal-dim font-mono">
                        {fmtDate(b.last_move_date)}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted hidden sm:table-cell">
                      {b.days_since_change}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap font-semibold ${realColor(
                        b.real_rate,
                      )}`}
                    >
                      {fmtReal(b.real_rate)}
                    </td>
                    <td className="py-1.5 px-2 hidden md:table-cell">
                      <div className="flex justify-end">
                        <RateSpark data={b.rate_history} />
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted hidden lg:table-cell whitespace-nowrap">
                      {fmtMeeting(b.next_meeting_date)}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <span
                        className={`pill border ${biasPill(b.bias)} text-2xs whitespace-nowrap`}
                      >
                        {b.bias}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <span className="text-accent-red">hike</span> tightening
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-accent-green">cut</span> easing
            </span>
            <span>Real rate = policy rate minus headline CPI yoy.</span>
          </div>
          <span className="text-terminal-dim">
            {summary.count_total} central banks. Path = trailing policy-rate trajectory.
          </span>
        </div>
      </div>
    </div>
  );
}

// -- Small components --------------------------------------------------------

function RealRateCard({
  label,
  item,
  positive,
}: {
  label: string;
  item: RealRateRef | null;
  positive: boolean;
}) {
  const accent = positive ? "text-accent-green" : "text-accent-red";
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-2xl tabular-nums ${item ? realColor(item.real_rate) : accent}`}>
        {item ? fmtReal(item.real_rate) : "--"}
      </div>
      <div className="text-2xs text-terminal-dim truncate flex items-center gap-1">
        {item && <span>{item.flag_emoji}</span>}
        <span className="truncate">{item ? item.country : "--"}</span>
      </div>
    </div>
  );
}
