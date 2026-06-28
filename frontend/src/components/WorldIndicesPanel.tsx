import { useEffect, useMemo, useState } from "react";

// -- Local types (decoupled from api/types.ts on purpose) --------------------

interface WorldIndex {
  name: string;
  ticker: string;
  region: string;
  level: number;
  change_pct: number;
  ytd_pct: number;
  currency: string;
  spark: number[];
  data_mode?: string;
}

interface RegionGroup {
  region: string;
  indices: WorldIndex[];
}

interface BestWorst {
  name: string;
  ticker: string;
  change_pct: number;
}

interface RegionAvg {
  region: string;
  avg_change_pct: number;
}

interface WorldIndicesSummary {
  advancers: number;
  decliners: number;
  unchanged: number;
  total: number;
  best: BestWorst | null;
  worst: BestWorst | null;
  region_avg: RegionAvg[];
}

interface WorldIndicesResponse {
  regions: RegionGroup[];
  summary: WorldIndicesSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// -- Local fallback so the panel renders fully populated, even offline -------

function mkSpark(base: number, drift: number): number[] {
  const n = 30;
  const out: number[] = [];
  const start = base / (1 + drift);
  const step = (base - start) / (n - 1);
  for (let i = 0; i < n; i++) {
    const wobble = Math.sin(i * 1.7 + base) * base * 0.004;
    out.push(Number((start + step * i + wobble).toFixed(2)));
  }
  out[n - 1] = base;
  return out;
}

function mkIndex(
  name: string,
  ticker: string,
  region: string,
  currency: string,
  level: number,
  change_pct: number,
  ytd_pct: number,
): WorldIndex {
  return {
    name,
    ticker,
    region,
    currency,
    level,
    change_pct,
    ytd_pct,
    spark: mkSpark(level, ytd_pct / 100),
    data_mode: "sample",
  };
}

const FALLBACK: WorldIndicesResponse = {
  regions: [
    {
      region: "Americas",
      indices: [
        mkIndex("S&P 500", "^GSPC", "Americas", "USD", 5961.42, 0.34, 12.4),
        mkIndex("Nasdaq 100", "^NDX", "Americas", "USD", 21712.8, 0.58, 16.8),
        mkIndex("Dow Jones", "^DJI", "Americas", "USD", 43205.6, 0.12, 7.9),
        mkIndex("Russell 2000", "^RUT", "Americas", "USD", 2331.9, -0.42, 5.2),
        mkIndex("S&P/TSX Composite", "^GSPTSE", "Americas", "CAD", 25438.1, 0.21, 9.6),
        mkIndex("Bovespa", "^BVSP", "Americas", "BRL", 138041.0, 0.74, 14.7),
      ],
    },
    {
      region: "EMEA",
      indices: [
        mkIndex("FTSE 100", "^FTSE", "EMEA", "GBP", 8431.2, -0.18, 8.1),
        mkIndex("DAX", "^GDAXI", "EMEA", "EUR", 18691.4, 0.46, 11.3),
        mkIndex("CAC 40", "^FCHI", "EMEA", "EUR", 7598.3, -0.31, 4.6),
        mkIndex("Euro Stoxx 50", "^STOXX50E", "EMEA", "EUR", 5051.7, 0.27, 9.2),
        mkIndex("IBEX 35", "^IBEX", "EMEA", "EUR", 11962.5, 0.39, 13.5),
        mkIndex("SMI", "^SSMI", "EMEA", "CHF", 12064.9, -0.09, 6.4),
      ],
    },
    {
      region: "Asia-Pacific",
      indices: [
        mkIndex("Nikkei 225", "^N225", "Asia-Pacific", "JPY", 39021.6, 0.81, 10.7),
        mkIndex("Hang Seng", "^HSI", "Asia-Pacific", "HKD", 19288.4, -0.64, 15.1),
        mkIndex("Shanghai Composite", "000001.SS", "Asia-Pacific", "CNY", 3367.8, 0.22, 3.8),
        mkIndex("KOSPI", "^KS11", "Asia-Pacific", "KRW", 2702.3, -0.37, 6.9),
        mkIndex("ASX 200", "^AXJO", "Asia-Pacific", "AUD", 8251.5, 0.18, 7.2),
        mkIndex("Sensex", "^BSESN", "Asia-Pacific", "INR", 80712.4, 0.45, 11.9),
        mkIndex("Nifty 50", "^NSEI", "Asia-Pacific", "INR", 24588.1, 0.41, 12.3),
      ],
    },
  ],
  summary: {
    advancers: 12,
    decliners: 7,
    unchanged: 0,
    total: 19,
    best: { name: "Nikkei 225", ticker: "^N225", change_pct: 0.81 },
    worst: { name: "Hang Seng", ticker: "^HSI", change_pct: -0.64 },
    region_avg: [
      { region: "Americas", avg_change_pct: 0.26 },
      { region: "EMEA", avg_change_pct: 0.09 },
      { region: "Asia-Pacific", avg_change_pct: 0.15 },
    ],
  },
  data_mode: "sample",
  as_of: "",
  source: "curated",
};

// -- Helpers -----------------------------------------------------------------

function fmtLevel(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function changeColor(v: number): string {
  if (v > 0) return "text-accent-green";
  if (v < 0) return "text-accent-red";
  return "text-terminal-muted";
}

function arrow(v: number): string {
  if (v > 0) return "▲"; // up triangle
  if (v < 0) return "▼"; // down triangle
  return "▪"; // flat / unchanged marker
}

// Inline SVG sparkline. Green when the window ended up, red when down.
function Sparkline({ data, up }: { data: number[]; up: boolean }) {
  const w = 84;
  const h = 22;
  if (!data || data.length < 2) {
    return <svg width={w} height={h} className="block" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = up ? "var(--spark-up, #5fa46a)" : "var(--spark-dn, #c4604f)";
  const lastY = h - 2 - ((data[data.length - 1] - min) / range) * (h - 4);
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

export function WorldIndicesPanel() {
  const [data, setData] = useState<WorldIndicesResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/world-indices")
      .then((res) => res.json())
      .then((json: WorldIndicesResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.regions) && json.regions.length > 0) {
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

  const { regions, summary } = data;

  const regionAvgMap = useMemo(() => {
    const m: Record<string, number> = {};
    summary.region_avg.forEach((r) => {
      m[r.region] = r.avg_change_pct;
    });
    return m;
  }, [summary]);

  const breadthPct = useMemo(() => {
    const total = summary.total || 1;
    return Math.round((summary.advancers / total) * 100);
  }, [summary]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>World Equity Indices</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-1">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Breadth</div>
            <div className="flex items-baseline gap-2">
              <span className="stat-figure text-xl tabular-nums text-accent-green">
                {summary.advancers}
              </span>
              <span className="text-terminal-dim text-xs">up</span>
              <span className="stat-figure text-xl tabular-nums text-accent-red">
                {summary.decliners}
              </span>
              <span className="text-terminal-dim text-xs">dn</span>
            </div>
            <div className="h-1.5 rounded-sm overflow-hidden bg-accent-red/40 mt-0.5">
              <div className="h-full bg-accent-green/80" style={{ width: `${breadthPct}%` }} />
            </div>
          </div>

          <BestWorstCard label="Best Today" item={summary.best} positive />
          <BestWorstCard label="Worst Today" item={summary.worst} positive={false} />

          <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-1">
            <div className="text-2xs text-terminal-dim uppercase tracking-wider">Region Avg (Day)</div>
            <div className="flex flex-col gap-0.5 mt-0.5">
              {summary.region_avg.map((r) => (
                <div key={r.region} className="flex items-center justify-between gap-2">
                  <span className="text-2xs text-terminal-muted truncate">{r.region}</span>
                  <span
                    className={`text-2xs font-mono tabular-nums ${changeColor(r.avg_change_pct)}`}
                  >
                    {fmtPct(r.avg_change_pct)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Region-grouped index tables */}
        {regions.map((group) => (
          <div
            key={group.region}
            className="bg-terminal-bg border border-terminal-border/50 rounded overflow-hidden"
          >
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-terminal-divider">
              <span className="text-2xs text-terminal-text uppercase tracking-wider font-medium">
                {group.region}
              </span>
              <span
                className={`text-2xs font-mono tabular-nums ${changeColor(
                  regionAvgMap[group.region] ?? 0,
                )}`}
              >
                avg {fmtPct(regionAvgMap[group.region] ?? 0)}
              </span>
            </div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider/60">
                  <th className="text-left py-1 px-2 font-medium">Index</th>
                  <th className="text-right py-1 px-2 font-medium">Level</th>
                  <th className="text-right py-1 px-2 font-medium">Day</th>
                  <th className="text-right py-1 px-2 font-medium">YTD</th>
                  <th className="text-right py-1 px-2 font-medium hidden sm:table-cell">Trend</th>
                  <th className="text-right py-1 px-2 font-medium hidden md:table-cell">Ccy</th>
                </tr>
              </thead>
              <tbody>
                {group.indices.map((idx) => (
                  <tr
                    key={idx.ticker}
                    className="border-t border-terminal-border/20 hover:bg-white/[0.02]"
                  >
                    <td className="py-1.5 px-2">
                      <div className="text-terminal-text font-medium leading-tight">{idx.name}</div>
                      <div className="font-mono text-2xs text-terminal-dim">{idx.ticker}</div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap">
                      {fmtLevel(idx.level)}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap font-semibold ${changeColor(
                        idx.change_pct,
                      )}`}
                    >
                      <span className="mr-0.5">{arrow(idx.change_pct)}</span>
                      {fmtPct(idx.change_pct)}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap ${changeColor(
                        idx.ytd_pct,
                      )}`}
                    >
                      {fmtPct(idx.ytd_pct)}
                    </td>
                    <td className="py-1.5 px-2 hidden sm:table-cell">
                      <div className="flex justify-end">
                        <Sparkline data={idx.spark} up={idx.change_pct >= 0} />
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-2xs text-terminal-dim hidden md:table-cell">
                      {idx.currency}
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
              <span className="text-accent-green">{"▲"}</span> advancing
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-accent-red">{"▼"}</span> declining
            </span>
            <span>Day % vs prior close. YTD % vs last year-end close.</span>
          </div>
          <span className="text-terminal-dim">
            {summary.total} indices across {regions.length} regions. Levels in local currency.
          </span>
        </div>
      </div>
    </div>
  );
}

// -- Small components --------------------------------------------------------

function BestWorstCard({
  label,
  item,
  positive,
}: {
  label: string;
  item: BestWorst | null;
  positive: boolean;
}) {
  const accent = positive ? "text-accent-green" : "text-accent-red";
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-xl tabular-nums ${item ? changeColor(item.change_pct) : accent}`}>
        {item ? fmtPct(item.change_pct) : "--"}
      </div>
      <div className="text-2xs text-terminal-muted truncate" title={item?.name}>
        {item ? item.name : "--"}
      </div>
    </div>
  );
}
