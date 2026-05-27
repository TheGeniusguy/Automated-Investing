import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { etfApi } from "../api/client";
import type {
  CompareInvestmentsResponse,
  CustomCashflow,
  InvestmentMetricsRow,
  InvestmentSpec,
} from "../api/types";

// ── Shared color palette ──────────────────────────────────────────────────────
const PALETTE = [
  "#00ff88",
  "#60a5fa",
  "#f59e0b",
  "#f87171",
  "#a78bfa",
  "#34d399",
  "#fb923c",
  "#e879f9",
];

type Kind = InvestmentSpec["kind"];

const KIND_LABELS: Record<Kind, string> = {
  real_estate: "Real Estate",
  market: "Stock / ETF",
  custom: "Custom",
};

// ── Default factories — sensible so a first-time user can Compare immediately ──
let _id = 0;
const nextId = () => `inv-${++_id}`;

interface Row {
  id: string;
  spec: InvestmentSpec;
}

function defaultRealEstate(
  label = "Rental",
): Extract<InvestmentSpec, { kind: "real_estate" }> {
  return {
    kind: "real_estate",
    label,
    params: {
      purchase_price: 300000,
      down_payment_pct: 25,
      loan_rate: 6,
      loan_term_years: 30,
      monthly_rent: 2500,
      monthly_expenses: 600,
      vacancy_pct: 5,
      annual_appreciation_pct: 3,
      rent_growth_pct: 2,
      expense_growth_pct: 2,
      hold_years: 5,
      sale_cost_pct: 6,
      closing_cost_pct: 2,
    },
  };
}

function defaultMarket(
  label = "SPY",
  symbol = "SPY",
): Extract<InvestmentSpec, { kind: "market" }> {
  return {
    kind: "market",
    label,
    params: {
      symbol,
      initial_investment: 75000,
      hold_years: 5,
      monthly_contribution: 0,
      dividend_yield_pct: 1.3,
    },
  };
}

function defaultCustom(
  label = "Bond",
): Extract<InvestmentSpec, { kind: "custom" }> {
  const today = new Date();
  const term = new Date(today);
  term.setFullYear(term.getFullYear() + 5);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    kind: "custom",
    label,
    params: {
      initial_investment: 75000,
      cashflows: [{ date: iso(term), amount: 90000 }],
      terminal_value: 0,
      hold_years: 5,
    },
  };
}

const INITIAL_ROWS: Row[] = [
  { id: nextId(), spec: defaultRealEstate("Rental") },
  { id: nextId(), spec: defaultMarket("SPY", "SPY") },
  { id: nextId(), spec: defaultCustom("Bond") },
];

export function InvestmentComparePanel() {
  const [rows, setRows] = useState<Row[]>(INITIAL_ROWS);
  const [data, setData] = useState<CompareInvestmentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runCompare = (current: Row[]) => {
    const specs = current.map((r) => r.spec);
    if (specs.length === 0) {
      setErr("Add at least one investment.");
      return;
    }
    setLoading(true);
    setErr(null);
    etfApi
      .compareInvestments(specs)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  // Initial load so the panel shows a real comparison on first paint.
  useEffect(() => {
    runCompare(INITIAL_ROWS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const colorByLabel = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r, i) => m.set(r.spec.label, PALETTE[i % PALETTE.length]));
    return m;
  }, [rows]);

  const addRow = (kind: Kind) => {
    setRows((prev) => {
      const n = prev.length + 1;
      let spec: InvestmentSpec;
      if (kind === "real_estate") spec = defaultRealEstate(`Property ${n}`);
      else if (kind === "market") spec = defaultMarket(`Position ${n}`, "QQQ");
      else spec = defaultCustom(`Custom ${n}`);
      return [...prev, { id: nextId(), spec }];
    });
  };

  const removeRow = (id: string) =>
    setRows((prev) => prev.filter((r) => r.id !== id));

  const updateRow = (id: string, spec: InvestmentSpec) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, spec } : r)));

  const summary = useMemo(() => buildSummary(data), [data]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">
          Investment Comparator
        </span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Intro */}
        <div className="text-2xs text-terminal-dim">
          Compare returns across asset classes side by side — a rental, a stock
          or ETF, and a custom deal — on one normalized growth chart and metrics
          table.
        </div>

        {/* Builder */}
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <InvestmentBuilder
              key={row.id}
              spec={row.spec}
              color={PALETTE[i % PALETTE.length]}
              onChange={(s) => updateRow(row.id, s)}
              onRemove={() => removeRow(row.id)}
              canRemove={rows.length > 1}
            />
          ))}
        </div>

        {/* Add + Compare controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xs text-terminal-dim uppercase mr-1">Add:</span>
          {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => addRow(k)}
              className="pill text-2xs text-terminal-dim hover:text-terminal-fg"
            >
              + {KIND_LABELS[k]}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => runCompare(rows)}
            disabled={loading}
            className="pill text-2xs bg-accent text-black disabled:opacity-40"
          >
            {loading ? "Comparing..." : "Compare"}
          </button>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-4 text-center">
            Running comparison...
          </div>
        )}

        {data && (
          <>
            {/* Plain-language summary */}
            {summary && (
              <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 text-xs text-terminal-fg">
                {summary}
              </div>
            )}

            {/* Per-investment errors */}
            {data.investments.some((iv) => iv.error) && (
              <div className="flex flex-col gap-1">
                {data.investments
                  .filter((iv) => iv.error)
                  .map((iv) => (
                    <div key={iv.label} className="text-2xs text-accent-amber">
                      {iv.label}: {iv.error}
                    </div>
                  ))}
              </div>
            )}

            {/* Normalized growth chart */}
            <Section title="Normalized Growth (start = 100)">
              <GrowthChart data={data} colorByLabel={colorByLabel} />
              <div className="flex flex-wrap gap-4 mt-2 px-1">
                {data.comparison.metrics_table.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-center gap-1.5 text-2xs text-terminal-dim"
                  >
                    <span
                      className="w-4 h-0.5 rounded inline-block"
                      style={{ backgroundColor: colorByLabel.get(m.label) ?? "#fff" }}
                    />
                    {m.label}
                    <span className={colorPct(m.total_return_pct)}>
                      {fmtPct(m.total_return_pct)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            {/* Metrics table */}
            <Section title="Return Metrics">
              <MetricsTable
                rows={data.comparison.metrics_table}
                bestByIrr={data.comparison.best_by_irr}
                colorByLabel={colorByLabel}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Builder card per investment ────────────────────────────────────────────────

function InvestmentBuilder({
  spec,
  color,
  onChange,
  onRemove,
  canRemove,
}: {
  spec: InvestmentSpec;
  color: string;
  onChange: (s: InvestmentSpec) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const changeKind = (kind: Kind) => {
    if (kind === spec.kind) return;
    if (kind === "real_estate") onChange(defaultRealEstate(spec.label));
    else if (kind === "market") onChange(defaultMarket(spec.label, "SPY"));
    else onChange(defaultCustom(spec.label));
  };

  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2">
      {/* Header row: color, label, kind selector, remove */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="w-2.5 h-2.5 rounded-sm inline-block flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <input
          type="text"
          value={spec.label}
          onChange={(e) => onChange({ ...spec, label: e.target.value })}
          placeholder="Label"
          className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg focus:outline-none focus:border-accent w-40"
        />
        <div className="flex items-center gap-1">
          {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => changeKind(k)}
              className={`pill text-2xs ${
                spec.kind === k
                  ? "bg-accent text-black"
                  : "text-terminal-dim hover:text-terminal-fg"
              }`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="pill text-2xs text-accent-red hover:text-red-300"
            title="Remove"
          >
            Remove
          </button>
        )}
      </div>

      {/* Fields per kind */}
      {spec.kind === "real_estate" && (
        <RealEstateFields spec={spec} onChange={onChange} />
      )}
      {spec.kind === "market" && (
        <MarketFields spec={spec} onChange={onChange} />
      )}
      {spec.kind === "custom" && (
        <CustomFields spec={spec} onChange={onChange} />
      )}
    </div>
  );
}

// ── Field groups ────────────────────────────────────────────────────────────────

function NumField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-2xs text-terminal-dim">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg tabular-nums focus:outline-none focus:border-accent w-full"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-2xs text-terminal-dim">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-fg focus:outline-none focus:border-accent w-full"
      />
    </label>
  );
}

function RealEstateFields({
  spec,
  onChange,
}: {
  spec: Extract<InvestmentSpec, { kind: "real_estate" }>;
  onChange: (s: InvestmentSpec) => void;
}) {
  const p = spec.params;
  const set = (patch: Partial<typeof p>) =>
    onChange({ ...spec, params: { ...p, ...patch } });
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      <NumField label="Purchase Price" value={p.purchase_price} step={1000} onChange={(v) => set({ purchase_price: v })} suffix="$" />
      <NumField label="Down Payment" value={p.down_payment_pct} onChange={(v) => set({ down_payment_pct: v })} suffix="%" />
      <NumField label="Loan Rate" value={p.loan_rate} step={0.125} onChange={(v) => set({ loan_rate: v })} suffix="%" />
      <NumField label="Loan Term" value={p.loan_term_years} onChange={(v) => set({ loan_term_years: v })} suffix="yrs" />
      <NumField label="Monthly Rent" value={p.monthly_rent} step={50} onChange={(v) => set({ monthly_rent: v })} suffix="$" />
      <NumField label="Monthly Expenses" value={p.monthly_expenses} step={50} onChange={(v) => set({ monthly_expenses: v })} suffix="$" />
      <NumField label="Vacancy" value={p.vacancy_pct} step={0.5} onChange={(v) => set({ vacancy_pct: v })} suffix="%" />
      <NumField label="Appreciation" value={p.annual_appreciation_pct} step={0.5} onChange={(v) => set({ annual_appreciation_pct: v })} suffix="%/yr" />
      <NumField label="Rent Growth" value={p.rent_growth_pct ?? 0} step={0.5} onChange={(v) => set({ rent_growth_pct: v })} suffix="%/yr" />
      <NumField label="Expense Growth" value={p.expense_growth_pct ?? 0} step={0.5} onChange={(v) => set({ expense_growth_pct: v })} suffix="%/yr" />
      <NumField label="Hold Period" value={p.hold_years} onChange={(v) => set({ hold_years: v })} suffix="yrs" />
      <NumField label="Sale Cost" value={p.sale_cost_pct} step={0.5} onChange={(v) => set({ sale_cost_pct: v })} suffix="%" />
      <NumField label="Closing Cost" value={p.closing_cost_pct ?? 0} step={0.5} onChange={(v) => set({ closing_cost_pct: v })} suffix="%" />
    </div>
  );
}

function MarketFields({
  spec,
  onChange,
}: {
  spec: Extract<InvestmentSpec, { kind: "market" }>;
  onChange: (s: InvestmentSpec) => void;
}) {
  const p = spec.params;
  const set = (patch: Partial<typeof p>) =>
    onChange({ ...spec, params: { ...p, ...patch } });
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      <TextField label="Symbol" value={p.symbol} onChange={(v) => set({ symbol: v.toUpperCase() })} />
      <NumField label="Initial Investment" value={p.initial_investment} step={1000} onChange={(v) => set({ initial_investment: v })} suffix="$" />
      <NumField label="Hold Period" value={p.hold_years} onChange={(v) => set({ hold_years: v })} suffix="yrs" />
      <NumField label="Monthly Contribution" value={p.monthly_contribution ?? 0} step={50} onChange={(v) => set({ monthly_contribution: v })} suffix="$" />
      <NumField label="Dividend Yield" value={p.dividend_yield_pct ?? 0} step={0.1} onChange={(v) => set({ dividend_yield_pct: v })} suffix="%" />
    </div>
  );
}

function CustomFields({
  spec,
  onChange,
}: {
  spec: Extract<InvestmentSpec, { kind: "custom" }>;
  onChange: (s: InvestmentSpec) => void;
}) {
  const p = spec.params;
  const set = (patch: Partial<typeof p>) =>
    onChange({ ...spec, params: { ...p, ...patch } });

  const updateCf = (idx: number, patch: Partial<CustomCashflow>) => {
    const cashflows = p.cashflows.map((cf, i) =>
      i === idx ? { ...cf, ...patch } : cf,
    );
    set({ cashflows });
  };
  const addCf = () => {
    const last = p.cashflows[p.cashflows.length - 1];
    const d = last ? new Date(last.date) : new Date();
    d.setFullYear(d.getFullYear() + 1);
    set({ cashflows: [...p.cashflows, { date: d.toISOString().slice(0, 10), amount: 0 }] });
  };
  const removeCf = (idx: number) =>
    set({ cashflows: p.cashflows.filter((_, i) => i !== idx) });

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <NumField label="Initial Investment" value={p.initial_investment} step={1000} onChange={(v) => set({ initial_investment: v })} suffix="$" />
        <NumField label="Terminal Value" value={p.terminal_value ?? 0} step={1000} onChange={(v) => set({ terminal_value: v })} suffix="$" />
        <NumField label="Hold Period" value={p.hold_years} onChange={(v) => set({ hold_years: v })} suffix="yrs" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-terminal-dim uppercase">Cashflows (date, amount)</span>
        {p.cashflows.map((cf, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="date"
              value={cf.date}
              onChange={(e) => updateCf(i, { date: e.target.value })}
              className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-2xs text-terminal-fg focus:outline-none focus:border-accent"
            />
            <input
              type="number"
              step={100}
              value={Number.isFinite(cf.amount) ? cf.amount : ""}
              onChange={(e) => updateCf(i, { amount: parseFloat(e.target.value) })}
              className="bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-2xs text-terminal-fg tabular-nums focus:outline-none focus:border-accent w-32"
            />
            <button
              type="button"
              onClick={() => removeCf(i)}
              className="pill text-2xs text-accent-red hover:text-red-300"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addCf}
          className="pill text-2xs text-terminal-dim hover:text-terminal-fg self-start"
        >
          + Cashflow
        </button>
      </div>
    </div>
  );
}

// ── Section wrapper ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Normalized growth chart ─────────────────────────────────────────────────────

function GrowthChart({
  data,
  colorByLabel,
}: {
  data: CompareInvestmentsResponse;
  colorByLabel: Map<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 300,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      timeScale: { borderColor: "#374151" },
      rightPriceScale: { borderColor: "#374151" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const { dates, series } = data.comparison;
    Object.entries(series).forEach(([label, vals]) => {
      if (!dates?.length || !vals?.length) return;
      const line = chart.addSeries(LineSeries, {
        color: colorByLabel.get(label) ?? "#fff",
        lineWidth: 2,
        title: label,
      });
      const points = dates
        .map((d, i) => ({
          time: Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp,
          value: vals[i],
        }))
        .filter((p) => p.value != null) as { time: UTCTimestamp; value: number }[];
      if (points.length) line.setData(points);
    });

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, colorByLabel]);

  return <div ref={ref} />;
}

// ── Metrics table ─────────────────────────────────────────────────────────────

function MetricsTable({
  rows,
  bestByIrr,
  colorByLabel,
}: {
  rows: InvestmentMetricsRow[];
  bestByIrr: string | null;
  colorByLabel: Map<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Investment</th>
            <th className="text-right py-1 px-2">IRR (ann.)</th>
            <th className="text-right py-1 px-2">CAGR</th>
            <th className="text-right py-1 px-2">Total Return</th>
            <th className="text-right py-1 px-2">Equity Multiple</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isBest = bestByIrr != null && r.label === bestByIrr;
            return (
              <tr
                key={r.label}
                className={`border-t border-terminal-border/20 ${
                  isBest ? "bg-accent/10" : ""
                }`}
              >
                <td className="py-1.5 px-2 text-terminal-fg">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-sm inline-block"
                      style={{ backgroundColor: colorByLabel.get(r.label) ?? "#fff" }}
                    />
                    {r.label}
                    {isBest && (
                      <span className="text-2xs text-accent-green font-semibold">
                        best IRR
                      </span>
                    )}
                  </span>
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${isBest ? "text-accent-green font-semibold" : "text-terminal-fg"}`}>
                  {fmtDecimalPct(r.irr_annual)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">
                  {fmtDecimalPct(r.cagr)}
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${colorPct(r.total_return_pct)}`}>
                  {fmtPct(r.total_return_pct)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-terminal-fg">
                  {fmtMultiple(r.equity_multiple)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Plain-language summary ──────────────────────────────────────────────────────

function buildSummary(data: CompareInvestmentsResponse | null): string | null {
  if (!data) return null;
  const table = data.comparison.metrics_table;
  const best = data.comparison.best_by_irr;
  if (!best) return null;
  const winner = table.find((r) => r.label === best);
  if (!winner || winner.irr_annual == null) return null;

  const others = table.filter(
    (r) => r.label !== best && r.irr_annual != null,
  );
  if (others.length === 0) {
    return `${winner.label} earns a ${fmtDecimalPct(winner.irr_annual)} annual IRR.`;
  }
  // Compare against the next-best by IRR.
  const sorted = [...others].sort(
    (a, b) => (b.irr_annual ?? -Infinity) - (a.irr_annual ?? -Infinity),
  );
  const runnerUp = sorted[0];
  return `${winner.label}'s ${fmtDecimalPct(winner.irr_annual)} IRR beats ${runnerUp.label}'s ${fmtDecimalPct(runnerUp.irr_annual)}.`;
}

// ── Formatting helpers ──────────────────────────────────────────────────────────

function colorPct(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

// total_return_pct is already a percent.
function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// irr_annual / cagr are decimals (0.156 → 15.6%).
function fmtDecimalPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtMultiple(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(2)}x`;
}
