import { useEffect, useState } from "react";

// Local types (decoupled from api/types.ts on purpose) -----------------------

interface HistoryPoint {
  date: string;
  value: number;
}

interface CarbonMarket {
  key: string;
  name: string;
  region: string;
  kind: string; // "etf" | "allowance"
  unit: string;
  price: number;
  change: number;
  change_pct: number;
  ytd_pct: number;
  trend: string; // "rising" | "falling" | "flat"
  hi: number;
  lo: number;
  n_obs: number;
  blurb: string;
  method: string;
  data_mode: string;
  history: HistoryPoint[];
}

interface CarbonResponse {
  markets: CarbonMarket[];
  count: number;
  live_count: number;
  regime_read: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline. Mirrors
// the backend's plausible mid-2026 levels; never shows an empty state.

function flatHistory(anchor: number, drift: number, n = 60): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const wobble = Math.sin(i / 4) * anchor * 0.012;
    const v = anchor * (1 - drift) + anchor * drift * t + wobble;
    out.push({ date: `d${i}`, value: Math.round(v * 100) / 100 });
  }
  out[out.length - 1] = { date: `d${n - 1}`, value: anchor };
  return out;
}

function mkMarket(
  key: string,
  name: string,
  region: string,
  kind: string,
  unit: string,
  price: number,
  change_pct: number,
  ytd_pct: number,
  trend: string,
  blurb: string,
  method: string
): CarbonMarket {
  const hist = flatHistory(price, ytd_pct / 100);
  return {
    key,
    name,
    region,
    kind,
    unit,
    price,
    change: Math.round(price * (change_pct / 100) * 100) / 100,
    change_pct,
    ytd_pct,
    trend,
    hi: Math.max(...hist.map((h) => h.value)),
    lo: Math.min(...hist.map((h) => h.value)),
    n_obs: hist.length,
    blurb,
    method,
    data_mode: "sample",
    history: hist,
  };
}

const FALLBACK: CarbonResponse = {
  markets: [
    mkMarket(
      "eua",
      "EU ETS (EUA)",
      "Europe",
      "allowance",
      "EUR/t",
      72.0,
      0.4,
      6.1,
      "rising",
      "The EU Emissions Trading System price - the deepest, most liquid carbon market.",
      "sample EUA series anchored to ~EUR72/t"
    ),
    mkMarket(
      "cca",
      "California CCA",
      "WCI (US/CA)",
      "allowance",
      "USD/t",
      34.0,
      0.2,
      3.4,
      "rising",
      "The California / WCI allowance - North America's largest cap-and-trade market.",
      "sample CCA series anchored to ~$34/t"
    ),
    mkMarket(
      "rggi",
      "RGGI",
      "US Northeast",
      "allowance",
      "USD/t",
      21.0,
      -0.1,
      1.2,
      "flat",
      "The Regional Greenhouse Gas Initiative - power-sector cap-and-trade in the US Northeast.",
      "sample RGGI series anchored to ~$21/t"
    ),
    mkMarket(
      "krbn",
      "KRBN (Global Carbon)",
      "Global ETF",
      "etf",
      "USD",
      56.0,
      0.5,
      4.8,
      "rising",
      "KraneShares Global Carbon ETF - a single tradable basket of EUA, CCA and RGGI futures.",
      "sample KRBN price ~ $56"
    ),
    mkMarket(
      "grn",
      "GRN (iPath Carbon)",
      "Global ETN",
      "etf",
      "USD",
      32.0,
      0.3,
      3.9,
      "rising",
      "The iPath Series B Carbon ETN - a long-running listed proxy for the global carbon complex.",
      "sample GRN price ~ $32"
    ),
  ],
  count: 5,
  live_count: 0,
  regime_read:
    "Carbon prices are broadly range-bound - the cost of compliance is steady, with no decisive tightening or loosening.",
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

// Formatting helpers ---------------------------------------------------------

function fmtPrice(unit: string, v: number): string {
  const sym = unit.startsWith("EUR") ? "€" : unit.startsWith("USD") ? "$" : "";
  return `${sym}${v.toFixed(2)}`;
}

function signColor(v: number): string {
  if (v > 0) return "text-green-400";
  if (v < 0) return "text-red-400";
  return "text-terminal-dim";
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPct1(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function trendBadge(trend: string): { label: string; cls: string } {
  if (trend === "rising") return { label: "▲ rising", cls: "text-green-400" };
  if (trend === "falling") return { label: "▼ falling", cls: "text-red-400" };
  return { label: "▪ flat", cls: "text-terminal-dim" };
}

// Inline SVG sparkline. Green when the window ended up, red when down.
function Sparkline({ data, up }: { data: HistoryPoint[]; up: boolean }) {
  const w = 96;
  const h = 26;
  if (!data || data.length < 2) {
    return <svg width={w} height={h} className="block" />;
  }
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = w / (vals.length - 1);
  const points = vals
    .map((v, i) => {
      const x = i * stepX;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = up ? "#5fa46a" : "#c4604f";
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
      <circle cx={w} cy={lastY} r={1.7} fill={stroke} />
    </svg>
  );
}

// Panel ----------------------------------------------------------------------

export function CarbonMarketsPanel() {
  const [data, setData] = useState<CarbonResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/carbon-markets")
      .then((res) => res.json())
      .then((json: CarbonResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.markets) && json.markets.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const markets = data.markets?.length ? data.markets : FALLBACK.markets;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>CARBON &amp; EMISSIONS MARKETS</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
        {error && !loading && (
          <span className="text-terminal-dim normal-case tracking-normal">offline - sample</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Regime read */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-dim uppercase tracking-wider mb-1">
            Carbon-Price Regime
          </div>
          <p className="text-sm text-terminal-text font-serif leading-snug">
            {data.regime_read}
          </p>
        </div>

        {/* Column header */}
        <div
          className="grid items-end gap-2 px-2 text-2xs text-terminal-muted uppercase tracking-wider"
          style={{ gridTemplateColumns: "150px 1fr 96px 92px 70px" }}
        >
          <span>Market</span>
          <span className="text-right">Price</span>
          <span className="text-right">Day</span>
          <span className="text-right">YTD</span>
          <span className="text-right">Trend</span>
        </div>

        {/* Market rows */}
        <div className="flex flex-col gap-1.5">
          {markets.map((m) => {
            const tb = trendBadge(m.trend);
            return (
              <div
                key={m.key}
                className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2"
              >
                <div
                  className="grid items-center gap-2"
                  style={{ gridTemplateColumns: "150px 1fr 96px 92px 70px" }}
                >
                  {/* Name + region */}
                  <div className="flex flex-col min-w-0">
                    <span className="font-mono text-xs text-terminal-text font-semibold truncate">
                      {m.name}
                    </span>
                    <span className="text-2xs text-terminal-dim truncate">{m.region}</span>
                  </div>

                  {/* Price + sparkline */}
                  <div className="flex items-center justify-end gap-3 min-w-0">
                    <Sparkline data={m.history} up={m.ytd_pct >= 0} />
                    <div className="flex flex-col items-end">
                      <span className="font-mono tabular-nums text-sm text-terminal-text font-semibold">
                        {fmtPrice(m.unit, m.price)}
                      </span>
                      <span className="text-2xs text-terminal-dim">{m.unit}</span>
                    </div>
                  </div>

                  {/* Daily change */}
                  <div className="flex flex-col items-end">
                    <span className={`font-mono tabular-nums text-xs ${signColor(m.change_pct)}`}>
                      {fmtPct(m.change_pct)}
                    </span>
                    <span className={`text-2xs ${signColor(m.change)}`}>
                      {m.change >= 0 ? "+" : ""}
                      {m.change.toFixed(2)}
                    </span>
                  </div>

                  {/* YTD */}
                  <div className="flex items-center justify-end">
                    <span className={`font-mono tabular-nums text-xs ${signColor(m.ytd_pct)}`}>
                      {fmtPct1(m.ytd_pct)}
                    </span>
                  </div>

                  {/* Trend */}
                  <div className="flex items-center justify-end">
                    <span className={`font-mono text-2xs ${tb.cls}`}>{tb.label}</span>
                  </div>
                </div>

                {/* Method / honesty line */}
                <div className="text-2xs text-terminal-dim mt-1.5 leading-snug" title={m.blurb}>
                  {m.method}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim mt-auto pt-1">
          <span className="uppercase tracking-wider">
            EUA / CCA derived from ETF proxies - levels anchored, not auction settlements
          </span>
          <span className="font-mono">{markets.length} markets</span>
        </div>
      </div>
    </div>
  );
}
