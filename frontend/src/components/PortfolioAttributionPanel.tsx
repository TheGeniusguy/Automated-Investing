import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface SectorRow {
  sector: string;
  w_port: number;   // fraction 0..1
  w_bench: number;  // fraction 0..1
  r_port: number;   // percent
  r_bench: number;  // percent
  allocation: number;   // percent contribution
  selection: number;    // percent contribution
  interaction: number;  // percent contribution
  total: number;        // percent = allocation + selection + interaction
}

interface AttributionTotals {
  allocation: number;
  selection: number;
  interaction: number;
  active_return: number;
  port_return: number;
  bench_return: number;
}

interface AttributionSummary {
  best_sector: string | null;
  worst_sector: string | null;
  dominant_effect: string;
}

interface AttributionResponse {
  portfolio_id: number | null;
  period_label: string;
  sectors: SectorRow[];
  totals: AttributionTotals;
  summary: AttributionSummary;
  spy_actual_return: number | null;
  data_mode: string;
  as_of: string;
  source: string;
}

// Local fallback so the panel renders fully populated, even offline. Built from
// the same Brinson-Fachler raw inputs the backend ships, normalized and
// decomposed in-place so it reconciles exactly.

const FALLBACK: AttributionResponse = (() => {
  // (sector, w_port, w_bench, r_port decimal, r_bench decimal)
  const seed: Array<[string, number, number, number, number]> = [
    ["Technology", 0.34, 0.29, 0.078, 0.065],
    ["Financials", 0.1, 0.13, 0.032, 0.041],
    ["Health Care", 0.08, 0.12, 0.015, 0.021],
    ["Consumer Discretionary", 0.12, 0.105, 0.054, 0.047],
    ["Communication Services", 0.11, 0.087, 0.09, 0.072],
    ["Industrials", 0.07, 0.083, 0.038, 0.035],
    ["Consumer Staples", 0.04, 0.06, 0.012, 0.01],
    ["Energy", 0.05, 0.038, -0.025, -0.018],
    ["Utilities", 0.03, 0.025, 0.02, 0.016],
    ["Real Estate", 0.02, 0.022, -0.01, -0.005],
    ["Materials", 0.04, 0.022, 0.028, 0.022],
  ];
  const wpTot = seed.reduce((s, r) => s + r[1], 0) || 1;
  const wbTot = seed.reduce((s, r) => s + r[2], 0) || 1;
  const norm = seed.map(([sec, wp, wb, rp, rb]) => ({
    sec,
    wp: wp / wpTot,
    wb: wb / wbTot,
    rp,
    rb,
  }));
  const benchRet = norm.reduce((s, r) => s + r.wb * r.rb, 0);
  const portRet = norm.reduce((s, r) => s + r.wp * r.rp, 0);
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  let ta = 0;
  let ts = 0;
  let ti = 0;
  const sectors: SectorRow[] = norm.map((r) => {
    const dw = r.wp - r.wb;
    const alloc = dw * (r.rb - benchRet);
    const sel = r.wb * (r.rp - r.rb);
    const inter = dw * (r.rp - r.rb);
    ta += alloc;
    ts += sel;
    ti += inter;
    return {
      sector: r.sec,
      w_port: r4(r.wp),
      w_bench: r4(r.wb),
      r_port: r4(r.rp * 100),
      r_bench: r4(r.rb * 100),
      allocation: r4(alloc * 100),
      selection: r4(sel * 100),
      interaction: r4(inter * 100),
      total: r4((alloc + sel + inter) * 100),
    };
  });
  const best = sectors.reduce((a, b) => (b.total > a.total ? b : a));
  const worst = sectors.reduce((a, b) => (b.total < a.total ? b : a));
  const effects: Record<string, number> = {
    Allocation: Math.abs(ta),
    Selection: Math.abs(ts),
    Interaction: Math.abs(ti),
  };
  const dominant = Object.keys(effects).reduce((a, b) => (effects[b] > effects[a] ? b : a));
  return {
    portfolio_id: null,
    period_label: "Trailing 3M (~63 trading days)",
    sectors,
    totals: {
      allocation: r4(ta * 100),
      selection: r4(ts * 100),
      interaction: r4(ti * 100),
      active_return: r4((portRet - benchRet) * 100),
      port_return: r4(portRet * 100),
      bench_return: r4(benchRet * 100),
    },
    summary: { best_sector: best.sector, worst_sector: worst.sector, dominant_effect: dominant },
    spy_actual_return: null,
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting + color helpers

function fmtPct(v: number, digits = 2): string {
  return `${v.toFixed(digits)}%`;
}

function fmtBps(v: number): string {
  const bps = v * 100; // percent -> basis points
  return `${bps >= 0 ? "+" : ""}${bps.toFixed(0)}bp`;
}

function fmtSignedPct(v: number, digits = 2): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function effectClass(v: number): string {
  if (v > 0.0005) return "text-accent-green";
  if (v < -0.0005) return "text-accent-red";
  return "text-terminal-dim";
}

function effectColor(v: number): string {
  if (v > 0.0005) return "#5b8a5a"; // muted green (positive contribution)
  if (v < -0.0005) return "#c2603f"; // clay-red (negative contribution)
  return "#8a8175"; // neutral
}

// Panel

export function PortfolioAttributionPanel() {
  const [data, setData] = useState<AttributionResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/attribution")
      .then((res) => res.json())
      .then((json: AttributionResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.sectors) && json.sectors.length > 0) {
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

  const { sectors, totals, summary } = data;

  // Scale the per-sector total-active bars to the largest absolute contribution.
  const maxAbsTotal = useMemo(
    () => Math.max(0.05, ...sectors.map((s) => Math.abs(s.total))),
    [sectors]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>PERFORMANCE ATTRIBUTION</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <KpiCell label="Active Return">
            <span className={`stat-figure text-3xl tabular-nums ${effectClass(totals.active_return / 100)}`}>
              {fmtSignedPct(totals.active_return)}
            </span>
            <span className="text-2xs text-terminal-dim">
              port {fmtPct(totals.port_return)} vs bench {fmtPct(totals.bench_return)}
            </span>
          </KpiCell>
          <KpiCell label="Dominant Effect">
            <span className="stat-figure text-3xl text-accent-amber leading-none truncate">
              {summary.dominant_effect}
            </span>
            <span className="text-2xs text-terminal-dim truncate">largest driver of active</span>
          </KpiCell>
          <KpiCell label="Best Sector">
            <span className="stat-figure text-2xl text-accent-green leading-none truncate">
              {summary.best_sector ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {bestWorstContribution(sectors, summary.best_sector)}
            </span>
          </KpiCell>
          <KpiCell label="Worst Sector">
            <span className="stat-figure text-2xl text-accent-red leading-none truncate">
              {summary.worst_sector ?? "--"}
            </span>
            <span className="text-2xs text-terminal-dim truncate">
              {bestWorstContribution(sectors, summary.worst_sector)}
            </span>
          </KpiCell>
        </div>

        {/* Plain-language one-liner */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Brinson-Fachler splits the portfolio's active return versus the S&amp;P 500 into where you
            placed your bets (allocation), what you owned inside each sector (selection), and the
            cross term (interaction). {data.period_label}.
          </p>
        </div>

        {/* HERO: per-sector attribution table */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header */}
          <div className="grid grid-cols-[150px_84px_84px_72px_72px_72px_1fr] items-center gap-2 pb-1.5 mb-1 border-b border-terminal-divider">
            <SectionLabel>Sector</SectionLabel>
            <SectionLabel right>Wt P / B</SectionLabel>
            <SectionLabel right>Ret P / B</SectionLabel>
            <SectionLabel right>Alloc</SectionLabel>
            <SectionLabel right>Select</SectionLabel>
            <SectionLabel right>Interact</SectionLabel>
            <SectionLabel right>Total active</SectionLabel>
          </div>

          <div className="flex flex-col">
            {sectors.map((row) => (
              <AttributionRow key={row.sector} row={row} maxAbsTotal={maxAbsTotal} />
            ))}
          </div>

          {/* Totals reconciliation row */}
          <div className="grid grid-cols-[150px_84px_84px_72px_72px_72px_1fr] items-center gap-2 pt-2 mt-1 border-t border-terminal-divider">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider font-semibold">
              Total
            </span>
            <span />
            <span />
            <span className={`text-right font-mono tabular-nums text-xs font-semibold ${effectClass(totals.allocation / 100)}`}>
              {fmtSignedPct(totals.allocation)}
            </span>
            <span className={`text-right font-mono tabular-nums text-xs font-semibold ${effectClass(totals.selection / 100)}`}>
              {fmtSignedPct(totals.selection)}
            </span>
            <span className={`text-right font-mono tabular-nums text-xs font-semibold ${effectClass(totals.interaction / 100)}`}>
              {fmtSignedPct(totals.interaction)}
            </span>
            <span className="flex items-center justify-end gap-2">
              <span className="text-2xs text-terminal-dim normal-case">
                {fmtSignedPct(totals.allocation)} + {fmtSignedPct(totals.selection)} +{" "}
                {fmtSignedPct(totals.interaction)} =
              </span>
              <span className={`font-mono tabular-nums text-xs font-semibold ${effectClass(totals.active_return / 100)}`}>
                {fmtSignedPct(totals.active_return)}
              </span>
            </span>
          </div>
        </div>

        {/* Footer legend explaining the three effects */}
        <div className="flex flex-col gap-1 text-2xs text-terminal-dim">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <EffectNote label="Allocation" note="over/under-weighting a sector vs the benchmark" />
            <EffectNote label="Selection" note="picking holdings that beat the sector benchmark" />
            <EffectNote label="Interaction" note="active weight x active selection cross term" />
          </div>
          <span className="uppercase tracking-wider">
            Benchmark = SPY proxied by the 11 SPDR sector ETFs; effects reconcile exactly to active return
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function AttributionRow({ row, maxAbsTotal }: { row: SectorRow; maxAbsTotal: number }) {
  const pct = Math.max(2, Math.min(100, (Math.abs(row.total) / maxAbsTotal) * 100));
  const color = effectColor(row.total / 100);
  const positive = row.total >= 0;
  return (
    <div className="grid grid-cols-[150px_84px_84px_72px_72px_72px_1fr] items-center gap-2 py-1.5 border-b border-terminal-divider/40 last:border-0">
      {/* Sector name */}
      <span className="text-xs text-terminal-text font-medium truncate" title={row.sector}>
        {row.sector}
      </span>

      {/* Weight port / bench */}
      <div className="text-right font-mono tabular-nums text-2xs leading-tight">
        <span className="text-terminal-text">{(row.w_port * 100).toFixed(1)}</span>
        <span className="text-terminal-dim"> / {(row.w_bench * 100).toFixed(1)}</span>
      </div>

      {/* Return port / bench */}
      <div className="text-right font-mono tabular-nums text-2xs leading-tight">
        <span className="text-terminal-text">{row.r_port.toFixed(1)}</span>
        <span className="text-terminal-dim"> / {row.r_bench.toFixed(1)}</span>
      </div>

      {/* Allocation */}
      <span className={`text-right font-mono tabular-nums text-2xs ${effectClass(row.allocation / 100)}`}>
        {fmtBps(row.allocation)}
      </span>
      {/* Selection */}
      <span className={`text-right font-mono tabular-nums text-2xs ${effectClass(row.selection / 100)}`}>
        {fmtBps(row.selection)}
      </span>
      {/* Interaction */}
      <span className={`text-right font-mono tabular-nums text-2xs ${effectClass(row.interaction / 100)}`}>
        {fmtBps(row.interaction)}
      </span>

      {/* Total active bar (diverging from center) */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative flex-1 h-2.5 rounded-full bg-terminal-divider/50 overflow-hidden">
          <div className="absolute inset-y-0 left-1/2 w-px bg-terminal-muted/60" />
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              backgroundColor: color,
              width: `${pct / 2}%`,
              left: positive ? "50%" : undefined,
              right: positive ? undefined : "50%",
            }}
          />
        </div>
        <span
          className="w-14 text-right font-mono tabular-nums text-2xs font-semibold shrink-0"
          style={{ color }}
        >
          {fmtSignedPct(row.total)}
        </span>
      </div>
    </div>
  );
}

function bestWorstContribution(sectors: SectorRow[], sector: string | null): string {
  if (!sector) return "";
  const row = sectors.find((s) => s.sector === sector);
  return row ? `${fmtSignedPct(row.total)} to active` : "";
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

function EffectNote({ label, note }: { label: string; note: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-terminal-muted font-semibold uppercase tracking-wider">{label}</span>
      <span className="text-terminal-dim normal-case tracking-normal">{note}</span>
    </span>
  );
}
