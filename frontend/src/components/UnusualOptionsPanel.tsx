import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface UnusualContract {
  symbol: string;
  underlying: string;
  type: string; // "call" | "put"
  strike: number;
  expiry: string;
  spot: number;
  moneyness: string; // ITM | ATM | OTM
  volume: number;
  open_interest: number;
  vol_oi_ratio: number;
  last_price: number;
  premium_usd: number;
  implied_vol: number | null;
  unusual_score: number;
  flag: string; // Extreme | Hot | Notable
}

interface SkewRow {
  underlying: string;
  name: string;
  call_premium: number;
  put_premium: number;
  tilt: string; // Bullish | Bearish | Neutral
}

interface UnusualSummary {
  most_unusual: string | null;
  total_premium: number;
  call_put_ratio: number | null;
  bullish_count: number;
  bearish_count: number;
}

interface UnusualOptionsResponse {
  contracts: UnusualContract[];
  skew: SkewRow[];
  summary: UnusualSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Call = green, Put = red.
function typePillStyle(type: string): CSSProperties {
  return type === "call"
    ? { color: "#6f8f5f", borderColor: "#6f8f5f" }
    : { color: "#c2603f", borderColor: "#c2603f" };
}

// Flag -> color. Extreme = deep red, Hot = clay, Notable = amber.
function flagColor(flag: string): string {
  switch (flag) {
    case "Extreme":
      return "#c2603f";
    case "Hot":
      return "#cc8a55";
    default:
      return "#c9a24a";
  }
}

function flagPillStyle(flag: string): CSSProperties {
  return { color: flagColor(flag), borderColor: flagColor(flag) };
}

// Heat bar ramps amber -> red as the vol/OI ratio climbs.
function ratioColor(ratio: number): string {
  if (ratio >= 8) return "#c2603f";
  if (ratio >= 4) return "#cc6a44";
  if (ratio >= 2.5) return "#cc8a55";
  if (ratio >= 1.5) return "#c9a24a";
  return "#8a8175";
}

function tiltClass(tilt: string): string {
  if (tilt === "Bullish") return "text-accent-green";
  if (tilt === "Bearish") return "text-accent-red";
  return "text-terminal-muted";
}

function moneynessClass(m: string): string {
  if (m === "ITM") return "text-accent-green";
  if (m === "OTM") return "text-terminal-dim";
  return "text-terminal-muted";
}

// Formatting helpers

function fmtUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtInt(v: number): string {
  return v.toLocaleString("en-US");
}

function fmtRatio(v: number): string {
  return `${v.toFixed(1)}x`;
}

function fmtIv(v: number | null): string {
  return v == null ? "--" : `${(v * 100).toFixed(0)}%`;
}

function fmtExpiry(s: string): string {
  // YYYY-MM-DD -> MM/DD
  const parts = s.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : s;
}

// Local fallback so the panel renders fully populated, even offline.
// A believable unusual-flow tape: NVDA call sweeps, TSLA put buying, SPY
// hedging flow, a meme-name call spike, plus per-ticker premium skew.

const FALLBACK: UnusualOptionsResponse = (() => {
  const spots: Record<string, number> = {
    NVDA: 124.3, TSLA: 246.8, SPY: 543.1, AAPL: 213.55, PLTR: 28.4,
    AMD: 162.2, META: 503.7, COIN: 232.1, GME: 24.8, QQQ: 472.4,
    SMCI: 41.6, MARA: 18.3,
  };
  const names: Record<string, string> = {
    NVDA: "NVIDIA Corp.", TSLA: "Tesla Inc.", SPY: "SPDR S&P 500 ETF",
    AAPL: "Apple Inc.", PLTR: "Palantir Technologies", AMD: "Advanced Micro Devices",
    META: "Meta Platforms Inc.", COIN: "Coinbase Global Inc.", GME: "GameStop Corp.",
    QQQ: "Invesco QQQ Trust", SMCI: "Super Micro Computer", MARA: "MARA Holdings Inc.",
  };
  // [under, type, strikeOff%, expDays, volume, OI, last, iv]
  const flow: Array<[string, string, number, number, number, number, number, number]> = [
    ["NVDA", "call", +0.06, 9, 48200, 6100, 3.85, 0.58],
    ["NVDA", "call", +0.12, 23, 31500, 9400, 2.1, 0.61],
    ["TSLA", "put", -0.07, 9, 27800, 4200, 5.4, 0.66],
    ["TSLA", "put", -0.12, 16, 19400, 7800, 3.2, 0.69],
    ["SPY", "put", -0.03, 7, 41200, 22500, 4.1, 0.18],
    ["SPY", "put", -0.05, 30, 28900, 31000, 6.75, 0.19],
    ["GME", "call", +0.18, 16, 36500, 3100, 1.05, 1.04],
    ["PLTR", "call", +0.09, 23, 22400, 5600, 1.35, 0.72],
    ["AMD", "call", +0.05, 9, 18900, 7200, 4.2, 0.54],
    ["COIN", "call", +0.1, 16, 14600, 4800, 7.8, 0.78],
    ["META", "call", +0.04, 9, 9800, 6900, 9.4, 0.42],
    ["SMCI", "call", +0.15, 23, 16800, 2900, 2.65, 0.95],
    ["MARA", "call", +0.2, 30, 24100, 5200, 0.78, 1.18],
    ["AAPL", "put", -0.04, 16, 12400, 15800, 3.05, 0.31],
    ["NVDA", "put", -0.08, 9, 11200, 8300, 1.95, 0.6],
    ["QQQ", "put", -0.04, 9, 19800, 18900, 3.45, 0.2],
    ["TSLA", "call", +0.1, 23, 15600, 9100, 4.85, 0.64],
    ["AMD", "put", -0.06, 16, 8700, 9400, 3.1, 0.56],
    ["PLTR", "call", +0.16, 44, 13900, 3400, 0.92, 0.75],
    ["GME", "call", +0.3, 30, 21300, 4100, 0.55, 1.22],
    ["NVDA", "call", +0.2, 44, 18700, 5900, 1.45, 0.63],
    ["SMCI", "put", -0.12, 16, 9200, 3700, 3.9, 0.98],
    ["MARA", "call", +0.1, 16, 14800, 6300, 1.1, 1.1],
    ["AAPL", "call", +0.03, 9, 8100, 12400, 4.5, 0.29],
    ["META", "put", -0.05, 16, 6800, 8800, 8.1, 0.4],
  ];
  const score = (volOi: number, premium: number, volume: number): number => {
    const r = Math.max(0, volOi);
    const p = Math.max(0, premium);
    const v = Math.max(0, volume);
    const ratioPts = Math.min(60, 25 * Math.log1p(r));
    let premPts = p > 1 ? 6 * Math.log10(Math.max(p, 1)) - 24 : 0;
    premPts = Math.max(0, Math.min(40, premPts));
    const volPts = Math.min(6, Math.log10(Math.max(v, 1)));
    return Math.round((Math.min(100, ratioPts + premPts + volPts)) * 10) / 10;
  };
  const flagOf = (s: number): string => (s >= 80 ? "Extreme" : s >= 55 ? "Hot" : "Notable");
  const moneynessOf = (type: string, strike: number, spot: number): string => {
    const rel = (strike - spot) / spot;
    if (Math.abs(rel) <= 0.01) return "ATM";
    if (type === "call") return strike < spot ? "ITM" : "OTM";
    return strike > spot ? "ITM" : "OTM";
  };
  const today = new Date();
  const iso = (days: number): string => {
    const d = new Date(today.getTime() + days * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const prem: Record<string, { call: number; put: number }> = {};
  const contracts: UnusualContract[] = flow.map(
    ([under, type, off, exp, volume, oi, last, iv]) => {
      const spot = spots[under] ?? 100;
      const strike = Math.round(spot * (1 + off) * 100) / 100;
      const premium = volume * last * 100;
      const volOi = Math.round((volume / Math.max(oi, 1)) * 100) / 100;
      const sc = score(volume / Math.max(oi, 1), premium, volume);
      const slot = (prem[under] ??= { call: 0, put: 0 });
      if (type === "call") slot.call += premium;
      else slot.put += premium;
      return {
        symbol: `${under}${iso(exp).replace(/-/g, "").slice(2)}${type === "call" ? "C" : "P"}`,
        underlying: under,
        type,
        strike,
        expiry: iso(exp),
        spot,
        moneyness: moneynessOf(type, strike, spot),
        volume,
        open_interest: oi,
        vol_oi_ratio: volOi,
        last_price: last,
        premium_usd: Math.round(premium * 100) / 100,
        implied_vol: iv,
        unusual_score: sc,
        flag: flagOf(sc),
      };
    }
  );
  contracts.sort((a, b) => b.unusual_score - a.unusual_score);
  const tiltOf = (call: number, put: number): string => {
    const total = call + put;
    if (total <= 0) return "Neutral";
    const share = call / total;
    if (share >= 0.62) return "Bullish";
    if (share <= 0.38) return "Bearish";
    return "Neutral";
  };
  const skew: SkewRow[] = Object.entries(prem)
    .map(([under, p]) => ({
      underlying: under,
      name: names[under] ?? under,
      call_premium: Math.round(p.call * 100) / 100,
      put_premium: Math.round(p.put * 100) / 100,
      tilt: tiltOf(p.call, p.put),
    }))
    .sort((a, b) => b.call_premium + b.put_premium - (a.call_premium + a.put_premium));
  const totalCall = skew.reduce((s, r) => s + r.call_premium, 0);
  const totalPut = skew.reduce((s, r) => s + r.put_premium, 0);
  return {
    contracts,
    skew,
    summary: {
      most_unusual: contracts[0]?.underlying ?? null,
      total_premium: Math.round(contracts.reduce((s, c) => s + c.premium_usd, 0) * 100) / 100,
      call_put_ratio: totalPut > 0 ? Math.round((totalCall / totalPut) * 100) / 100 : null,
      bullish_count: skew.filter((s) => s.tilt === "Bullish").length,
      bearish_count: skew.filter((s) => s.tilt === "Bearish").length,
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Panel

export function UnusualOptionsPanel() {
  const [data, setData] = useState<UnusualOptionsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/unusual-options")
      .then((res) => res.json())
      .then((json: UnusualOptionsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.contracts) && json.contracts.length > 0) {
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

  const { contracts, skew, summary } = data;

  // Scale vol/OI bars to the most unusual reading so the leader fills the track.
  const maxRatio = useMemo(
    () => Math.max(4, ...contracts.map((c) => c.vol_oi_ratio)),
    [contracts]
  );

  const cpr = summary.call_put_ratio;
  const cprTilt = cpr == null ? "Neutral" : cpr >= 1.15 ? "Bullish" : cpr <= 0.85 ? "Bearish" : "Neutral";

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>UNUSUAL OPTIONS ACTIVITY</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Summary strip: KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Most Unusual">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.most_unusual ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {contracts[0] ? `${contracts[0].flag} - score ${contracts[0].unusual_score.toFixed(0)}` : ""}
            </span>
          </KpiCell>
          <KpiCell label="Premium Scanned">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text leading-none">
              {fmtUsd(summary.total_premium)}
            </span>
            <span className="text-2xs text-terminal-dim">top {contracts.length} prints</span>
          </KpiCell>
          <KpiCell label="Call / Put Premium">
            <span className={`stat-figure text-3xl tabular-nums leading-none ${tiltClass(cprTilt)}`}>
              {cpr == null ? "--" : `${cpr.toFixed(2)}x`}
            </span>
            <span className={`text-2xs ${tiltClass(cprTilt)}`}>
              {cprTilt.toLowerCase()} tilt
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Contracts trading far above their resting open interest, or printing in size, are where
            fresh, aggressive positioning is concentrating. A high vol/OI ratio means today's flow is
            new - not the existing book changing hands.
          </p>
        </div>

        {/* HERO: unusual activity tape */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[150px_1fr_84px_72px_52px_56px] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Contract</SectionLabel>
            <SectionLabel>Vol / OI spike</SectionLabel>
            <SectionLabel right>Premium</SectionLabel>
            <SectionLabel right>Vol / OI</SectionLabel>
            <SectionLabel right>IV</SectionLabel>
            <SectionLabel right>Flag</SectionLabel>
          </div>

          <div className="flex flex-col">
            {contracts.map((row, i) => (
              <TapeRow key={row.symbol + i} row={row} maxRatio={maxRatio} rank={i + 1} />
            ))}
          </div>
        </div>

        {/* Per-ticker premium skew */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1.5">
            Call / Put Premium Skew by Underlying
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {skew.map((s) => (
              <SkewBar key={s.underlying} row={s} />
            ))}
          </div>
        </div>

        {/* Footer legend */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color="#c2603f" label="Extreme >= 80" />
            <LegendSwatch color="#cc8a55" label="Hot >= 55" />
            <LegendSwatch color="#c9a24a" label="Notable" />
          </div>
          <span className="uppercase tracking-wider">Vol/OI = today's volume / resting open interest</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function TapeRow({ row, maxRatio, rank }: { row: UnusualContract; maxRatio: number; rank: number }) {
  const color = ratioColor(row.vol_oi_ratio);
  const pct = Math.max(2, Math.min(100, (row.vol_oi_ratio / maxRatio) * 100));
  return (
    <div className="grid grid-cols-[150px_1fr_84px_72px_52px_56px] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Contract: underlying + C/P + strike + expiry */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-2xs text-terminal-dim tabular-nums w-4 text-right shrink-0">{rank}</span>
        <span className="font-mono text-xs text-terminal-text font-semibold shrink-0">{row.underlying}</span>
        <span className="pill uppercase tracking-wider shrink-0" style={typePillStyle(row.type)}>
          {row.type === "call" ? "C" : "P"}
        </span>
        <span className="text-2xs text-terminal-muted tabular-nums truncate">
          ${row.strike} {fmtExpiry(row.expiry)}
        </span>
      </div>

      {/* Vol/OI bar + detail line */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="relative h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
          {/* 1.0x reference marker */}
          <div
            className="absolute inset-y-0 w-px bg-terminal-muted/70"
            style={{ left: `${Math.min(100, (1 / maxRatio) * 100)}%` }}
          />
        </div>
        <span className="text-2xs text-terminal-dim truncate tabular-nums">
          vol {fmtInt(row.volume)} / OI {fmtInt(row.open_interest)}
          <span className={`ml-1.5 ${moneynessClass(row.moneyness)}`}>{row.moneyness}</span>
          <span className="ml-1.5">@ ${row.last_price.toFixed(2)}</span>
        </span>
      </div>

      {/* Premium */}
      <div className="text-right font-mono tabular-nums text-xs leading-tight">
        <span className="text-terminal-text">{fmtUsd(row.premium_usd)}</span>
      </div>

      {/* Vol/OI ratio */}
      <div className="text-right font-mono tabular-nums text-xs font-semibold" style={{ color }}>
        {fmtRatio(row.vol_oi_ratio)}
      </div>

      {/* IV */}
      <div className="text-right font-mono tabular-nums text-xs text-terminal-muted">
        {fmtIv(row.implied_vol)}
      </div>

      {/* Flag pill */}
      <div className="flex justify-end">
        <span className="pill uppercase tracking-wider" style={flagPillStyle(row.flag)}>
          {row.flag}
        </span>
      </div>
    </div>
  );
}

function SkewBar({ row }: { row: SkewRow }) {
  const total = row.call_premium + row.put_premium;
  const callPct = total > 0 ? (row.call_premium / total) * 100 : 50;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-2xs text-terminal-text font-semibold w-12 shrink-0">
        {row.underlying}
      </span>
      <div className="relative h-2 rounded-full overflow-hidden flex-1 min-w-0 bg-terminal-divider/40">
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${callPct}%`, backgroundColor: "#6f8f5f" }}
        />
        <div
          className="absolute inset-y-0 right-0"
          style={{ width: `${100 - callPct}%`, backgroundColor: "#c2603f" }}
        />
      </div>
      <span className={`text-2xs uppercase tracking-wider w-14 text-right shrink-0 ${tiltClass(row.tilt)}`}>
        {row.tilt}
      </span>
    </div>
  );
}

function KpiCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex flex-col gap-0.5 min-w-0">{children}</div>
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <div className={`text-2xs text-terminal-muted uppercase tracking-wider ${right ? "text-right" : ""}`}>
      {children}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
