import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface RateRow {
  key: string;
  label: string;
  level: number | null;
  chg_bp: number | null;
  unit: string;
}

interface SpreadRow {
  key: string;
  label: string;
  value_bp: number | null;
}

interface FlowBlock {
  volume_b?: number | null;
  level_b?: number | null;
  chg_b: number | null;
  trend: string;
}

interface HistoryPoint {
  date: string;
  sofr: number;
  effr?: number;
  iorb?: number;
}

interface StressBlock {
  label: string;
  verdict: string;
}

interface RepoFundingResponse {
  rates: RateRow[];
  spreads: SpreadRow[];
  rrp: FlowBlock;
  reserves: FlowBlock;
  history: HistoryPoint[];
  stress: StressBlock;
  unit_rate: string;
  unit_bp: string;
  unit_vol: string;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend mid-2026 calm-regime sample: secured rates just under the IORB floor,
// RRP drained to a small residual, reserves ~$3.2T.

const FALLBACK: RepoFundingResponse = (() => {
  const history: HistoryPoint[] = [];
  for (let i = 0; i < 90; i++) {
    const wob = 0.004 * Math.sin(i / 4) + 0.003 * Math.cos(i / 7);
    history.push({
      date: `2026-${String(1 + Math.floor(i / 30)).padStart(2, "0")}-${String(
        1 + (i % 30)
      ).padStart(2, "0")}`,
      sofr: Math.round((4.31 + wob) * 1000) / 1000,
      effr: 4.33,
      iorb: 4.4,
    });
  }
  return {
    rates: [
      { key: "SOFR", label: "SOFR", level: 4.31, chg_bp: -1, unit: "%" },
      { key: "EFFR", label: "EFFR", level: 4.33, chg_bp: 0, unit: "%" },
      { key: "OBFR", label: "OBFR", level: 4.32, chg_bp: 0, unit: "%" },
      { key: "IORB", label: "IORB", level: 4.4, chg_bp: 0, unit: "%" },
      { key: "RRPONTSYAWARD", label: "ON-RRP Rate", level: 4.25, chg_bp: 0, unit: "%" },
    ],
    spreads: [
      { key: "SOFR_EFFR", label: "SOFR-EFFR", value_bp: -2 },
      { key: "SOFR_IORB", label: "SOFR-IORB", value_bp: -9 },
      { key: "EFFR_IORB", label: "EFFR-IORB", value_bp: -7 },
    ],
    rrp: { volume_b: 118, chg_b: -16, trend: "falling" },
    reserves: { level_b: 3210, chg_b: -35, trend: "falling" },
    history,
    stress: {
      label: "Calm",
      verdict:
        "SOFR is 9bp BELOW IORB - abundant reserves, cash looking for a home. " +
        "Funding markets are calm and the floor system is working as designed.",
    },
    unit_rate: "%",
    unit_bp: "bp",
    unit_vol: "$B",
    data_mode: "sample",
    as_of: "",
    source: "sample",
  };
})();

// Stress-label pill color.
function stressStyle(label: string): CSSProperties {
  switch (label) {
    case "Stressed":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "Firming":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    case "Calm":
      return { color: "#5f9460", borderColor: "#5f9460" };
    case "Neutral":
      return { color: "#84934f", borderColor: "#84934f" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Formatting

function fmtBp(v: number | null): string {
  if (v === null || v === undefined) return "--";
  return (v >= 0 ? "+" : "") + v.toFixed(0);
}

// P&L color convention: up = green, down = red. For a raw spread (signed level)
// we color by sign; for a daily change, the same.
function changeClass(v: number | null): string {
  if (v === null || v === undefined || v === 0) return "text-terminal-muted";
  return v > 0 ? "text-green-400" : "text-red-400";
}

function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined) return "--";
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}T`;
  return `$${v.toFixed(0)}B`;
}

function trendArrow(trend: string): string {
  if (trend === "rising") return "▲"; // up triangle
  if (trend === "falling") return "▼"; // down triangle
  return "—"; // em-ish dash, flat
}

// Tiny inline SVG sparkline for SOFR vs IORB.
function Sparkline({ history }: { history: HistoryPoint[] }) {
  const pts = history.filter((h) => typeof h.sofr === "number");
  if (pts.length < 2) return null;
  const w = 100;
  const h = 28;
  const vals: number[] = [];
  for (const p of pts) {
    vals.push(p.sofr);
    if (typeof p.iorb === "number") vals.push(p.iorb);
  }
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - ((v - lo) / span) * h;
  const path = (sel: (p: HistoryPoint) => number | undefined) => {
    let d = "";
    pts.forEach((p, i) => {
      const v = sel(p);
      if (v === undefined) return;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    });
    return d.trim();
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-7">
      <path d={path((p) => p.iorb)} fill="none" stroke="#5c554b" strokeWidth={1} strokeDasharray="2 2" />
      <path d={path((p) => p.sofr)} fill="none" stroke="#c9a24a" strokeWidth={1.5} />
    </svg>
  );
}

// Panel

export function RepoFundingPanel() {
  const [data, setData] = useState<RepoFundingResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/repo-funding")
      .then((res) => res.json())
      .then((json: RepoFundingResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.rates) && json.rates.length > 0) {
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

  const { rates, spreads, rrp, reserves, stress, history } = data;

  const sofrIorb = useMemo(
    () => spreads.find((s) => s.key === "SOFR_IORB")?.value_bp ?? null,
    [spreads]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>REPO &amp; FUNDING MONITOR</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Stress verdict hero */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-terminal-dim uppercase tracking-wider">
              Funding Stress
            </span>
            <span className="pill uppercase tracking-wider" style={stressStyle(stress.label)}>
              {stress.label}
            </span>
          </div>
          <p className="text-sm text-terminal-text font-serif leading-snug">{stress.verdict}</p>
        </div>

        {/* Rate board */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Overnight Rate</SectionLabel>
            <SectionLabel right>Level</SectionLabel>
            <SectionLabel right>1d (bp)</SectionLabel>
          </div>
          <div className="flex flex-col">
            {rates.map((r) => (
              <div
                key={r.key}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 py-1 border-b border-terminal-divider/40 last:border-0"
              >
                <span className="font-mono text-xs text-terminal-text font-semibold">{r.label}</span>
                <span className="font-mono tabular-nums text-sm text-terminal-text text-right w-16">
                  {r.level === null ? "--" : r.level.toFixed(2)}
                  <span className="text-2xs text-terminal-dim">%</span>
                </span>
                <span
                  className={`font-mono tabular-nums text-xs text-right w-12 ${changeClass(r.chg_bp)}`}
                >
                  {fmtBp(r.chg_bp)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Spreads */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1.5">
            Funding Spreads (bp)
          </div>
          <div className="grid grid-cols-3 gap-2">
            {spreads.map((s) => (
              <div key={s.key} className="flex flex-col items-center gap-0.5">
                <span className="text-2xs text-terminal-dim uppercase tracking-wider">{s.label}</span>
                <span className={`stat-figure text-xl tabular-nums ${changeClass(s.value_bp)}`}>
                  {fmtBp(s.value_bp)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* RRP take-up + reserves */}
        <div className="grid grid-cols-2 gap-2">
          <FlowCell
            label="ON-RRP Take-Up"
            value={fmtVol(rrp.volume_b)}
            chg={rrp.chg_b}
            trend={rrp.trend}
            unit="$B"
          />
          <FlowCell
            label="Bank Reserves"
            value={fmtVol(reserves.level_b)}
            chg={reserves.chg_b}
            trend={reserves.trend}
            unit="$B"
          />
        </div>

        {/* SOFR vs IORB sparkline */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              SOFR vs IORB floor
            </span>
            <span className="text-2xs text-terminal-dim tabular-nums">
              {sofrIorb === null ? "" : `SOFR ${fmtBp(sofrIorb)}bp vs floor`}
            </span>
          </div>
          <Sparkline history={history} />
          <div className="flex items-center gap-3 text-2xs text-terminal-dim">
            <LegendSwatch color="#c9a24a" label="SOFR" />
            <LegendSwatch color="#5c554b" label="IORB (floor)" />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end text-2xs text-terminal-dim">
          <span className="uppercase tracking-wider">Overnight funding &middot; {data.source}</span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function FlowCell({
  label,
  value,
  chg,
  trend,
  unit,
}: {
  label: string;
  value: string;
  chg: number | null;
  trend: string;
  unit: string;
}) {
  // For these flows, falling reserves/RRP isn't inherently "bad" P&L — we color the
  // change by sign only (down = red, up = green) per the terminal convention.
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <span className="stat-figure text-2xl tabular-nums text-terminal-text leading-none truncate">
        {value}
      </span>
      <span className={`text-2xs tabular-nums ${changeClass(chg)}`}>
        {trendArrow(trend)} {chg === null ? "--" : `${chg >= 0 ? "+" : ""}${chg.toFixed(0)} ${unit} /wk`}
      </span>
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <div
      className={`text-2xs text-terminal-muted uppercase tracking-wider ${right ? "text-right" : ""}`}
    >
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
