import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";

/**
 * Bond Analytics Panel - YAS-style single-bond risk desk.
 *
 * Inputs form (face / coupon / maturity / freq / yield) posts to bondAnalyze.
 * A serif risk card shows price, YTM, durations, convexity, DV01. The
 * price-yield curve (TradingView line) shows the convexity bowl with the
 * current point marked. A rate-shock scenario table renders green/red P&L.
 * Clicking an issue-grid row (from bondUniverse) loads + analyzes that bond.
 */

// ───────── Response shapes (mirror backend bond_analytics.py) ─────────

interface BondUniverseRow {
  id: string;
  name: string;
  coupon: number;
  maturity: number;
  rating: string;
  price: number;
  ytm: number;
  duration: number;
  convexity: number;
  dv01: number;
}

interface BondUniverse {
  bonds: BondUniverseRow[];
  data_mode: string;
  as_of: string;
  source: string;
}

interface PriceYieldPoint {
  ytm: number;
  price: number;
}

interface ScenarioRow {
  shock_bps: number;
  new_yield: number;
  price: number;
  exact_price: number;
  price_change: number;
  pct_change: number;
}

interface BondAnalysis {
  price: number;
  ytm: number;
  mac_duration: number;
  mod_duration: number;
  convexity: number;
  dv01: number;
  price_yield_curve: PriceYieldPoint[];
  scenario_table: ScenarioRow[];
  data_mode: string;
  as_of: string;
  source: string;
}

interface FormState {
  face: string;
  coupon: string;
  maturity: string;
  freq: string;
  ytm: string;
}

const DEFAULT_FORM: FormState = {
  face: "1000",
  coupon: "4.000",
  maturity: "10",
  freq: "2",
  ytm: "4.250",
};

// ───────── Formatters ─────────

const fmtPrice = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : v.toFixed(3);
const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `${v.toFixed(3)}%`;
const fmtDur = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : v.toFixed(2);
const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `$${v.toFixed(2)}`;
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(3)}`;
const signedPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(3)}%`;

export function BondAnalyticsPanel() {
  const [universe, setUniverse] = useState<BondUniverse | null>(null);
  const [analysis, setAnalysis] = useState<BondAnalysis | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingUni, setLoadingUni] = useState(true);
  const [loadingAna, setLoadingAna] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Load the issue universe once.
  useEffect(() => {
    let alive = true;
    api
      .bondUniverse()
      .then((u: BondUniverse) => {
        if (alive) setUniverse(u);
      })
      .catch((e: unknown) => alive && setErr(String(e)))
      .finally(() => alive && setLoadingUni(false));
    return () => {
      alive = false;
    };
  }, []);

  // Analyze with the current form values.
  const runAnalyze = (f: FormState) => {
    const body = {
      face: Number(f.face) || 1000,
      coupon: Number(f.coupon) || 0,
      maturity: Number(f.maturity) || 1,
      freq: Number(f.freq) || 2,
      ytm: Number(f.ytm) || 0,
    };
    setLoadingAna(true);
    setErr(null);
    api
      .bondAnalyze(body)
      .then((a: BondAnalysis) => setAnalysis(a))
      .catch((e: unknown) => setErr(String(e)))
      .finally(() => setLoadingAna(false));
  };

  // Initial analysis on mount.
  useEffect(() => {
    runAnalyze(DEFAULT_FORM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onField = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const onAnalyzeClick = () => {
    setActiveId(null);
    runAnalyze(form);
  };

  const loadIssue = (b: BondUniverseRow) => {
    const next: FormState = {
      face: "1000",
      coupon: b.coupon.toFixed(3),
      maturity: String(b.maturity),
      freq: "2",
      ytm: b.ytm.toFixed(3),
    };
    setForm(next);
    setActiveId(b.id);
    runAnalyze(next);
  };

  if (err && !analysis) {
    return (
      <div className="panel h-full">
        <div className="panel-header">
          <span>Bond Analytics</span>
        </div>
        <div className="panel-body text-accent-red">! {err}</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2 h-full min-h-0">
      {/* Left column: inputs + risk card */}
      <div className="col-span-1 flex flex-col gap-2 min-h-0 overflow-auto">
        <InputsForm
          form={form}
          onField={onField}
          onAnalyze={onAnalyzeClick}
          loading={loadingAna}
        />
        <RiskCard analysis={analysis} loading={loadingAna} />
      </div>

      {/* Middle column: price-yield curve + scenario table */}
      <div className="col-span-1 flex flex-col gap-2 min-h-0">
        <PriceYieldChart analysis={analysis} />
        <ScenarioTable analysis={analysis} />
      </div>

      {/* Right column: issue grid */}
      <div className="col-span-1 flex flex-col min-h-0">
        <IssueGrid
          universe={universe}
          loading={loadingUni}
          activeId={activeId}
          onPick={loadIssue}
        />
      </div>
    </div>
  );
}

// ───────── Inputs form ─────────

function InputsForm({
  form,
  onField,
  onAnalyze,
  loading,
}: {
  form: FormState;
  onField: (k: keyof FormState, v: string) => void;
  onAnalyze: () => void;
  loading: boolean;
}) {
  const fields: { key: keyof FormState; label: string; step?: string }[] = [
    { key: "face", label: "Face", step: "100" },
    { key: "coupon", label: "Coupon %", step: "0.125" },
    { key: "maturity", label: "Maturity (yrs)", step: "1" },
    { key: "ytm", label: "Yield %", step: "0.05" },
  ];

  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Bond Inputs</span>
      </div>
      <div className="panel-body py-2">
        <div className="grid grid-cols-2 gap-2">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5">
              <span className="text-2xs text-terminal-muted uppercase tracking-wider">
                {f.label}
              </span>
              <input
                type="number"
                step={f.step}
                value={form[f.key]}
                onChange={(e) => onField(f.key, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onAnalyze()}
                className="bg-terminal-panel border border-terminal-divider text-sm text-terminal-text px-1.5 py-1 tabular-nums focus:border-accent-amber outline-none"
              />
            </label>
          ))}
          <label className="flex flex-col gap-0.5">
            <span className="text-2xs text-terminal-muted uppercase tracking-wider">
              Frequency
            </span>
            <select
              value={form.freq}
              onChange={(e) => onField("freq", e.target.value)}
              className="bg-terminal-panel border border-terminal-divider text-sm text-terminal-text px-1.5 py-1"
            >
              <option value="1">Annual</option>
              <option value="2">Semiannual</option>
              <option value="4">Quarterly</option>
              <option value="12">Monthly</option>
            </select>
          </label>
          <div className="flex flex-col justify-end">
            <button
              onClick={onAnalyze}
              disabled={loading}
              className="pill bg-accent-amber/20 text-accent-amber hover:bg-accent-amber/30 disabled:opacity-50 py-1.5 text-xs"
            >
              {loading ? "Pricing..." : "Analyze"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────── Risk card ─────────

function RiskCard({
  analysis,
  loading,
}: {
  analysis: BondAnalysis | null;
  loading: boolean;
}) {
  return (
    <div className="panel flex-1 min-h-0">
      <div className="panel-header">
        <span>Risk</span>
        {analysis && (
          <span className="normal-case tracking-normal text-2xs text-terminal-dim">
            {analysis.as_of?.slice(0, 10) ?? ""}
          </span>
        )}
      </div>
      <div className="panel-body py-3">
        {!analysis ? (
          <div className="text-terminal-dim text-xs">
            {loading ? "pricing..." : "no analysis"}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <HeroStat label="Price" value={fmtPrice(analysis.price)} accent />
            <HeroStat label="Yield to Maturity" value={fmtPct(analysis.ytm)} />
            <HeroStat
              label="Modified Duration"
              value={fmtDur(analysis.mod_duration)}
              suffix="yrs"
            />
            <HeroStat
              label="Macaulay Duration"
              value={fmtDur(analysis.mac_duration)}
              suffix="yrs"
            />
            <HeroStat label="Convexity" value={fmtDur(analysis.convexity)} />
            <HeroStat label="DV01" value={fmtMoney(analysis.dv01)} />
          </div>
        )}
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: string;
  suffix?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs text-terminal-muted uppercase tracking-wider">
        {label}
      </span>
      <span
        className={
          "stat-figure font-serif text-3xl leading-none mt-1 tabular-nums " +
          (accent ? "text-accent-amber" : "text-terminal-text")
        }
      >
        {value}
        {suffix && (
          <span className="text-sm text-terminal-dim ml-1 font-sans">
            {suffix}
          </span>
        )}
      </span>
    </div>
  );
}

// ───────── Price-yield curve (TradingView line) ─────────

function PriceYieldChart({ analysis }: { analysis: BondAnalysis | null }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const curveRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markRef = useRef<ISeriesApi<"Line"> | null>(null);

  // ytm (percent) -> synthetic timestamp so the x-axis spaces by yield.
  const ytmToTime = (ytm: number) => Math.round(ytm * 1000) as UTCTimestamp;

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8b8b8b",
        fontFamily: "JetBrains Mono",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: "#1a1a1a" },
        horzLines: { color: "#1a1a1a" },
      },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: {
        borderColor: "#262626",
        timeVisible: false,
        tickMarkFormatter: (t: number) => `${(t / 1000).toFixed(2)}%`,
      },
      localization: {
        timeFormatter: (t: number) => `ytm ${(t / 1000).toFixed(3)}%`,
      },
      autoSize: true,
      crosshair: { mode: 1 },
    });
    const curve = chart.addSeries(LineSeries, {
      color: "#ffb800",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const mark = chart.addSeries(LineSeries, {
      color: "#60a5fa",
      lineWidth: 1,
      pointMarkersVisible: true,
      pointMarkersRadius: 6,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chartRef.current = chart;
    curveRef.current = curve;
    markRef.current = mark;
    return () => {
      chart.remove();
      chartRef.current = null;
      curveRef.current = null;
      markRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!curveRef.current || !markRef.current || !analysis) return;
    const pts = [...analysis.price_yield_curve]
      .filter((p) => p && p.ytm !== null && p.price !== null)
      .sort((a, b) => a.ytm - b.ytm)
      .map((p) => ({ time: ytmToTime(p.ytm), value: p.price }));
    // De-dupe identical timestamps (lightweight-charts requires unique, ascending).
    const seen = new Set<number>();
    const clean = pts.filter((p) => {
      if (seen.has(p.time as number)) return false;
      seen.add(p.time as number);
      return true;
    });
    curveRef.current.setData(clean);
    markRef.current.setData([
      { time: ytmToTime(analysis.ytm), value: analysis.price },
    ]);
    chartRef.current?.timeScale().fitContent();
  }, [analysis]);

  return (
    <div className="panel flex-1 min-h-0 flex flex-col">
      <div className="panel-header">
        <span>Price / Yield Curve</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-[#ffb800]" /> curve
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#60a5fa]" /> current
          </span>
        </span>
      </div>
      <div className="panel-body flex-1 min-h-0 p-0">
        <div ref={elRef} className="w-full h-full min-h-[140px]" />
      </div>
    </div>
  );
}

// ───────── Rate-shock scenario table ─────────

function ScenarioTable({ analysis }: { analysis: BondAnalysis | null }) {
  return (
    <div className="panel" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <span>Rate Shock Scenarios</span>
      </div>
      <div className="panel-body py-1 overflow-auto max-h-48">
        {!analysis ? (
          <div className="text-terminal-dim text-xs py-2">loading...</div>
        ) : (
          <table className="w-full text-2xs tabular-nums">
            <thead>
              <tr className="text-terminal-muted uppercase tracking-wider text-left">
                <th className="py-1 pr-2">Shock</th>
                <th className="py-1 pr-2 text-right">New Yld</th>
                <th className="py-1 pr-2 text-right">Price</th>
                <th className="py-1 pr-2 text-right">Chg</th>
                <th className="py-1 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {analysis.scenario_table.map((r) => {
                const up = r.price_change > 0;
                const flat = r.price_change === 0;
                const cls = flat
                  ? "text-terminal-text"
                  : up
                    ? "text-accent-green"
                    : "text-accent-red";
                return (
                  <tr
                    key={r.shock_bps}
                    className="border-t border-terminal-divider/40"
                  >
                    <td className="py-1 pr-2 text-terminal-text">
                      {r.shock_bps > 0 ? "+" : ""}
                      {r.shock_bps} bps
                    </td>
                    <td className="py-1 pr-2 text-right text-terminal-muted">
                      {fmtPct(r.new_yield)}
                    </td>
                    <td className="py-1 pr-2 text-right text-terminal-text">
                      {fmtPrice(r.price)}
                    </td>
                    <td className={"py-1 pr-2 text-right " + cls}>
                      {signed(r.price_change)}
                    </td>
                    <td className={"py-1 text-right " + cls}>
                      {signedPct(r.pct_change)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ───────── Sample issue grid ─────────

function IssueGrid({
  universe,
  loading,
  activeId,
  onPick,
}: {
  universe: BondUniverse | null;
  loading: boolean;
  activeId: string | null;
  onPick: (b: BondUniverseRow) => void;
}) {
  return (
    <div className="panel flex-1 min-h-0 flex flex-col">
      <div className="panel-header">
        <span>Issues</span>
        <span className="normal-case tracking-normal text-2xs text-terminal-dim">
          click to price
        </span>
      </div>
      <div className="panel-body p-0 flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="text-terminal-dim text-xs p-2">loading...</div>
        ) : !universe || universe.bonds.length === 0 ? (
          <div className="text-terminal-dim text-xs p-2">no issues</div>
        ) : (
          <table className="w-full text-2xs tabular-nums">
            <thead className="sticky top-0 bg-terminal-panel">
              <tr className="text-terminal-muted uppercase tracking-wider text-left">
                <th className="py-1 px-2">Issue</th>
                <th className="py-1 px-1 text-right">Cpn</th>
                <th className="py-1 px-1 text-right">Mty</th>
                <th className="py-1 px-1 text-center">Rtg</th>
                <th className="py-1 px-1 text-right">Px</th>
                <th className="py-1 px-1 text-right">YTM</th>
                <th className="py-1 px-1 text-right">Dur</th>
                <th className="py-1 px-2 text-right">DV01</th>
              </tr>
            </thead>
            <tbody>
              {universe.bonds.map((b) => {
                const active = b.id === activeId;
                return (
                  <tr
                    key={b.id}
                    onClick={() => onPick(b)}
                    className={
                      "border-t border-terminal-divider/40 cursor-pointer hover:bg-accent-amber/10 " +
                      (active ? "bg-accent-amber/15" : "")
                    }
                  >
                    <td className="py-1 px-2 text-terminal-text font-sans normal-case whitespace-nowrap">
                      {b.name}
                    </td>
                    <td className="py-1 px-1 text-right text-terminal-muted">
                      {b.coupon.toFixed(2)}
                    </td>
                    <td className="py-1 px-1 text-right text-terminal-muted">
                      {b.maturity}y
                    </td>
                    <td className="py-1 px-1 text-center text-accent-blue">
                      {b.rating}
                    </td>
                    <td className="py-1 px-1 text-right text-terminal-text">
                      {fmtPrice(b.price)}
                    </td>
                    <td className="py-1 px-1 text-right text-accent-amber">
                      {b.ytm.toFixed(3)}
                    </td>
                    <td className="py-1 px-1 text-right text-terminal-muted">
                      {fmtDur(b.duration)}
                    </td>
                    <td className="py-1 px-2 text-right text-terminal-muted">
                      {fmtMoney(b.dv01)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
