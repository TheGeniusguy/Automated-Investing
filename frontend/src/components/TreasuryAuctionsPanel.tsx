import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose).

interface Auction {
  security_type: string;
  term: string | null;
  original_term?: string | null;
  auction_date: string;
  issue_date: string | null;
  maturity_date: string | null;
  high_rate: number | null;
  bid_to_cover: number | null;
  offering_amt_b: number | null;
  accepted_amt_b: number | null;
  coupon: number | null;
}

interface AuctionSummary {
  latest_2y_stop: number | null;
  latest_10y_stop: number | null;
  latest_30y_stop: number | null;
  avg_bid_to_cover: number | null;
  count_by_type: Record<string, number>;
  recent_count: number;
}

interface AuctionResponse {
  recent: Auction[];
  upcoming: Auction[];
  summary: AuctionSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated even before/without the backend.

const FALLBACK: AuctionResponse = {
  recent: [
    { security_type: "Note", term: "9-Year 11-Month", original_term: "10-Year", auction_date: "2026-06-25", issue_date: "2026-06-30", maturity_date: "2036-05-15", high_rate: 4.271, bid_to_cover: 2.58, offering_amt_b: 39.0, accepted_amt_b: 39.0, coupon: 4.25 },
    { security_type: "Note", term: "7-Year", original_term: "7-Year", auction_date: "2026-06-24", issue_date: "2026-06-30", maturity_date: "2033-06-30", high_rate: 4.066, bid_to_cover: 2.61, offering_amt_b: 44.0, accepted_amt_b: 44.0, coupon: 4.0 },
    { security_type: "Note", term: "5-Year", original_term: "5-Year", auction_date: "2026-06-23", issue_date: "2026-06-30", maturity_date: "2031-06-30", high_rate: 3.918, bid_to_cover: 2.43, offering_amt_b: 70.0, accepted_amt_b: 70.0, coupon: 3.875 },
    { security_type: "Note", term: "2-Year", original_term: "2-Year", auction_date: "2026-06-23", issue_date: "2026-06-30", maturity_date: "2028-06-30", high_rate: 3.842, bid_to_cover: 2.71, offering_amt_b: 69.0, accepted_amt_b: 69.0, coupon: 3.75 },
    { security_type: "Bond", term: "29-Year 11-Month", original_term: "30-Year", auction_date: "2026-06-12", issue_date: "2026-06-16", maturity_date: "2056-05-15", high_rate: 4.49, bid_to_cover: 2.36, offering_amt_b: 22.0, accepted_amt_b: 22.0, coupon: 4.5 },
    { security_type: "Bond", term: "19-Year 11-Month", original_term: "20-Year", auction_date: "2026-06-11", issue_date: "2026-06-16", maturity_date: "2046-05-15", high_rate: 4.682, bid_to_cover: 2.58, offering_amt_b: 16.0, accepted_amt_b: 16.0, coupon: 4.625 },
    { security_type: "Bill", term: "26-Week", original_term: "26-Week", auction_date: "2026-06-23", issue_date: "2026-06-26", maturity_date: "2026-12-24", high_rate: 4.16, bid_to_cover: 2.88, offering_amt_b: 72.0, accepted_amt_b: 72.0, coupon: null },
    { security_type: "Bill", term: "13-Week", original_term: "13-Week", auction_date: "2026-06-23", issue_date: "2026-06-26", maturity_date: "2026-09-25", high_rate: 4.27, bid_to_cover: 2.79, offering_amt_b: 81.0, accepted_amt_b: 81.0, coupon: null },
    { security_type: "TIPS", term: "9-Year 10-Month", original_term: "10-Year", auction_date: "2026-06-18", issue_date: "2026-06-30", maturity_date: "2036-04-15", high_rate: 2.041, bid_to_cover: 2.49, offering_amt_b: 18.0, accepted_amt_b: 18.0, coupon: 2.0 },
    { security_type: "FRN", term: "2-Year", original_term: "2-Year", auction_date: "2026-06-24", issue_date: "2026-06-27", maturity_date: "2028-06-30", high_rate: 4.29, bid_to_cover: 3.05, offering_amt_b: 28.0, accepted_amt_b: 28.0, coupon: null },
    { security_type: "Bill", term: "4-Week", original_term: "4-Week", auction_date: "2026-06-26", issue_date: "2026-06-30", maturity_date: "2026-07-28", high_rate: 4.31, bid_to_cover: 2.94, offering_amt_b: 80.0, accepted_amt_b: 80.0, coupon: null },
    { security_type: "Bill", term: "52-Week", original_term: "52-Week", auction_date: "2026-06-10", issue_date: "2026-06-12", maturity_date: "2027-06-10", high_rate: 3.98, bid_to_cover: 3.11, offering_amt_b: 46.0, accepted_amt_b: 46.0, coupon: null },
  ],
  upcoming: [
    { security_type: "Bill", term: "13-Week", original_term: "13-Week", auction_date: "2026-06-30", issue_date: "2026-07-02", maturity_date: "2026-10-01", high_rate: null, bid_to_cover: null, offering_amt_b: 81.0, accepted_amt_b: null, coupon: null },
    { security_type: "Bill", term: "26-Week", original_term: "26-Week", auction_date: "2026-06-30", issue_date: "2026-07-02", maturity_date: "2026-12-31", high_rate: null, bid_to_cover: null, offering_amt_b: 72.0, accepted_amt_b: null, coupon: null },
    { security_type: "Note", term: "2-Year", original_term: "2-Year", auction_date: "2026-07-01", issue_date: "2026-07-08", maturity_date: "2028-07-08", high_rate: null, bid_to_cover: null, offering_amt_b: 69.0, accepted_amt_b: null, coupon: null },
    { security_type: "Note", term: "5-Year", original_term: "5-Year", auction_date: "2026-07-02", issue_date: "2026-07-08", maturity_date: "2031-07-08", high_rate: null, bid_to_cover: null, offering_amt_b: 70.0, accepted_amt_b: null, coupon: null },
    { security_type: "Bond", term: "30-Year", original_term: "30-Year", auction_date: "2026-07-08", issue_date: "2026-07-15", maturity_date: "2056-07-15", high_rate: null, bid_to_cover: null, offering_amt_b: 22.0, accepted_amt_b: null, coupon: null },
    { security_type: "TIPS", term: "10-Year", original_term: "10-Year", auction_date: "2026-07-09", issue_date: "2026-07-15", maturity_date: "2036-07-15", high_rate: null, bid_to_cover: null, offering_amt_b: 18.0, accepted_amt_b: null, coupon: null },
  ],
  summary: {
    latest_2y_stop: 3.842,
    latest_10y_stop: 4.271,
    latest_30y_stop: 4.49,
    avg_bid_to_cover: 2.71,
    count_by_type: { Bill: 4, Note: 5, Bond: 2, TIPS: 1, FRN: 1 },
    recent_count: 12,
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// Helpers.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const TYPE_ACCENT: Record<string, string> = {
  Bill: "text-accent-blue",
  Note: "text-accent-green",
  Bond: "text-accent-amber",
  TIPS: "text-accent",
  FRN: "text-terminal-muted",
};

const TYPE_DOT: Record<string, string> = {
  Bill: "bg-accent-blue",
  Note: "bg-accent-green",
  Bond: "bg-accent-amber",
  TIPS: "bg-accent",
  FRN: "bg-terminal-muted",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "--";
  const [y, m, d] = iso.split("-");
  const mi = parseInt(m, 10) - 1;
  if (Number.isNaN(mi) || mi < 0 || mi > 11) return iso;
  return `${MONTHS[mi]} ${parseInt(d, 10)} '${y.slice(2)}`;
}

function fmtRate(v: number | null): string {
  if (v == null) return "--";
  return `${v.toFixed(3)}%`;
}

function fmtBtc(v: number | null): string {
  if (v == null) return "--";
  return `${v.toFixed(2)}x`;
}

function fmtB(v: number | null): string {
  if (v == null) return "--";
  return `$${v.toFixed(1)}`;
}

function fmtCoupon(v: number | null): string {
  if (v == null) return "--";
  return `${v.toFixed(3)}%`;
}

// Bid-to-cover color: >2.5 strong (green), <2.2 weak (amber), in-between neutral.
function btcColor(v: number | null): string {
  if (v == null) return "text-terminal-dim";
  if (v >= 2.5) return "text-accent-green";
  if (v < 2.2) return "text-accent-amber";
  return "text-terminal-text";
}

// Panel.

export function TreasuryAuctionsPanel() {
  const [data, setData] = useState<AuctionResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/treasury-auctions")
      .then((res) => res.json())
      .then((json: AuctionResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.recent) && json.recent.length > 0) {
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

  const { recent, upcoming, summary } = data;

  const typeBreakdown = useMemo(() => {
    const entries = Object.entries(summary.count_by_type || {});
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  }, [summary]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Treasury Auctions</span>
        {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi label="2Y Note Stop" value={fmtRate(summary.latest_2y_stop)} sub="Latest high yield" accent="text-accent-green" />
          <Kpi label="10Y Note Stop" value={fmtRate(summary.latest_10y_stop)} sub="Latest high yield" accent="text-accent-green" />
          <Kpi label="30Y Bond Stop" value={fmtRate(summary.latest_30y_stop)} sub="Latest high yield" accent="text-accent-amber" />
          <Kpi label="Avg Bid-to-Cover" value={fmtBtc(summary.avg_bid_to_cover)} sub={`${summary.recent_count} recent auctions`} accent={btcColor(summary.avg_bid_to_cover)} />
        </div>

        {/* Type breakdown pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-2xs text-terminal-dim uppercase tracking-wider mr-1">Mix:</span>
          {typeBreakdown.map(([t, n]) => (
            <span key={t} className="pill text-2xs flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${TYPE_DOT[t] ?? "bg-terminal-muted"}`} />
              <span className={TYPE_ACCENT[t] ?? "text-terminal-text"}>{t}</span>
              <span className="text-terminal-dim font-mono tabular-nums">{n}</span>
            </span>
          ))}
        </div>

        {/* Recent results table */}
        <div>
          <SectionLabel>Recent Auction Results</SectionLabel>
          <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                  <th className="text-left py-1.5 px-2 font-medium">Security</th>
                  <th className="text-left py-1.5 px-2 font-medium">Term</th>
                  <th className="text-right py-1.5 px-2 font-medium">Auction</th>
                  <th className="text-right py-1.5 px-2 font-medium">High Rate</th>
                  <th className="text-right py-1.5 px-2 font-medium">Bid-to-Cover</th>
                  <th className="text-right py-1.5 px-2 font-medium">Offering $B</th>
                  <th className="text-right py-1.5 px-2 font-medium">Coupon</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr
                    key={`${r.security_type}-${r.term}-${r.auction_date}-${i}`}
                    className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                    title={r.maturity_date ? `Matures ${fmtDate(r.maturity_date)}` : undefined}
                  >
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${TYPE_DOT[r.security_type] ?? "bg-terminal-muted"}`} />
                        <span className={`font-medium ${TYPE_ACCENT[r.security_type] ?? "text-terminal-text"}`}>{r.security_type}</span>
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-terminal-muted whitespace-nowrap">{r.term ?? "--"}</td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">{fmtDate(r.auction_date)}</td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap">{fmtRate(r.high_rate)}</td>
                    <td className={`py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap ${btcColor(r.bid_to_cover)}`}>{fmtBtc(r.bid_to_cover)}</td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap">{fmtB(r.offering_amt_b)}</td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim whitespace-nowrap">{fmtCoupon(r.coupon)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Upcoming schedule */}
        {upcoming.length > 0 && (
          <div>
            <SectionLabel>Upcoming Issuance</SectionLabel>
            <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                    <th className="text-left py-1.5 px-2 font-medium">Security</th>
                    <th className="text-left py-1.5 px-2 font-medium">Term</th>
                    <th className="text-right py-1.5 px-2 font-medium">Auction</th>
                    <th className="text-right py-1.5 px-2 font-medium">Settle</th>
                    <th className="text-right py-1.5 px-2 font-medium">Offering $B</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((r, i) => (
                    <tr
                      key={`up-${r.security_type}-${r.term}-${r.auction_date}-${i}`}
                      className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                    >
                      <td className="py-1.5 px-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${TYPE_DOT[r.security_type] ?? "bg-terminal-muted"}`} />
                          <span className={`font-medium ${TYPE_ACCENT[r.security_type] ?? "text-terminal-text"}`}>{r.security_type}</span>
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-terminal-muted whitespace-nowrap">{r.term ?? "--"}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-amber whitespace-nowrap">{fmtDate(r.auction_date)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">{fmtDate(r.issue_date)}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap">{fmtB(r.offering_amt_b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <LegendDot cls="bg-accent-green" label="Bid-to-cover strong (2.5x+)" />
            <LegendDot cls="bg-accent-amber" label="Soft demand (under 2.2x)" />
            <LegendDot cls="bg-accent-blue" label="Bills" />
          </div>
          <span className="text-terminal-dim">High rate = stop-out yield. Auction tape, primary dealer takedown excluded.</span>
        </div>
      </div>
    </div>
  );
}

// Small components.

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
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
      <span>{label}</span>
    </span>
  );
}
