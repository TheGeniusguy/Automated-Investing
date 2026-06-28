import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface DividendEvent {
  symbol: string;
  name: string;
  ex_date: string;
  pay_date: string;
  amount: number;
  frequency: string;
  forward_yield: number;
  payout_ratio: number;
  growth_streak_years: number;
  five_yr_cagr: number;
}

interface Buyback {
  symbol: string;
  name: string;
  amount_b: number;
  pct_of_mktcap: number;
  announced_date: string;
  note: string;
}

interface ShareholderYield {
  symbol: string;
  name: string;
  div_yield: number;
  buyback_yield: number;
  total_yield: number;
}

interface NextExDate {
  symbol: string;
  name: string;
  ex_date: string;
  amount: number;
  forward_yield: number;
}

interface DividendSummary {
  aristocrats_count: number;
  avg_forward_yield: number;
  total_buyback_authorizations_b: number;
  buyback_count: number;
  calendar_count: number;
  next_ex_date: NextExDate | null;
}

interface DividendResponse {
  calendar: DividendEvent[];
  buybacks: Buyback[];
  shareholder_yield: ShareholderYield[];
  summary: DividendSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline

const FALLBACK: DividendResponse = {
  calendar: [
    { symbol: "JPM", name: "JPMorgan Chase & Co.", ex_date: "2026-06-29", pay_date: "2026-07-24", amount: 1.4, frequency: "Quarterly", forward_yield: 2.06, payout_ratio: 27.3, growth_streak_years: 14, five_yr_cagr: 10.4 },
    { symbol: "MCD", name: "McDonald's Corp.", ex_date: "2026-06-18", pay_date: "2026-07-14", amount: 1.77, frequency: "Quarterly", forward_yield: 2.42, payout_ratio: 57.4, growth_streak_years: 49, five_yr_cagr: 8.1 },
    { symbol: "O", name: "Realty Income Corp.", ex_date: "2026-07-01", pay_date: "2026-07-15", amount: 0.2685, frequency: "Monthly", forward_yield: 5.62, payout_ratio: 75.4, growth_streak_years: 30, five_yr_cagr: 3.6 },
    { symbol: "KO", name: "Coca-Cola Co.", ex_date: "2026-07-06", pay_date: "2026-08-03", amount: 0.485, frequency: "Quarterly", forward_yield: 3.05, payout_ratio: 68.4, growth_streak_years: 62, five_yr_cagr: 4.1 },
    { symbol: "JNJ", name: "Johnson & Johnson", ex_date: "2026-07-09", pay_date: "2026-08-05", amount: 1.24, frequency: "Quarterly", forward_yield: 3.12, payout_ratio: 56.7, growth_streak_years: 62, five_yr_cagr: 5.5 },
    { symbol: "ABBV", name: "AbbVie Inc.", ex_date: "2026-07-14", pay_date: "2026-08-10", amount: 1.64, frequency: "Quarterly", forward_yield: 3.58, payout_ratio: 51.9, growth_streak_years: 53, five_yr_cagr: 7.3 },
    { symbol: "PG", name: "Procter & Gamble Co.", ex_date: "2026-07-17", pay_date: "2026-08-14", amount: 1.0065, frequency: "Quarterly", forward_yield: 2.41, payout_ratio: 59.8, growth_streak_years: 68, five_yr_cagr: 5.9 },
    { symbol: "MO", name: "Altria Group Inc.", ex_date: "2026-07-22", pay_date: "2026-08-18", amount: 1.02, frequency: "Quarterly", forward_yield: 7.84, payout_ratio: 79.1, growth_streak_years: 55, five_yr_cagr: 4.4 },
  ],
  buybacks: [
    { symbol: "AAPL", name: "Apple Inc.", amount_b: 110.0, pct_of_mktcap: 3.2, announced_date: "2026-05-02", note: "Largest single authorization on record." },
    { symbol: "GOOGL", name: "Alphabet Inc.", amount_b: 70.0, pct_of_mktcap: 3.4, announced_date: "2026-04-24", note: "First buyback raise alongside maiden dividend." },
    { symbol: "MSFT", name: "Microsoft Corp.", amount_b: 60.0, pct_of_mktcap: 1.9, announced_date: "2026-03-18", note: "Renews prior $60B program." },
    { symbol: "META", name: "Meta Platforms Inc.", amount_b: 50.0, pct_of_mktcap: 3.6, announced_date: "2026-04-30", note: "Adds to existing repurchase program." },
    { symbol: "NVDA", name: "NVIDIA Corp.", amount_b: 50.0, pct_of_mktcap: 1.6, announced_date: "2026-06-04", note: "Board adds to remaining capacity." },
    { symbol: "JPM", name: "JPMorgan Chase & Co.", amount_b: 30.0, pct_of_mktcap: 5.1, announced_date: "2026-05-14", note: "Post-CCAR capital return expansion." },
  ],
  shareholder_yield: [
    { symbol: "WFC", name: "Wells Fargo & Co.", div_yield: 2.28, buyback_yield: 9.1, total_yield: 11.38 },
    { symbol: "AIG", name: "American International Group", div_yield: 1.94, buyback_yield: 7.9, total_yield: 9.84 },
    { symbol: "HPQ", name: "HP Inc.", div_yield: 3.41, buyback_yield: 6.4, total_yield: 9.81 },
    { symbol: "MO", name: "Altria Group Inc.", div_yield: 7.84, buyback_yield: 1.9, total_yield: 9.74 },
    { symbol: "MET", name: "MetLife Inc.", div_yield: 2.86, buyback_yield: 6.8, total_yield: 9.66 },
    { symbol: "CVX", name: "Chevron Corp.", div_yield: 4.55, buyback_yield: 4.9, total_yield: 9.45 },
    { symbol: "BAC", name: "Bank of America Corp.", div_yield: 2.41, buyback_yield: 5.7, total_yield: 8.11 },
    { symbol: "XOM", name: "Exxon Mobil Corp.", div_yield: 3.42, buyback_yield: 4.2, total_yield: 7.62 },
  ],
  summary: {
    aristocrats_count: 16,
    avg_forward_yield: 3.31,
    total_buyback_authorizations_b: 531.0,
    buyback_count: 6,
    calendar_count: 8,
    next_ex_date: { symbol: "JPM", name: "JPMorgan Chase & Co.", ex_date: "2026-06-29", amount: 1.4, forward_yield: 2.06 },
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Helpers

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso: string): string {
  if (!iso) return "--";
  const [, m, d] = iso.split("-");
  const mi = parseInt(m, 10) - 1;
  if (Number.isNaN(mi) || mi < 0 || mi > 11) return iso;
  return `${MONTHS[mi]} ${parseInt(d, 10)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtAmount(v: number): string {
  if (v == null) return "--";
  return `$${v.toFixed(2)}`;
}

function fmtB(v: number): string {
  if (v == null) return "--";
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}T`;
  return `$${v.toFixed(1)}B`;
}

function daysUntil(iso: string): number {
  if (!iso) return 9999;
  const target = new Date(iso + "T00:00:00Z").getTime();
  const now = Date.now();
  return Math.round((target - now) / 86400000);
}

// Panel

export function DividendTrackerPanel() {
  const [data, setData] = useState<DividendResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/dividends-tracker")
      .then((res) => res.json())
      .then((json: DividendResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.calendar) && json.calendar.length > 0) {
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

  const { calendar, buybacks, shareholder_yield, summary } = data;

  const maxBuyback = useMemo(
    () => Math.max(1, ...buybacks.map((b) => b.amount_b)),
    [buybacks],
  );
  const maxTotalYield = useMemo(
    () => Math.max(1, ...shareholder_yield.map((s) => s.total_yield)),
    [shareholder_yield],
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Dividend &amp; Buyback Tracker</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi label="Dividend Aristocrats" value={String(summary.aristocrats_count)} sub="Streak 25y+" accent="text-accent-amber" />
          <Kpi label="Avg Forward Yield" value={fmtPct(summary.avg_forward_yield)} sub="Tracked set" accent="text-accent-green" />
          <Kpi label="Buyback Authorizations" value={fmtB(summary.total_buyback_authorizations_b)} sub={`${summary.buyback_count} programs`} accent="text-accent-blue" />
          <Kpi
            label="Next Ex-Date"
            value={summary.next_ex_date ? fmtDate(summary.next_ex_date.ex_date) : "--"}
            sub={summary.next_ex_date ? `${summary.next_ex_date.symbol} ${fmtAmount(summary.next_ex_date.amount)}` : undefined}
            accent="text-terminal-text"
          />
        </div>

        {/* Dividend calendar */}
        <div>
          <SectionLabel>Dividend Calendar</SectionLabel>
          <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                  <th className="text-left py-1.5 px-2 font-medium">Symbol</th>
                  <th className="text-left py-1.5 px-2 font-medium">Name</th>
                  <th className="text-right py-1.5 px-2 font-medium">Ex-Date</th>
                  <th className="text-right py-1.5 px-2 font-medium">Pay-Date</th>
                  <th className="text-right py-1.5 px-2 font-medium">Amount</th>
                  <th className="text-right py-1.5 px-2 font-medium">Yield</th>
                  <th className="text-right py-1.5 px-2 font-medium">Payout</th>
                  <th className="text-right py-1.5 px-2 font-medium">Streak</th>
                </tr>
              </thead>
              <tbody>
                {calendar.map((r, i) => {
                  const dleft = daysUntil(r.ex_date);
                  const nearTerm = dleft >= 0 && dleft <= 7;
                  return (
                    <tr
                      key={`${r.symbol}-${i}`}
                      className={`border-t border-terminal-border/20 hover:bg-white/[0.02] ${nearTerm ? "bg-accent-amber/[0.06]" : ""}`}
                      title={`${r.frequency} | 5Y CAGR ${fmtPct(r.five_yr_cagr)}`}
                    >
                      <td className="py-1.5 px-2 font-mono text-terminal-text">
                        {r.symbol}
                        {nearTerm && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-amber align-middle" />}
                      </td>
                      <td className="py-1.5 px-2 text-terminal-muted truncate max-w-[10rem]">{r.name}</td>
                      <td className={`py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap ${nearTerm ? "text-accent-amber" : "text-terminal-text"}`}>
                        {fmtDate(r.ex_date)}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">{fmtDate(r.pay_date)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">{fmtAmount(r.amount)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-green">{fmtPct(r.forward_yield)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted">{r.payout_ratio.toFixed(0)}%</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
                        {r.growth_streak_years >= 25 ? (
                          <span className="text-accent-amber">{r.growth_streak_years}y</span>
                        ) : (
                          `${r.growth_streak_years}y`
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Two-column lower section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Buyback announcements */}
          <div>
            <SectionLabel>Buyback Announcements</SectionLabel>
            <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                    <th className="text-left py-1.5 px-2 font-medium">Symbol</th>
                    <th className="text-right py-1.5 px-2 font-medium">$B Auth</th>
                    <th className="text-left py-1.5 px-2 font-medium w-[40%]">% MktCap</th>
                    <th className="text-right py-1.5 px-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {buybacks.map((b, i) => (
                    <tr
                      key={`${b.symbol}-${i}`}
                      className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                      title={`${b.name} - ${b.note}`}
                    >
                      <td className="py-1.5 px-2 font-mono text-terminal-text">{b.symbol}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-blue">{fmtB(b.amount_b)}</td>
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-1.5">
                          <div className="flex-1 h-2.5 bg-terminal-panel rounded-sm overflow-hidden">
                            <div className="h-full bg-accent-blue/60 rounded-sm" style={{ width: `${(b.amount_b / maxBuyback) * 100}%` }} />
                          </div>
                          <span className="text-2xs font-mono tabular-nums text-terminal-dim w-9 text-right">{b.pct_of_mktcap.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">{fmtDate(b.announced_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Shareholder yield ranking */}
          <div>
            <SectionLabel>Shareholder Yield Ranking</SectionLabel>
            <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                    <th className="text-left py-1.5 px-2 font-medium">Symbol</th>
                    <th className="text-right py-1.5 px-2 font-medium">Div</th>
                    <th className="text-right py-1.5 px-2 font-medium">Buyback</th>
                    <th className="text-left py-1.5 px-2 font-medium w-[42%]">Total Yield</th>
                  </tr>
                </thead>
                <tbody>
                  {shareholder_yield.map((s, i) => (
                    <tr
                      key={`${s.symbol}-${i}`}
                      className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                      title={s.name}
                    >
                      <td className="py-1.5 px-2 font-mono text-terminal-text">{s.symbol}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-green">{fmtPct(s.div_yield)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-blue">{fmtPct(s.buyback_yield)}</td>
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-1.5">
                          <div className="flex-1 h-2.5 bg-terminal-panel rounded-sm overflow-hidden flex">
                            <div className="h-full bg-accent-green/70" style={{ width: `${(s.div_yield / maxTotalYield) * 100}%` }} />
                            <div className="h-full bg-accent-blue/60" style={{ width: `${(s.buyback_yield / maxTotalYield) * 100}%` }} />
                          </div>
                          <span className="text-2xs font-mono tabular-nums text-accent-green w-12 text-right">{fmtPct(s.total_yield)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <LegendDot cls="bg-accent-green" label="Dividend yield" />
            <LegendDot cls="bg-accent-blue" label="Buyback yield" />
            <LegendDot cls="bg-accent-amber" label="Ex-date within 7 days / aristocrat" />
          </div>
          <span className="text-terminal-dim">Illustrative market-wide shareholder-yield feed.</span>
        </div>
      </div>
    </div>
  );
}

// Small components

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-xl tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-2xs text-terminal-dim truncate" title={sub}>{sub}</div>}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1.5">{children}</div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-2 h-2 rounded-sm inline-block ${cls}`} />
      {label}
    </span>
  );
}
