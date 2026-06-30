import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface StorageWeek {
  week: string;
  level: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
}

interface StorageSummary {
  headline: string;
  vs_normal: string;
  trend: string;
}

interface NatGasStorageResponse {
  current_bcf: number | null;
  prior_bcf: number | null;
  weekly_change: number | null;
  five_yr_avg_bcf: number | null;
  five_yr_min_bcf: number | null;
  five_yr_max_bcf: number | null;
  surplus_deficit_bcf: number | null;
  surplus_deficit_pct: number | null;
  status: string;
  history: StorageWeek[];
  summary: StorageSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Status -> color. Surplus = green (loose / bearish gas), Deficit = red
// (tight / bullish gas), Normal = neutral ink.

function statusTextClass(status: string): string {
  switch (status) {
    case "Surplus":
      return "text-accent-green";
    case "Deficit":
      return "text-accent-red";
    default:
      return "text-terminal-muted";
  }
}

function statusPillStyle(status: string): CSSProperties {
  switch (status) {
    case "Surplus":
      return { color: "#6f8f5a", borderColor: "#6f8f5a" };
    case "Deficit":
      return { color: "#c2603f", borderColor: "#c2603f" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

const CURRENT_COLOR = "#c97a47"; // clay accent for the current-year line
const AVG_COLOR = "#c9a24a"; // amber for the 5yr average line
const BAND_FILL = "rgba(138, 129, 117, 0.20)"; // muted shaded envelope

// Deterministic local fallback so the panel renders fully populated, even
// offline. A realistic seasonal storage cycle ending mid-injection-season with
// a modest deficit to normal.

const FALLBACK: NatGasStorageResponse = (() => {
  const TROUGH = 1750;
  const PEAK = 3750;
  const N = 60;
  const hash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  };
  const rand01 = (s: string): number => (hash(s) % 1_000_000) / 1_000_000;
  const seasonal = (woy: number): number => {
    const phase = ((woy - 13) / 52) * 2 * Math.PI;
    return (PEAK + TROUGH) / 2 - ((PEAK - TROUGH) / 2) * Math.cos(phase);
  };
  const weekOfYear = (d: Date): number => {
    const onejan = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
  };
  const today = new Date();
  const history: StorageWeek[] = [];
  for (let i = 0; i < N; i++) {
    const wk = new Date(today.getTime() - (N - 1 - i) * 7 * 86400000);
    const woy = weekOfYear(wk);
    const avg = seasonal(woy);
    const spread = 180 + 90 * Math.abs(Math.sin(((woy - 13) / 52) * 2 * Math.PI));
    const iso = wk.toISOString().slice(0, 10);
    const drift = i / (N - 1) - 0.5;
    let dev = -160 * drift + (rand01(iso) - 0.5) * 70;
    dev = Math.max(-spread * 0.95, Math.min(spread * 0.95, dev));
    history.push({
      week: iso,
      level: Math.round((avg + dev) * 10) / 10,
      avg: Math.round(avg * 10) / 10,
      min: Math.round((avg - spread) * 10) / 10,
      max: Math.round((avg + spread) * 10) / 10,
    });
  }
  const last = history[N - 1];
  const prior = history[N - 2];
  const current = last.level as number;
  const avg = last.avg as number;
  const surplus = Math.round((current - avg) * 10) / 10;
  const pct = Math.round((surplus / avg) * 1000) / 10;
  const change = Math.round((current - (prior.level as number)) * 10) / 10;
  const status = pct > 1 ? "Surplus" : pct < -1 ? "Deficit" : "Normal";
  const flow = change >= 0 ? "injection" : "withdrawal";
  const vsNormal =
    status === "Normal"
      ? "essentially in line with the 5-year average"
      : `${Math.abs(surplus).toFixed(0)} Bcf (${Math.abs(pct).toFixed(1)}%) ${status === "Surplus" ? "above" : "below"} the 5-year average`;
  return {
    current_bcf: current,
    prior_bcf: prior.level,
    weekly_change: change,
    five_yr_avg_bcf: avg,
    five_yr_min_bcf: last.min,
    five_yr_max_bcf: last.max,
    surplus_deficit_bcf: surplus,
    surplus_deficit_pct: pct,
    status,
    history,
    summary: {
      headline: `Working gas at ${current.toLocaleString()} Bcf, a ${Math.abs(change).toFixed(0)} Bcf weekly ${flow}; ${vsNormal}.`,
      vs_normal: vsNormal,
      trend: flow,
    },
    data_mode: "sample",
    as_of: last.week,
    source: "curated",
  };
})();

// Formatting helpers

function fmtBcf(v: number | null): string {
  return v == null ? "--" : Math.round(v).toLocaleString();
}

function fmtSigned(v: number | null): string {
  if (v == null) return "--";
  return (v >= 0 ? "+" : "") + Math.round(v).toLocaleString();
}

function fmtPct(v: number | null): string {
  if (v == null) return "";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

function fmtMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short" });
}

// Panel

export function NatGasStoragePanel() {
  const [data, setData] = useState<NatGasStorageResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/natgas-storage")
      .then((res) => res.json())
      .then((json: NatGasStorageResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.history) && json.history.length > 0) {
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

  const { history, summary, status } = data;

  // Y-domain across the whole seasonal band so the envelope always fits.
  const domain = useMemo(() => {
    const lows: number[] = [];
    const highs: number[] = [];
    for (const h of history) {
      if (h.min != null) lows.push(h.min);
      if (h.max != null) highs.push(h.max);
      if (h.level != null) {
        lows.push(h.level);
        highs.push(h.level);
      }
    }
    const lo = lows.length ? Math.min(...lows) : 0;
    const hi = highs.length ? Math.max(...highs) : 1;
    const pad = (hi - lo) * 0.08 || 1;
    return { lo: lo - pad, hi: hi + pad };
  }, [history]);

  // Map a Bcf value to a top% (0 = top of plot, 100 = bottom).
  const yPct = (v: number): number => {
    const t = (v - domain.lo) / (domain.hi - domain.lo);
    return (1 - Math.max(0, Math.min(1, t))) * 100;
  };

  const surplusGreen = (data.surplus_deficit_bcf ?? 0) >= 0;
  const flowInjection = (data.weekly_change ?? 0) >= 0;

  // Month gridline labels (first week whose month differs from the prior one).
  const monthMarks = useMemo(() => {
    const marks: Array<{ i: number; label: string }> = [];
    let prevMonth = "";
    history.forEach((h, i) => {
      const m = fmtMonth(h.week);
      if (m !== prevMonth) {
        marks.push({ i, label: m });
        prevMonth = m;
      }
    });
    return marks;
  }, [history]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>NAT-GAS STORAGE vs 5-YEAR BAND</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-2">
          <KpiCell label="Working Gas">
            <span className="stat-figure text-3xl tabular-nums text-terminal-text leading-none">
              {fmtBcf(data.current_bcf)}
            </span>
            <span className="text-2xs text-terminal-dim">Bcf, Lower 48</span>
          </KpiCell>
          <KpiCell label="vs 5yr Avg">
            <span className={`stat-figure text-3xl tabular-nums leading-none ${statusTextClass(status)}`}>
              {fmtSigned(data.surplus_deficit_bcf)}
            </span>
            <span className={`text-2xs ${surplusGreen ? "text-accent-green" : "text-accent-red"}`}>
              {fmtPct(data.surplus_deficit_pct)} {surplusGreen ? "surplus" : "deficit"}
            </span>
          </KpiCell>
          <KpiCell label="Weekly Change">
            <span
              className="stat-figure text-3xl tabular-nums leading-none"
              style={{ color: flowInjection ? "#6f8f5a" : "#c2603f" }}
            >
              {fmtSigned(data.weekly_change)}
            </span>
            <span className="text-2xs text-terminal-dim">
              Bcf {flowInjection ? "injection" : "withdrawal"}
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner + status pill */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex items-start justify-between gap-3">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            {summary.headline} Storage below the 5-year average is bullish for gas; a surplus is bearish.
          </p>
          <span
            className="pill uppercase tracking-wider shrink-0"
            style={statusPillStyle(status)}
          >
            {status}
          </span>
        </div>

        {/* HERO: seasonal band chart (CSS, no charting lib) */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>5yr min/max envelope, average line, current-year level</SectionLabel>
            <span className="text-2xs text-terminal-dim tabular-nums">
              {fmtBcf(domain.hi)} - {fmtBcf(domain.lo)} Bcf
            </span>
          </div>

          <div className="relative flex-1 min-h-[150px] mt-1">
            {/* horizontal reference gridlines */}
            {[0.25, 0.5, 0.75].map((g) => (
              <div
                key={g}
                className="absolute left-0 right-0 border-t border-terminal-divider/30"
                style={{ top: `${g * 100}%` }}
              />
            ))}

            {/* per-week columns: shaded band + avg tick + current dot */}
            {history.map((h, i) => {
              const left = (i / Math.max(1, history.length - 1)) * 100;
              const colW = 100 / history.length;
              return (
                <div
                  key={h.week}
                  className="absolute inset-y-0"
                  style={{ left: `${left}%`, width: `${colW}%`, transform: "translateX(-50%)" }}
                >
                  {/* envelope band (min -> max) */}
                  {h.min != null && h.max != null && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2"
                      style={{
                        top: `${yPct(h.max)}%`,
                        height: `${Math.max(0.5, yPct(h.min) - yPct(h.max))}%`,
                        width: "100%",
                        backgroundColor: BAND_FILL,
                      }}
                    />
                  )}
                  {/* 5yr average line (per-column tick merges into a line) */}
                  {h.avg != null && (
                    <div
                      className="absolute left-0 right-0"
                      style={{ top: `${yPct(h.avg)}%`, height: "1.5px", backgroundColor: AVG_COLOR, opacity: 0.85 }}
                    />
                  )}
                  {/* current-year level dot */}
                  {h.level != null && (
                    <div
                      className="absolute left-1/2 rounded-full"
                      style={{
                        top: `${yPct(h.level)}%`,
                        width: "3px",
                        height: "3px",
                        transform: "translate(-50%, -50%)",
                        backgroundColor: CURRENT_COLOR,
                      }}
                      title={`${h.week}: ${fmtBcf(h.level)} Bcf`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* month axis */}
          <div className="relative h-3.5 mt-1 border-t border-terminal-divider">
            {monthMarks.map((m) => (
              <span
                key={`${m.label}-${m.i}`}
                className="absolute text-2xs text-terminal-dim tabular-nums -translate-x-1/2"
                style={{ left: `${(m.i / Math.max(1, history.length - 1)) * 100}%`, top: "2px" }}
              >
                {m.label}
              </span>
            ))}
          </div>
        </div>

        {/* Footer legend + source note */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-3">
            <LegendSwatch color={CURRENT_COLOR} label="Current year" />
            <LegendSwatch color={AVG_COLOR} label="5yr average" />
            <LegendSwatch color="#8a8175" label="5yr min/max band" />
          </div>
          <span className="uppercase tracking-wider">
            {data.data_mode === "live"
              ? "Source: EIA weekly working-gas-in-storage (Lower 48)"
              : "Working gas in storage, Lower 48"}
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function KpiCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className="flex flex-col gap-0.5 min-w-0">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-2xs text-terminal-muted uppercase tracking-wider">{children}</div>
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
