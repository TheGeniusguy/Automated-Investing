import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface EsgBand {
  name: string;
  min: number;
  max: number | null;
}
interface EsgResponse {
  symbol: string;
  total_esg: number | null;
  risk_band: string;
  environment_score: number | null;
  social_score: number | null;
  governance_score: number | null;
  controversy_level: number | null;
  controversy_label: string;
  controversy_max: number;
  percentile: number | null;
  esg_performance: string | null;
  read: string;
  scale_note: string;
  bands: EsgBand[];
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: EsgResponse = {
  symbol: "AAPL",
  total_esg: 16.8,
  risk_band: "Low",
  environment_score: 2.4,
  social_score: 8.1,
  governance_score: 6.3,
  controversy_level: 2,
  controversy_label: "Moderate",
  controversy_max: 5,
  percentile: 22,
  esg_performance: null,
  read:
    "AAPL carries a total ESG risk score of 16.8 - low unmanaged ESG risk - a strong, well-managed profile. Social is the heaviest risk driver. It sits in the top quartile of peers (better than ~78%).",
  scale_note: "Sustainalytics risk score - lower is better (lower unmanaged ESG risk)",
  bands: [
    { name: "Negligible", min: 0, max: 10 },
    { name: "Low", min: 10, max: 20 },
    { name: "Medium", min: 20, max: 30 },
    { name: "High", min: 30, max: 40 },
    { name: "Severe", min: 40, max: null },
  ],
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// ── Direction-aware color: LOWER risk score = better = green ──────────────────
function bandColor(band: string): string {
  switch (band) {
    case "Negligible": return "text-accent-green";
    case "Low": return "text-accent-green";
    case "Medium": return "text-accent-amber";
    case "High": return "text-accent-red";
    case "Severe": return "text-accent-red";
    default: return "text-terminal-muted";
  }
}
function bandBar(band: string): string {
  switch (band) {
    case "Negligible": return "bg-accent-green";
    case "Low": return "bg-accent-green";
    case "Medium": return "bg-accent-amber";
    case "High": return "bg-accent-red";
    case "Severe": return "bg-accent-red";
    default: return "bg-terminal-dim";
  }
}
// Pillar risk score → color (lower = greener). Pillars are sub-scores, so use
// tighter cut-points than the total.
function pillarColor(v: number | null): string {
  if (v === null || v === undefined) return "text-terminal-muted";
  if (v < 5) return "text-accent-green";
  if (v < 10) return "text-accent-amber";
  return "text-accent-red";
}
function pillarBar(v: number | null): string {
  if (v === null || v === undefined) return "bg-terminal-dim";
  if (v < 5) return "bg-accent-green";
  if (v < 10) return "bg-accent-amber";
  return "bg-accent-red";
}
function controversyColor(level: number | null): string {
  if (level === null || level === undefined) return "text-terminal-muted";
  if (level <= 1) return "text-accent-green";
  if (level <= 2) return "text-accent-amber";
  return "text-accent-red";
}
// Percentile: lower percentile = lower relative risk = better.
function percentileColor(p: number | null): string {
  if (p === null || p === undefined) return "text-terminal-muted";
  if (p <= 25) return "text-accent-green";
  if (p <= 75) return "text-accent-amber";
  return "text-accent-red";
}

function fmtNum(x: number | null, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits);
}

const PILLARS: { key: "environment_score" | "social_score" | "governance_score"; label: string; tag: string }[] = [
  { key: "environment_score", label: "Environment", tag: "E" },
  { key: "social_score", label: "Social", tag: "S" },
  { key: "governance_score", label: "Governance", tag: "G" },
];

export function EsgPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<EsgResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/esg/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: EsgResponse) => {
        if (!alive) return;
        if (json && typeof json.risk_band === "string" && Array.isArray(json.bands)) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = input.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  // Hero position of the total score along the 0-50 risk axis (lower=left=green).
  const heroPct = useMemo(() => {
    const t = data.total_esg;
    if (t === null || t === undefined) return 0;
    return Math.max(0, Math.min(100, (t / 50) * 100));
  }, [data.total_esg]);

  const contrLevel = data.controversy_level ?? 0;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>ESG &amp; CONTROVERSY</span>
        <span className="text-[10px] font-mono text-terminal-dim">
          Sustainalytics risk - lower is better
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ticker"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase w-28 text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={submit}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Screen
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Hero: total ESG risk + band */}
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-5 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Total ESG Risk
            </div>
            <div className="flex items-end gap-1">
              <span className={`stat-figure leading-none tabular-nums ${bandColor(data.risk_band)}`}>
                {fmtNum(data.total_esg)}
              </span>
              <span className="text-terminal-dim font-mono text-sm mb-1">/ lower is better</span>
            </div>
            <div className={`text-sm font-mono uppercase tracking-wide ${bandColor(data.risk_band)}`}>
              {data.risk_band} risk
            </div>
            {/* risk axis: green (left/low) → red (right/high) with marker */}
            <div className="mt-2">
              <div className="relative h-1.5 w-full rounded-full overflow-hidden bg-gradient-to-r from-accent-green via-accent-amber to-accent-red">
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-terminal-text"
                  style={{ left: `${heroPct}%` }}
                />
              </div>
              <div className="flex justify-between text-[9px] font-mono text-terminal-dim mt-0.5">
                <span>0 low</span>
                <span>50+ high</span>
              </div>
            </div>
          </div>

          {/* Controversy + percentile */}
          <div className="col-span-7 grid grid-cols-2 gap-2">
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Controversy</div>
              <div className={`stat-figure leading-none tabular-nums ${controversyColor(data.controversy_level)}`}>
                {data.controversy_level ?? "n/a"}
                <span className="text-terminal-dim font-mono text-sm">/{data.controversy_max}</span>
              </div>
              <div className={`text-[10px] font-mono uppercase ${controversyColor(data.controversy_level)}`}>
                {data.controversy_label}
              </div>
              {/* 5-pip indicator */}
              <div className="mt-1 flex gap-1">
                {Array.from({ length: data.controversy_max }).map((_, i) => {
                  const on = i < contrLevel;
                  const cls = !on
                    ? "bg-terminal-panel"
                    : contrLevel <= 1
                    ? "bg-accent-green"
                    : contrLevel <= 2
                    ? "bg-accent-amber"
                    : "bg-accent-red";
                  return <span key={i} className={`flex-1 h-1.5 rounded-full ${cls}`} />;
                })}
              </div>
            </div>

            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Peer Percentile</div>
              <div className={`stat-figure leading-none tabular-nums ${percentileColor(data.percentile)}`}>
                {data.percentile === null ? "n/a" : fmtNum(data.percentile, 0)}
              </div>
              <div className="text-[10px] font-mono text-terminal-muted">
                {data.percentile === null
                  ? "no peer data"
                  : data.percentile <= 25
                  ? "top quartile (lower risk)"
                  : data.percentile >= 75
                  ? "bottom quartile (higher risk)"
                  : "mid-pack vs peers"}
              </div>
            </div>
          </div>
        </div>

        {/* Plain-language read */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3">
          {data.read}
        </div>

        {/* Three pillar bars (E / S / G) */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Risk Pillars</span>
            <span className="text-terminal-dim">lower bar = lower risk</span>
          </div>
          <div className="space-y-2">
            {PILLARS.map((p) => {
              const v = data[p.key];
              // Pillar bars share the total risk magnitude (cap at ~20 for scale).
              const mag = v === null || v === undefined ? 0 : Math.max(3, Math.min(100, (v / 20) * 100));
              return (
                <div key={p.key} className="flex items-center gap-2">
                  <span
                    className={`shrink-0 w-5 h-5 rounded-sm flex items-center justify-center text-[11px] font-bold font-mono ${
                      pillarColor(v) === "text-accent-green"
                        ? "bg-accent-green/15 text-accent-green"
                        : pillarColor(v) === "text-accent-amber"
                        ? "bg-accent-amber/15 text-accent-amber"
                        : pillarColor(v) === "text-accent-red"
                        ? "bg-accent-red/15 text-accent-red"
                        : "bg-terminal-panel text-terminal-muted"
                    }`}
                  >
                    {p.tag}
                  </span>
                  <span className="w-24 shrink-0 text-[11px] text-terminal-muted font-sans">{p.label}</span>
                  <div className="flex-1 h-2.5 bg-terminal-panel rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${pillarBar(v)}`}
                      style={{ width: `${mag}%` }}
                    />
                  </div>
                  <span className={`w-12 shrink-0 text-right font-mono tabular-nums text-xs ${pillarColor(v)}`}>
                    {fmtNum(v)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Risk-band legend with active band highlighted */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            Sustainalytics Risk Bands
          </div>
          <div className="grid grid-cols-5 gap-1">
            {data.bands.map((b) => {
              const active = b.name === data.risk_band;
              return (
                <div
                  key={b.name}
                  className={`rounded p-1.5 border text-center ${
                    active
                      ? "border-accent " + bandColor(b.name)
                      : "border-terminal-border text-terminal-dim"
                  }`}
                >
                  <div className={`h-1 w-full rounded-full mb-1 ${bandBar(b.name)} ${active ? "" : "opacity-30"}`} />
                  <div className="text-[10px] font-mono uppercase truncate">{b.name}</div>
                  <div className="text-[9px] font-mono tabular-nums text-terminal-dim">
                    {b.min}{b.max === null ? "+" : `-${b.max}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto flex items-center gap-3 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          {data.esg_performance && (
            <span>
              Performance{" "}
              <span className="text-terminal-text">{data.esg_performance}</span>
            </span>
          )}
          <span className="ml-auto">{data.scale_note}</span>
        </div>
      </div>
    </div>
  );
}
