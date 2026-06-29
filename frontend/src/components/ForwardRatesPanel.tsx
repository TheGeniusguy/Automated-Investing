import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface SpotPoint {
  tenor_label: string;
  years: number;
  rate: number;
}

interface ForwardCell {
  tenor_label: string;
  tenor_years: number;
  forward_rate: number;
  vs_spot: number;
}

interface ForwardRow {
  start_years: number;
  start_label: string;
  cells: ForwardCell[];
}

interface HeadlineForward {
  label: string;
  forward_rate: number;
  spot_rate: number;
  vs_spot: number;
}

interface ForwardSummary {
  curve_shape: string;
  max_forward: { label: string; rate: number | null };
  steepest_segment: { segment: string | null; change_bps: number | null };
}

interface ForwardRatesResponse {
  spot_curve: SpotPoint[];
  forward_matrix: ForwardRow[];
  headline_forwards: HeadlineForward[];
  summary: ForwardSummary;
  data_mode: string;
  as_of: string;
  source: string;
}

// Heat shading: cool (low rate) -> warm (high rate) across the forward grid.
// Mirrors NewsHeatPanel's inline-style heat ramp using the warm ink palette.
function rateColor(rate: number, lo: number, hi: number): string {
  if (!Number.isFinite(rate)) return "#5c554b";
  const t = hi > lo ? Math.max(0, Math.min(1, (rate - lo) / (hi - lo))) : 0.5;
  // Cool slate-blue -> neutral stone -> clay/amber -> deep red.
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [74, 92, 110]], // cool slate
    [0.4, [138, 129, 117]], // neutral stone
    [0.7, [201, 162, 74]], // amber
    [1.0, [194, 96, 63]], // clay red
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const w = (t - a[0]) / span;
  const ch = (i: number) => Math.round(a[1][i] + w * (b[1][i] - a[1][i]));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

// vs-spot delta color: forward above spot = green (hikes priced), below = red.
function deltaClass(vs: number): string {
  if (vs > 0.03) return "text-accent-green";
  if (vs < -0.03) return "text-accent-red";
  return "text-terminal-dim";
}

function shapePillStyle(shape: string): CSSProperties {
  switch (shape) {
    case "inverted":
      return { color: "#c2603f", borderColor: "#c2603f" };
    case "steep":
      return { color: "#7a9b76", borderColor: "#5c7a58" };
    case "flat":
      return { color: "#c9a24a", borderColor: "#c9a24a" };
    default:
      return { color: "#a59c8e", borderColor: "#5c554b" };
  }
}

// Local fallback so the panel renders fully populated, even offline.
// A realistic slightly-inverted-front spot curve bootstrapped to forwards.
const FALLBACK: ForwardRatesResponse = (() => {
  const spot: Array<[string, number, number]> = [
    ["1M", 1 / 12, 4.85],
    ["3M", 0.25, 4.7],
    ["6M", 0.5, 4.52],
    ["1Y", 1.0, 4.32],
    ["2Y", 2.0, 4.12],
    ["3Y", 3.0, 4.08],
    ["5Y", 5.0, 4.14],
    ["7Y", 7.0, 4.26],
    ["10Y", 10.0, 4.38],
    ["20Y", 20.0, 4.66],
    ["30Y", 30.0, 4.58],
  ];
  const curve = spot.map(([, y, r]) => [y, r] as [number, number]);
  const zero = (t: number): number => {
    if (t <= curve[0][0]) return curve[0][1];
    if (t >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (let i = 0; i < curve.length - 1; i++) {
      const [x0, y0] = curve[i];
      const [x1, y1] = curve[i + 1];
      if (x0 <= t && t <= x1) return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
    }
    return curve[curve.length - 1][1];
  };
  const fwd = (t1: number, t2: number): number =>
    t2 <= t1 ? zero(t2) : (zero(t2) * t2 - zero(t1) * t1) / (t2 - t1);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  const startYears: Array<[number, string]> = [
    [0, "Spot"],
    [1, "1Y"],
    [2, "2Y"],
    [3, "3Y"],
    [5, "5Y"],
    [7, "7Y"],
    [10, "10Y"],
  ];
  const tenors: Array<[number, string]> = [
    [1, "1Y"],
    [2, "2Y"],
    [3, "3Y"],
    [5, "5Y"],
    [10, "10Y"],
  ];
  const forward_matrix: ForwardRow[] = startYears.map(([sy, sl]) => ({
    start_years: sy,
    start_label: sl,
    cells: tenors.map(([ty, tl]) => {
      const f = r3(fwd(sy, sy + ty));
      return { tenor_label: tl, tenor_years: ty, forward_rate: f, vs_spot: r3(f - zero(ty)) };
    }),
  }));
  const headline: Array<[number, number, string]> = [
    [1, 1, "1y1y"],
    [2, 1, "2y1y"],
    [3, 2, "3y2y"],
    [5, 5, "5y5y"],
    [1, 9, "1y9y"],
  ];
  const headline_forwards: HeadlineForward[] = headline.map(([sy, ty, lbl]) => {
    const f = r3(fwd(sy, sy + ty));
    const s = r3(zero(ty));
    return { label: lbl, forward_rate: f, spot_rate: s, vs_spot: r3(f - s) };
  });
  return {
    spot_curve: spot.map(([tenor_label, years, rate]) => ({ tenor_label, years, rate })),
    forward_matrix,
    headline_forwards,
    summary: {
      curve_shape: "inverted",
      max_forward: { label: "10y10y", rate: r3(fwd(10, 20)) },
      steepest_segment: { segment: "spot 1Y -> 1y1y", change_bps: r3((fwd(1, 2) - fwd(0, 1)) * 100) },
    },
    data_mode: "sample",
    as_of: "",
    source: "curated",
  };
})();

// Formatting helpers

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "--" : `${v.toFixed(2)}%`;
}

function fmtDelta(v: number): string {
  const bps = Math.round(v * 100);
  return (bps >= 0 ? "+" : "") + bps + "bp";
}

// Panel

export function ForwardRatesPanel() {
  const [data, setData] = useState<ForwardRatesResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/forward-rates")
      .then((res) => res.json())
      .then((json: ForwardRatesResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.forward_matrix) && json.forward_matrix.length > 0) {
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

  const { spot_curve, forward_matrix, headline_forwards, summary } = data;
  const tenorCols = forward_matrix[0]?.cells ?? [];

  // Color scale spans the observed forward range so shading stays legible.
  const [lo, hi] = useMemo(() => {
    const all = forward_matrix.flatMap((r) => r.cells.map((c) => c.forward_rate)).filter(Number.isFinite);
    if (all.length === 0) return [3, 5];
    return [Math.min(...all), Math.max(...all)];
  }, [forward_matrix]);

  // Headline KPI strip shows the three marquee forwards.
  const kpis = useMemo(() => {
    const want = ["1y1y", "2y1y", "5y5y"];
    return want
      .map((w) => headline_forwards.find((h) => h.label === w))
      .filter((h): h is HeadlineForward => Boolean(h));
  }, [headline_forwards]);

  const spotLo = useMemo(
    () => Math.min(...spot_curve.map((p) => p.rate).filter(Number.isFinite), 3),
    [spot_curve]
  );
  const spotHi = useMemo(
    () => Math.max(...spot_curve.map((p) => p.rate).filter(Number.isFinite), 5),
    [spot_curve]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>IMPLIED FORWARD-RATE MATRIX</span>
        {loading && (
          <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip: marquee forwards vs spot */}
        <div className="grid grid-cols-3 gap-2">
          {kpis.map((h) => (
            <KpiCell key={h.label} label={h.label.replace(/(\d+)y(\d+)y/, "$1y$2y forward")}>
              <span className="stat-figure text-3xl tabular-nums text-terminal-text leading-none">
                {fmtPct(h.forward_rate)}
              </span>
              <span className={`text-2xs tabular-nums ${deltaClass(h.vs_spot)}`}>
                {fmtDelta(h.vs_spot)} vs {fmtPct(h.spot_rate)} spot
              </span>
            </KpiCell>
          ))}
        </div>

        {/* Plain-language one-liner + shape pill */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex items-start justify-between gap-3">
          <p className="text-sm text-terminal-text font-serif leading-snug">
            Each cell is the rate the market is pricing <em>today</em> for a future window. A forward
            above the equivalent-tenor spot prices hikes / steepening; below spot prices cuts.
          </p>
          <span className="pill uppercase tracking-wider shrink-0 mt-0.5" style={shapePillStyle(summary.curve_shape)}>
            {summary.curve_shape}
          </span>
        </div>

        {/* HERO: forward-rate heatmap matrix */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex-1 min-h-0">
          {/* Column header: start label + one column per tenor */}
          <div
            className="grid items-center gap-1 pb-1.5 mb-1 border-b border-terminal-divider"
            style={{ gridTemplateColumns: `64px repeat(${tenorCols.length}, 1fr)` }}
          >
            <SectionLabel>Start \ Tenor</SectionLabel>
            {tenorCols.map((c) => (
              <SectionLabel key={c.tenor_label} center>
                {c.tenor_label}
              </SectionLabel>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            {forward_matrix.map((row) => (
              <div
                key={row.start_label}
                className="grid items-stretch gap-1"
                style={{ gridTemplateColumns: `64px repeat(${row.cells.length}, 1fr)` }}
              >
                <div className="flex items-center">
                  <span className="font-mono text-xs text-terminal-muted font-semibold">
                    {row.start_label}
                  </span>
                </div>
                {row.cells.map((cell) => (
                  <ForwardCellBox key={cell.tenor_label} cell={cell} lo={lo} hi={hi} spotRow={row.start_years === 0} />
                ))}
              </div>
            ))}
          </div>

          {/* Spot-curve reference row */}
          <div className="mt-2.5 pt-2 border-t border-terminal-divider">
            <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">
              Spot Treasury curve (bootstrap source)
            </div>
            <div className="flex items-stretch gap-1">
              {spot_curve.map((p) => (
                <div key={p.tenor_label} className="flex-1 flex flex-col items-center min-w-0">
                  <div
                    className="w-full h-5 rounded-sm flex items-center justify-center"
                    style={{ backgroundColor: rateColor(p.rate, spotLo, spotHi) }}
                  >
                    <span className="text-2xs font-mono tabular-nums text-terminal-bg font-semibold">
                      {p.rate.toFixed(2)}
                    </span>
                  </div>
                  <span className="text-2xs text-terminal-dim mt-0.5 truncate">{p.tenor_label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer legend + summary readout */}
        <div className="flex items-center justify-between text-2xs text-terminal-dim">
          <div className="flex items-center gap-2">
            <span className="uppercase tracking-wider">Low</span>
            <span className="inline-flex h-2.5 w-28 rounded-sm overflow-hidden">
              {Array.from({ length: 24 }).map((_, i) => (
                <span key={i} className="flex-1" style={{ backgroundColor: rateColor(i / 23, 0, 1) }} />
              ))}
            </span>
            <span className="uppercase tracking-wider">High</span>
          </div>
          <span className="uppercase tracking-wider">
            Steepest: {summary.steepest_segment.segment ?? "--"}
            {summary.steepest_segment.change_bps !== null
              ? ` (${summary.steepest_segment.change_bps >= 0 ? "+" : ""}${summary.steepest_segment.change_bps}bp)`
              : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function ForwardCellBox({ cell, lo, hi, spotRow }: { cell: ForwardCell; lo: number; hi: number; spotRow: boolean }) {
  const bg = rateColor(cell.forward_rate, lo, hi);
  return (
    <div
      className="rounded-sm px-1 py-1 flex flex-col items-center justify-center leading-tight"
      style={{ backgroundColor: bg, opacity: spotRow ? 0.82 : 1 }}
      title={`${cell.tenor_label} forward: ${cell.forward_rate.toFixed(2)}% (${fmtDelta(cell.vs_spot)} vs spot)`}
    >
      <span className="font-mono text-xs tabular-nums text-terminal-bg font-semibold">
        {cell.forward_rate.toFixed(2)}
      </span>
      <span
        className="text-2xs tabular-nums font-semibold"
        style={{ color: cell.vs_spot > 0.03 ? "#1c3a1c" : cell.vs_spot < -0.03 ? "#4a1410" : "#2a2620" }}
      >
        {fmtDelta(cell.vs_spot)}
      </span>
    </div>
  );
}

function KpiCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider truncate">{label}</div>
      <div className="flex flex-col gap-0.5 min-w-0">{children}</div>
    </div>
  );
}

function SectionLabel({ children, center }: { children: ReactNode; center?: boolean }) {
  return (
    <div className={`text-2xs text-terminal-muted uppercase tracking-wider ${center ? "text-center" : ""}`}>
      {children}
    </div>
  );
}
