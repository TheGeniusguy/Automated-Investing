import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { ProFormaResponse } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Local shape mirror (documented in v2 contract). The wiring agent owns the
// canonical ProFormaResponse in api/types; this keeps the panel self-consistent
// and lets us bind defensively to the exact backend keys. Monetary values are
// USD millions unless noted. Year 0 is "LTM"; some year-0 cells are null.
// ─────────────────────────────────────────────────────────────────────────────
type Num = number | null;

interface IncomeRow {
  year: number;
  label: string;
  revenue: Num;
  revenue_growth: Num;
  cogs: Num;
  gross_profit: Num;
  gross_margin: Num;
  opex: Num;
  ebitda: Num;
  ebitda_margin: Num;
  da: Num;
  ebit: Num;
  interest_expense: Num;
  pretax_income: Num;
  taxes: Num;
  net_income: Num;
  net_margin: Num;
}

interface BalanceRow {
  year: number;
  label: string;
  cash: Num;
  accounts_receivable: Num;
  inventory: Num;
  ppe_net: Num;
  total_assets: Num;
  accounts_payable: Num;
  debt: Num;
  total_liabilities: Num;
  equity: Num;
  total_liab_and_equity: Num;
  net_debt: Num;
}

interface CashFlowRow {
  year: number;
  label: string;
  net_income: Num;
  da: Num;
  change_in_working_capital: Num;
  cfo: Num;
  capex: Num;
  cfi: Num;
  debt_repayment: Num;
  dividends: Num;
  cff: Num;
  net_change_in_cash: Num;
  beginning_cash: Num;
  ending_cash: Num;
  unlevered_fcf: Num;
  levered_fcf: Num;
}

interface Drivers {
  base_revenue?: Num;
  revenue_growth?: Num[];
  gross_margin?: Num;
  opex_pct_revenue?: Num;
  da_pct_revenue?: Num;
  capex_pct_revenue?: Num;
  tax_rate?: Num;
  dso_days?: Num;
  dio_days?: Num;
  dpo_days?: Num;
  interest_rate_on_debt?: Num;
}

interface ThreeStatement {
  units?: string;
  projection_years?: number;
  income_statement: IncomeRow[];
  balance_sheet: BalanceRow[];
  cash_flow: CashFlowRow[];
  drivers: Drivers;
  ties: { balanced: boolean };
}

interface WaccBlock {
  risk_free_rate?: Num;
  equity_risk_premium?: Num;
  beta?: Num;
  cost_of_equity?: Num;
  cost_of_debt?: Num;
  after_tax_cost_of_debt?: Num;
  equity_weight?: Num;
  debt_weight?: Num;
  wacc?: Num;
}

interface FcfRow {
  year: number;
  label: string;
  ebit: Num;
  nopat: Num;
  da: Num;
  capex: Num;
  change_in_working_capital: Num;
  unlevered_fcf: Num;
}

interface PvFcfRow {
  year: number;
  fcf: Num;
  discount_factor: Num;
  pv: Num;
}

interface TerminalMethod {
  growth_rate?: Num;
  ev_ebitda_multiple?: Num;
  terminal_ebitda?: Num;
  terminal_value: Num;
  pv_terminal_value: Num;
  enterprise_value: Num;
  implied_share_price: Num;
}

interface Dcf {
  wacc: WaccBlock;
  fcf: FcfRow[];
  pv_fcf: PvFcfRow[];
  pv_fcf_sum?: Num;
  terminal_value: { gordon_growth: TerminalMethod; exit_multiple: TerminalMethod };
  net_debt?: Num;
  shares_outstanding?: Num;
  enterprise_value?: Num;
  equity_value?: Num;
  implied_share_price: Num;
  implied_price_gordon: Num;
  implied_price_exit: Num;
  sensitivity: {
    wacc_axis: number[];
    growth_axis: number[];
    rows: { wacc?: Num; prices: Num[] }[];
  };
}

interface PeerRow {
  name?: string | null;
  ticker?: string | null;
  is_target?: boolean;
  price: Num;
  market_cap: Num;
  enterprise_value: Num;
  net_debt: Num;
  ebitda: Num;
  sales: Num;
  net_income: Num;
  eps: Num;
  ev_ebitda: Num;
  ev_sales: Num;
  pe: Num;
  ps: Num;
}

interface StatRow {
  min: Num;
  median: Num;
  mean: Num;
  max: Num;
}

interface Comps {
  peers: PeerRow[];
  target?: PeerRow | null;
  stats: { ev_ebitda: StatRow; ev_sales: StatRow; pe: StatRow; ps: StatRow };
  implied: {
    current_price?: Num;
    blended_implied_price?: Num;
    from_ev_ebitda?: { implied_price?: Num; median_multiple?: Num };
    from_ev_sales?: { implied_price?: Num; median_multiple?: Num };
    from_pe?: { implied_price?: Num; median_multiple?: Num };
  };
}

interface ScenarioCase {
  case?: string;
  name?: string;
  label?: string;
  implied_price: Num;
  upside_vs_base: Num;
}

interface TornadoRow {
  driver: string;
  label?: string;
  low_price: Num;
  high_price: Num;
  swing: Num;
}

interface Scenario {
  base_price?: Num;
  cases: ScenarioCase[];
  tornado: TornadoRow[];
}

interface ProForma {
  ticker?: string | null;
  company_name?: string | null;
  inputs?: Record<string, unknown>;
  three_statement: ThreeStatement;
  dcf: Dcf;
  comps: Comps;
  scenario: Scenario;
  data_mode?: string;
  as_of?: string;
  source?: string;
}

const CLAY = "#c9785c";

type SubTab = "Summary" | "3-Statement" | "DCF" | "Comps" | "Scenario";
const SUB_TABS: SubTab[] = ["Summary", "3-Statement", "DCF", "Comps", "Scenario"];

// ─────────────────────────────────────────────────────────────────────────────

export function ProFormaPanel() {
  const [input, setInput] = useState("AAPL");
  const [ticker, setTicker] = useState("AAPL");
  const [tab, setTab] = useState<SubTab>("Summary");
  const [data, setData] = useState<ProForma | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (t: string) => {
    const clean = t.trim().toUpperCase();
    if (!clean) {
      setErr("Enter a ticker.");
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .proforma(clean)
      .then((res: ProFormaResponse) => {
        setData(res as unknown as ProForma);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setErr(String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    run("AAPL");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const t = input.trim().toUpperCase();
    setTicker(t);
    run(t);
  };

  const name = data?.company_name || data?.ticker || ticker;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Pro Forma Modeling</span>
        {data && (
          <span className="font-mono text-terminal-dim normal-case tracking-normal">
            {data.ticker} {data.as_of ? `· as of ${fmtDate(data.as_of)}` : ""}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Ticker control */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-terminal-border/60 flex-shrink-0">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Ticker (e.g. AAPL)"
            className="w-40 bg-terminal-bg border border-terminal-border/70 rounded px-2.5 py-1 text-xs font-mono uppercase text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-terminal-bg disabled:opacity-40"
          >
            {loading ? "Building..." : "Build Model"}
          </button>
          <div className="flex-1" />
          {name && (
            <span className="font-serif text-base text-terminal-text leading-none truncate max-w-[40%]">
              {name}
            </span>
          )}
        </div>

        {/* Sub-tabs */}
        <div className="flex border-b border-terminal-border flex-shrink-0 overflow-x-auto">
          {SUB_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs whitespace-nowrap transition-colors ${
                tab === t
                  ? "text-accent border-b-2 border-accent -mb-px"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto">
          {err && !loading && (
            <div className="m-4 rounded border border-accent-red/40 bg-accent-red/5 px-4 py-3 text-xs text-accent-red">
              Could not build the model. {err}
            </div>
          )}
          {loading && !data && (
            <div className="h-full flex items-center justify-center text-xs text-terminal-dim animate-pulse">
              Building pro forma model...
            </div>
          )}
          {data && (
            <div className={loading ? "opacity-50 transition-opacity" : "transition-opacity"}>
              {tab === "Summary" && <SummaryTab data={data} />}
              {tab === "3-Statement" && <StatementTab data={data} />}
              {tab === "DCF" && <DcfTab data={data} />}
              {tab === "Comps" && <CompsTab data={data} />}
              {tab === "Scenario" && <ScenarioTab data={data} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

function SummaryTab({ data }: { data: ProForma }) {
  const { dcf, comps, scenario } = data;
  const implied = dcf.implied_share_price;
  const current = comps.implied?.current_price ?? comps.target?.price ?? null;
  const upside =
    implied != null && current != null && current !== 0
      ? (implied - current) / current
      : null;

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Hero */}
      <div className="rounded-panel border border-terminal-border/60 bg-terminal-bg px-6 py-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="text-2xs uppercase tracking-[0.18em] text-terminal-dim mb-1">
            DCF Implied Share Price
          </div>
          <div className="stat-figure text-6xl leading-none text-terminal-text">
            {fmtPrice(implied)}
          </div>
          <div className="mt-2 text-xs text-terminal-muted">
            Blended Gordon growth and exit multiple, unlevered DCF
          </div>
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1">
          <div className="text-2xs uppercase tracking-[0.18em] text-terminal-dim">
            vs Current {fmtPrice(current)}
          </div>
          {upside != null ? (
            <div
              className={`stat-figure text-3xl leading-none ${
                upside >= 0 ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {upside >= 0 ? "+" : ""}
              {fmtPctDec(upside)}
            </div>
          ) : (
            <div className="stat-figure text-3xl text-terminal-dim">--</div>
          )}
          <div className="text-2xs text-terminal-dim">
            {upside != null ? (upside >= 0 ? "Undervalued" : "Overvalued") : ""}
          </div>
        </div>
      </div>

      {/* Football field */}
      <Section title="Valuation Football Field">
        <FootballField data={data} current={current} />
      </Section>

      {/* Headline KPIs */}
      <Section title="Headline Metrics">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-terminal-border/40 rounded overflow-hidden">
          <Kpi label="Enterprise Value" value={fmtMMShort(dcf.enterprise_value)} />
          <Kpi label="Equity Value" value={fmtMMShort(dcf.equity_value)} />
          <Kpi label="Net Debt" value={fmtMMShort(dcf.net_debt)} />
          <Kpi label="WACC" value={fmtPctDec(dcf.wacc?.wacc)} />
          <Kpi label="Gordon Price" value={fmtPrice(dcf.implied_price_gordon)} />
          <Kpi label="Exit Multiple Price" value={fmtPrice(dcf.implied_price_exit)} />
          <Kpi label="Comps Implied" value={fmtPrice(comps.implied?.blended_implied_price)} />
          <Kpi
            label="Bull / Bear"
            value={`${fmtPrice(casePrice(scenario, "bull"))} / ${fmtPrice(
              casePrice(scenario, "bear"),
            )}`}
          />
        </div>
      </Section>
    </div>
  );
}

function FootballField({ data, current }: { data: ProForma; current: Num }) {
  const { dcf, comps, scenario } = data;
  const bear = casePrice(scenario, "bear");
  const bull = casePrice(scenario, "bull");
  const base = casePrice(scenario, "base") ?? scenario.base_price ?? null;

  const rows = [
    { label: "DCF · Gordon Growth", lo: dcf.implied_price_gordon, hi: dcf.implied_price_gordon, kind: "point" as const },
    { label: "DCF · Exit Multiple", lo: dcf.implied_price_exit, hi: dcf.implied_price_exit, kind: "point" as const },
    { label: "Trading Comps", lo: comps.implied?.blended_implied_price ?? null, hi: comps.implied?.blended_implied_price ?? null, kind: "point" as const },
    { label: "Scenario · Bear to Bull", lo: bear, hi: bull, kind: "range" as const },
  ];

  const all: number[] = [];
  rows.forEach((r) => {
    if (r.lo != null) all.push(r.lo);
    if (r.hi != null) all.push(r.hi);
  });
  if (current != null) all.push(current);
  if (base != null) all.push(base);
  if (all.length === 0) {
    return <div className="text-xs text-terminal-dim">No valuation outputs.</div>;
  }
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || hi * 0.1 || 1;
  lo -= pad;
  hi += pad;
  const pos = (v: number) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <div className="w-40 flex-shrink-0 text-2xs text-terminal-muted text-right truncate">
            {r.label}
          </div>
          <div className="flex-1 relative h-7 bg-terminal-bg border border-terminal-border/40 rounded">
            {/* current price reference line */}
            {current != null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-terminal-muted/60"
                style={{ left: `${pos(current)}%` }}
                title={`Current ${fmtPrice(current)}`}
              />
            )}
            {r.kind === "range" && r.lo != null && r.hi != null ? (
              <>
                <div
                  className="absolute top-1.5 bottom-1.5 rounded"
                  style={{
                    left: `${pos(Math.min(r.lo, r.hi))}%`,
                    width: `${Math.max(pos(Math.max(r.lo, r.hi)) - pos(Math.min(r.lo, r.hi)), 0.6)}%`,
                    background: `linear-gradient(90deg, ${CLAY}55, ${CLAY}cc)`,
                  }}
                />
                <FieldLabel side="lo" left={pos(r.lo)} text={fmtPrice(r.lo)} />
                <FieldLabel side="hi" left={pos(r.hi)} text={fmtPrice(r.hi)} />
                {base != null && (
                  <div
                    className="absolute top-0.5 bottom-0.5 w-[2px] bg-terminal-text"
                    style={{ left: `${pos(base)}%` }}
                    title={`Base ${fmtPrice(base)}`}
                  />
                )}
              </>
            ) : r.lo != null ? (
              <>
                <div
                  className="absolute top-1 bottom-1 w-1.5 rounded-sm"
                  style={{ left: `calc(${pos(r.lo)}% - 3px)`, background: CLAY }}
                />
                <FieldLabel side="hi" left={pos(r.lo)} text={fmtPrice(r.lo)} />
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-2xs text-terminal-dim">
                n/a
              </div>
            )}
          </div>
        </div>
      ))}
      {/* axis */}
      <div className="flex items-center gap-3">
        <div className="w-40 flex-shrink-0" />
        <div className="flex-1 flex justify-between text-2xs text-terminal-dim font-mono">
          <span>{fmtPrice(lo)}</span>
          {current != null && <span className="text-terminal-muted">Current {fmtPrice(current)}</span>}
          <span>{fmtPrice(hi)}</span>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ side, left, text }: { side: "lo" | "hi"; left: number; text: string }) {
  return (
    <span
      className="absolute top-1/2 -translate-y-1/2 text-2xs font-mono text-terminal-text whitespace-nowrap"
      style={
        side === "lo"
          ? { right: `calc(${100 - left}% + 6px)` }
          : { left: `calc(${left}% + 6px)` }
      }
    >
      {text}
    </span>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-terminal-panel px-3 py-2.5">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1 truncate">{label}</div>
      <div className="stat-figure text-lg text-terminal-text leading-none">{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3-STATEMENT
// ═══════════════════════════════════════════════════════════════════════════

interface StmtLine<T> {
  label: string;
  pick: (r: T) => Num;
  emphasis?: boolean;
  pct?: boolean;
  sub?: boolean;
}

const INCOME_LINES: StmtLine<IncomeRow>[] = [
  { label: "Revenue", pick: (r) => r.revenue, emphasis: true },
  { label: "Revenue growth", pick: (r) => r.revenue_growth, pct: true, sub: true },
  { label: "COGS", pick: (r) => r.cogs },
  { label: "Gross profit", pick: (r) => r.gross_profit, emphasis: true },
  { label: "Gross margin", pick: (r) => r.gross_margin, pct: true, sub: true },
  { label: "Operating expense", pick: (r) => r.opex },
  { label: "EBITDA", pick: (r) => r.ebitda, emphasis: true },
  { label: "EBITDA margin", pick: (r) => r.ebitda_margin, pct: true, sub: true },
  { label: "D&A", pick: (r) => r.da },
  { label: "EBIT", pick: (r) => r.ebit },
  { label: "Interest expense", pick: (r) => r.interest_expense },
  { label: "Pre-tax income", pick: (r) => r.pretax_income },
  { label: "Taxes", pick: (r) => r.taxes },
  { label: "Net income", pick: (r) => r.net_income, emphasis: true },
  { label: "Net margin", pick: (r) => r.net_margin, pct: true, sub: true },
];

const BALANCE_LINES: StmtLine<BalanceRow>[] = [
  { label: "Cash", pick: (r) => r.cash },
  { label: "Accounts receivable", pick: (r) => r.accounts_receivable },
  { label: "Inventory", pick: (r) => r.inventory },
  { label: "PP&E, net", pick: (r) => r.ppe_net },
  { label: "Total assets", pick: (r) => r.total_assets, emphasis: true },
  { label: "Accounts payable", pick: (r) => r.accounts_payable },
  { label: "Debt", pick: (r) => r.debt },
  { label: "Total liabilities", pick: (r) => r.total_liabilities, emphasis: true },
  { label: "Equity", pick: (r) => r.equity, emphasis: true },
  { label: "Total liab. & equity", pick: (r) => r.total_liab_and_equity, emphasis: true },
  { label: "Net debt", pick: (r) => r.net_debt, sub: true },
];

const CASHFLOW_LINES: StmtLine<CashFlowRow>[] = [
  { label: "Net income", pick: (r) => r.net_income },
  { label: "D&A", pick: (r) => r.da },
  { label: "Change in working capital", pick: (r) => r.change_in_working_capital },
  { label: "Cash from operations", pick: (r) => r.cfo, emphasis: true },
  { label: "Capex", pick: (r) => r.capex },
  { label: "Cash from investing", pick: (r) => r.cfi, emphasis: true },
  { label: "Debt repayment", pick: (r) => r.debt_repayment },
  { label: "Dividends", pick: (r) => r.dividends },
  { label: "Cash from financing", pick: (r) => r.cff, emphasis: true },
  { label: "Net change in cash", pick: (r) => r.net_change_in_cash, emphasis: true },
  { label: "Ending cash", pick: (r) => r.ending_cash },
  { label: "Unlevered FCF", pick: (r) => r.unlevered_fcf, sub: true },
];

function StatementTab({ data }: { data: ProForma }) {
  const ts = data.three_statement;
  const balanced = ts.ties?.balanced;

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Assumptions strip */}
      <Section title="Drivers & Assumptions">
        <DriversStrip drivers={ts.drivers} />
      </Section>

      <div className="flex items-center justify-between">
        <span className="text-2xs uppercase tracking-wider text-terminal-dim">
          {ts.units || "USD millions"}
        </span>
        <span
          className={`pill ${
            balanced
              ? "bg-accent-green/10 text-accent-green"
              : "bg-accent-red/10 text-accent-red"
          }`}
          title="Cash-flow ending cash ties to balance-sheet cash and assets equal liabilities plus equity"
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: balanced ? "#5bb97f" : "#e5564b" }}
          />
          {balanced ? "Statements balanced" : "Tie check failed"}
        </span>
      </div>

      <StmtTable title="Income Statement" rows={ts.income_statement} lines={INCOME_LINES} />
      <StmtTable title="Balance Sheet" rows={ts.balance_sheet} lines={BALANCE_LINES} />
      <StmtTable title="Cash Flow" rows={ts.cash_flow} lines={CASHFLOW_LINES} />
    </div>
  );
}

function DriversStrip({ drivers }: { drivers: Drivers }) {
  const items: { k: string; v: string }[] = [
    { k: "Base revenue", v: fmtMMShort(drivers.base_revenue ?? null) },
    { k: "Gross margin", v: fmtPctDec(drivers.gross_margin ?? null) },
    { k: "Opex % rev", v: fmtPctDec(drivers.opex_pct_revenue ?? null) },
    { k: "D&A % rev", v: fmtPctDec(drivers.da_pct_revenue ?? null) },
    { k: "Capex % rev", v: fmtPctDec(drivers.capex_pct_revenue ?? null) },
    { k: "Tax rate", v: fmtPctDec(drivers.tax_rate ?? null) },
    { k: "DSO days", v: fmtPlain(drivers.dso_days ?? null) },
    { k: "DIO days", v: fmtPlain(drivers.dio_days ?? null) },
    { k: "DPO days", v: fmtPlain(drivers.dpo_days ?? null) },
    { k: "Debt rate", v: fmtPctDec(drivers.interest_rate_on_debt ?? null) },
  ];
  const ramp = drivers.revenue_growth ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-px bg-terminal-border/40 rounded overflow-hidden">
        {items.map((it) => (
          <div key={it.k} className="bg-terminal-bg px-3 py-2">
            <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-0.5">{it.k}</div>
            <div className="stat-figure text-sm text-terminal-text">{it.v}</div>
          </div>
        ))}
      </div>
      {ramp.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xs uppercase tracking-wider text-terminal-dim">Growth ramp:</span>
          {ramp.map((g, i) => (
            <span key={i} className="pill bg-accent-amber/10 text-accent-amber font-mono">
              Y{i + 1} {fmtPctDec(g)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StmtTable<T extends { year: number; label: string }>({
  title,
  rows,
  lines,
}: {
  title: string;
  rows: T[];
  lines: StmtLine<T>[];
}) {
  if (!rows || rows.length === 0) {
    return (
      <div>
        <SubHead text={title} />
        <div className="text-xs text-terminal-dim">No data.</div>
      </div>
    );
  }
  return (
    <div>
      <SubHead text={title} />
      <div className="overflow-x-auto rounded border border-terminal-border/40">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-terminal-bg text-terminal-dim uppercase tracking-wide text-2xs">
              <th className="text-left py-2 px-3 font-medium sticky left-0 bg-terminal-bg z-10">
                {title.split(" ")[0]}
              </th>
              {rows.map((r) => (
                <th key={r.year} className="text-right py-2 px-3 font-medium">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.label}
                className={`border-t border-terminal-border/20 ${
                  line.emphasis ? "bg-white/[0.015]" : ""
                }`}
              >
                <td
                  className={`py-1.5 px-3 sticky left-0 z-10 ${
                    line.emphasis
                      ? "text-terminal-text font-medium bg-terminal-panel"
                      : line.sub
                        ? "text-terminal-dim pl-5 bg-terminal-panel"
                        : "text-terminal-muted bg-terminal-panel"
                  }`}
                >
                  {line.label}
                </td>
                {rows.map((r) => {
                  const v = line.pick(r);
                  return (
                    <td
                      key={r.year}
                      className={`py-1.5 px-3 text-right tabular-nums font-mono ${
                        line.emphasis
                          ? "text-terminal-text font-semibold"
                          : line.sub
                            ? "text-terminal-dim"
                            : "text-terminal-muted"
                      }`}
                    >
                      {line.pct ? fmtPctDec(v) : fmtMM(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DCF
// ═══════════════════════════════════════════════════════════════════════════

function DcfTab({ data }: { data: ProForma }) {
  const { dcf } = data;
  const pvByYear = useMemo(() => {
    const m = new Map<number, PvFcfRow>();
    (dcf.pv_fcf ?? []).forEach((p) => m.set(p.year, p));
    return m;
  }, [dcf.pv_fcf]);

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* FCF build */}
      <Section title="Unlevered Free Cash Flow Build">
        <div className="overflow-x-auto rounded border border-terminal-border/40">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-terminal-bg text-terminal-dim uppercase tracking-wide text-2xs">
                <th className="text-left py-2 px-3 font-medium">USD millions</th>
                {(dcf.fcf ?? []).map((r) => (
                  <th key={r.year} className="text-right py-2 px-3 font-medium">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["EBIT", (r: FcfRow) => r.ebit, false],
                  ["NOPAT", (r: FcfRow) => r.nopat, false],
                  ["D&A", (r: FcfRow) => r.da, false],
                  ["Capex", (r: FcfRow) => r.capex, false],
                  ["Change in WC", (r: FcfRow) => r.change_in_working_capital, false],
                  ["Unlevered FCF", (r: FcfRow) => r.unlevered_fcf, true],
                  ["Discount factor", (r: FcfRow) => pvByYear.get(r.year)?.discount_factor ?? null, false],
                  ["PV of FCF", (r: FcfRow) => pvByYear.get(r.year)?.pv ?? null, true],
                ] as [string, (r: FcfRow) => Num, boolean][]
              ).map(([label, pick, emph]) => (
                <tr
                  key={label}
                  className={`border-t border-terminal-border/20 ${emph ? "bg-white/[0.015]" : ""}`}
                >
                  <td
                    className={`py-1.5 px-3 ${
                      emph ? "text-terminal-text font-medium" : "text-terminal-muted"
                    }`}
                  >
                    {label}
                  </td>
                  {(dcf.fcf ?? []).map((r) => {
                    const v = pick(r);
                    const isDf = label === "Discount factor";
                    return (
                      <td
                        key={r.year}
                        className={`py-1.5 px-3 text-right tabular-nums font-mono ${
                          emph ? "text-terminal-text font-semibold" : "text-terminal-muted"
                        }`}
                      >
                        {isDf ? fmtFactor(v) : fmtMM(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex justify-end text-xs text-terminal-muted">
          <span className="mr-2">Sum of PV(FCF):</span>
          <span className="stat-figure text-terminal-text">{fmtMMShort(dcf.pv_fcf_sum ?? null)}</span>
        </div>
      </Section>

      {/* WACC + terminal value */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Section title="WACC">
          <dl className="flex flex-col gap-1.5 text-xs">
            <DefRow k="Risk-free rate" v={fmtPctDec(dcf.wacc?.risk_free_rate)} />
            <DefRow k="Equity risk premium" v={fmtPctDec(dcf.wacc?.equity_risk_premium)} />
            <DefRow k="Beta" v={fmtPlain(dcf.wacc?.beta, 2)} />
            <DefRow k="Cost of equity" v={fmtPctDec(dcf.wacc?.cost_of_equity)} />
            <DefRow k="After-tax cost of debt" v={fmtPctDec(dcf.wacc?.after_tax_cost_of_debt)} />
            <DefRow k="Equity / debt weight" v={`${fmtPctDec(dcf.wacc?.equity_weight)} / ${fmtPctDec(dcf.wacc?.debt_weight)}`} />
            <div className="border-t border-terminal-border/30 mt-1 pt-2 flex items-center justify-between">
              <span className="text-terminal-muted">WACC</span>
              <span className="stat-figure text-xl text-accent-amber">{fmtPctDec(dcf.wacc?.wacc)}</span>
            </div>
          </dl>
        </Section>

        <TerminalCard
          title="Terminal · Gordon Growth"
          rows={[
            ["Growth rate", fmtPctDec(dcf.terminal_value?.gordon_growth?.growth_rate)],
            ["Terminal value", fmtMMShort(dcf.terminal_value?.gordon_growth?.terminal_value)],
            ["PV of terminal", fmtMMShort(dcf.terminal_value?.gordon_growth?.pv_terminal_value)],
            ["Enterprise value", fmtMMShort(dcf.terminal_value?.gordon_growth?.enterprise_value)],
          ]}
          price={dcf.terminal_value?.gordon_growth?.implied_share_price}
        />
        <TerminalCard
          title="Terminal · Exit Multiple"
          rows={[
            ["EV / EBITDA", fmtX(dcf.terminal_value?.exit_multiple?.ev_ebitda_multiple)],
            ["Terminal EBITDA", fmtMMShort(dcf.terminal_value?.exit_multiple?.terminal_ebitda)],
            ["Terminal value", fmtMMShort(dcf.terminal_value?.exit_multiple?.terminal_value)],
            ["Enterprise value", fmtMMShort(dcf.terminal_value?.exit_multiple?.enterprise_value)],
          ]}
          price={dcf.terminal_value?.exit_multiple?.implied_share_price}
        />
      </div>

      {/* Sensitivity heatmap */}
      <Section title="Sensitivity · Implied Price (WACC × Terminal Growth)">
        <SensitivityHeatmap dcf={dcf} />
      </Section>
    </div>
  );
}

function TerminalCard({
  title,
  rows,
  price,
}: {
  title: string;
  rows: [string, string][];
  price: Num;
}) {
  return (
    <div className="rounded border border-terminal-border/40 bg-terminal-bg p-3 flex flex-col">
      <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-2">{title}</div>
      <dl className="flex flex-col gap-1.5 text-xs flex-1">
        {rows.map(([k, v]) => (
          <DefRow key={k} k={k} v={v} />
        ))}
      </dl>
      <div className="border-t border-terminal-border/30 mt-2 pt-2 flex items-center justify-between">
        <span className="text-2xs uppercase tracking-wider text-terminal-dim">Implied price</span>
        <span className="stat-figure text-xl text-terminal-text">{fmtPrice(price)}</span>
      </div>
    </div>
  );
}

function SensitivityHeatmap({ dcf }: { dcf: Dcf }) {
  const sens = dcf.sensitivity;
  const wacc = sens?.wacc_axis ?? [];
  const growth = sens?.growth_axis ?? [];
  const rows = sens?.rows ?? [];
  const flat: number[] = [];
  rows.forEach((r) => r.prices?.forEach((p) => p != null && flat.push(p)));
  if (flat.length === 0) {
    return <div className="text-xs text-terminal-dim">No sensitivity grid.</div>;
  }
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  const base = dcf.implied_price_gordon;

  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-1.5 text-2xs text-terminal-dim font-normal text-left">
              WACC \ g
            </th>
            {growth.map((g, j) => (
              <th key={j} className="p-1.5 text-2xs text-terminal-muted font-normal text-center tabular-nums font-mono">
                {fmtPctDec(g)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="p-1.5 text-2xs text-terminal-muted text-right tabular-nums font-mono whitespace-nowrap">
                {fmtPctDec(row.wacc ?? wacc[i] ?? null)}
              </td>
              {row.prices.map((p, j) => {
                const isBase = base != null && p != null && Math.abs(p - base) < 0.01;
                return (
                  <td
                    key={j}
                    className="p-1.5 text-center tabular-nums font-mono border border-terminal-bg"
                    style={{
                      background: clayScale(p, lo, hi),
                      color: "#1c140f",
                      outline: isBase ? "1.5px solid #ece7df" : undefined,
                      outlineOffset: isBase ? "-2px" : undefined,
                    }}
                    title={`WACC ${fmtPctDec(row.wacc ?? null)} · g ${fmtPctDec(growth[j])} = ${fmtPrice(p)}`}
                  >
                    {p == null ? "" : fmtPlain(p, 0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2 text-2xs text-terminal-dim">
        <span>{fmtPrice(lo)}</span>
        <div
          className="h-2 w-28 rounded"
          style={{ background: `linear-gradient(90deg, ${CLAY}22, ${CLAY})` }}
        />
        <span>{fmtPrice(hi)}</span>
        <span className="ml-2">White outline marks the base case.</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPS
// ═══════════════════════════════════════════════════════════════════════════

function CompsTab({ data }: { data: ProForma }) {
  const { comps } = data;
  const peers = comps.peers ?? [];
  const stats = comps.stats;

  return (
    <div className="p-4 flex flex-col gap-4">
      <Section title="Trading Comparables">
        <div className="overflow-x-auto rounded border border-terminal-border/40">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-terminal-bg text-terminal-dim uppercase tracking-wide text-2xs">
                <th className="text-left py-2 px-3 font-medium">Company</th>
                <th className="text-right py-2 px-3 font-medium">Price</th>
                <th className="text-right py-2 px-3 font-medium">Mkt Cap</th>
                <th className="text-right py-2 px-3 font-medium">EV</th>
                <th className="text-right py-2 px-3 font-medium">EBITDA</th>
                <th className="text-right py-2 px-3 font-medium">Sales</th>
                <th className="text-right py-2 px-3 font-medium">EV/EBITDA</th>
                <th className="text-right py-2 px-3 font-medium">EV/Sales</th>
                <th className="text-right py-2 px-3 font-medium">P/E</th>
                <th className="text-right py-2 px-3 font-medium">P/S</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p, i) => (
                <tr
                  key={`${p.ticker}-${i}`}
                  className={`border-t border-terminal-border/20 ${
                    p.is_target ? "bg-accent-amber/10" : ""
                  }`}
                >
                  <td className="py-1.5 px-3">
                    <span
                      className={`${
                        p.is_target ? "text-accent-amber font-semibold" : "text-terminal-text"
                      }`}
                    >
                      {p.ticker || "--"}
                    </span>
                    <span className="text-terminal-dim ml-2 truncate">{p.name || ""}</span>
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtPrice(p.price)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtMMShort(p.market_cap)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtMMShort(p.enterprise_value)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtMMShort(p.ebitda)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtMMShort(p.sales)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-text">{fmtX(p.ev_ebitda)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-text">{fmtX(p.ev_sales)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-text">{fmtX(p.pe)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-text">{fmtX(p.ps)}</td>
                </tr>
              ))}
              {/* stat rows */}
              {stats &&
                (["min", "median", "mean", "max"] as const).map((s) => (
                  <tr key={s} className="border-t border-terminal-border/40 bg-terminal-bg/60">
                    <td className="py-1.5 px-3 text-2xs uppercase tracking-wider text-terminal-dim" colSpan={6}>
                      {s} (peers)
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtX(stats.ev_ebitda?.[s])}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtX(stats.ev_sales?.[s])}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtX(stats.pe?.[s])}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-mono text-terminal-muted">{fmtX(stats.ps?.[s])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Implied Valuation (median peer multiples)">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-px bg-terminal-border/40 rounded overflow-hidden">
          <ImpliedCard
            label="From EV / EBITDA"
            mult={comps.implied?.from_ev_ebitda?.median_multiple}
            price={comps.implied?.from_ev_ebitda?.implied_price}
          />
          <ImpliedCard
            label="From EV / Sales"
            mult={comps.implied?.from_ev_sales?.median_multiple}
            price={comps.implied?.from_ev_sales?.implied_price}
          />
          <ImpliedCard
            label="From P/E"
            mult={comps.implied?.from_pe?.median_multiple}
            price={comps.implied?.from_pe?.implied_price}
          />
          <div className="bg-terminal-bg px-3 py-3 flex flex-col">
            <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1">Blended implied</div>
            <div className="stat-figure text-2xl text-accent-amber leading-none">
              {fmtPrice(comps.implied?.blended_implied_price)}
            </div>
            <div className="text-2xs text-terminal-dim mt-1">vs current {fmtPrice(comps.implied?.current_price)}</div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function ImpliedCard({ label, mult, price }: { label: string; mult: Num | undefined; price: Num | undefined }) {
  return (
    <div className="bg-terminal-panel px-3 py-3 flex flex-col">
      <div className="text-2xs uppercase tracking-wider text-terminal-dim mb-1">{label}</div>
      <div className="stat-figure text-xl text-terminal-text leading-none">{fmtPrice(price)}</div>
      <div className="text-2xs text-terminal-dim mt-1">{fmtX(mult)} multiple</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO
// ═══════════════════════════════════════════════════════════════════════════

function ScenarioTab({ data }: { data: ProForma }) {
  const { scenario } = data;
  const order = ["bear", "base", "bull"];
  const cases = [...(scenario.cases ?? [])].sort(
    (a, b) => order.indexOf(caseKey(a)) - order.indexOf(caseKey(b)),
  );

  return (
    <div className="p-4 flex flex-col gap-4">
      <Section title="Scenario Cases">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {cases.map((c) => {
            const key = caseKey(c);
            const accent =
              key === "bull"
                ? "text-accent-green"
                : key === "bear"
                  ? "text-accent-red"
                  : "text-terminal-text";
            const border =
              key === "bull"
                ? "border-accent-green/40"
                : key === "bear"
                  ? "border-accent-red/40"
                  : "border-terminal-border/60";
            return (
              <div
                key={key}
                className={`rounded-panel border ${border} bg-terminal-bg px-4 py-4 flex flex-col gap-1`}
              >
                <div className="text-2xs uppercase tracking-[0.18em] text-terminal-dim">
                  {c.label || c.name || key}
                </div>
                <div className={`stat-figure text-4xl leading-none ${accent}`}>
                  {fmtPrice(c.implied_price)}
                </div>
                {c.upside_vs_base != null && key !== "base" ? (
                  <div className={`text-sm ${c.upside_vs_base >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {c.upside_vs_base >= 0 ? "+" : ""}
                    {fmtPctDec(c.upside_vs_base)} vs base
                  </div>
                ) : (
                  <div className="text-sm text-terminal-dim">base case</div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Tornado · Value Driver Sensitivity">
        <Tornado rows={scenario.tornado ?? []} base={casePrice(scenario, "base") ?? scenario.base_price ?? null} />
      </Section>
    </div>
  );
}

function Tornado({ rows, base }: { rows: TornadoRow[]; base: Num }) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.swing ?? 0) - (a.swing ?? 0)),
    [rows],
  );
  if (sorted.length === 0) {
    return <div className="text-xs text-terminal-dim">No tornado data.</div>;
  }
  const all: number[] = [];
  sorted.forEach((r) => {
    if (r.low_price != null) all.push(r.low_price);
    if (r.high_price != null) all.push(r.high_price);
  });
  if (base != null) all.push(base);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const pos = (v: number) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
  const basePos = base != null ? pos(base) : 50;

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((r) => {
        const a = r.low_price;
        const b = r.high_price;
        if (a == null || b == null) return null;
        const left = Math.min(pos(a), pos(b));
        const right = Math.max(pos(a), pos(b));
        return (
          <div key={r.driver} className="flex items-center gap-3">
            <div className="w-32 flex-shrink-0 text-2xs text-terminal-muted text-right truncate">
              {r.label || r.driver}
            </div>
            <div className="flex-1 relative h-6 bg-terminal-bg border border-terminal-border/40 rounded">
              {/* base line */}
              <div
                className="absolute top-0 bottom-0 w-px bg-terminal-muted/60 z-10"
                style={{ left: `${basePos}%` }}
              />
              {/* downside (left of base) */}
              <div
                className="absolute top-1 bottom-1 rounded-l"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(basePos - left, 0)}%`,
                  background: "rgba(229, 86, 75, 0.55)",
                }}
              />
              {/* upside (right of base) */}
              <div
                className="absolute top-1 bottom-1 rounded-r"
                style={{
                  left: `${basePos}%`,
                  width: `${Math.max(right - basePos, 0)}%`,
                  background: "rgba(91, 185, 127, 0.55)",
                }}
              />
              <span className="absolute left-1 top-1/2 -translate-y-1/2 text-2xs font-mono text-terminal-text/80">
                {fmtPrice(Math.min(a, b))}
              </span>
              <span className="absolute right-1 top-1/2 -translate-y-1/2 text-2xs font-mono text-terminal-text/80">
                {fmtPrice(Math.max(a, b))}
              </span>
            </div>
            <div className="w-16 flex-shrink-0 text-right text-2xs font-mono text-accent-amber">
              {fmtPrice(r.swing)}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3 mt-1">
        <div className="w-32 flex-shrink-0" />
        <div className="flex-1 text-2xs text-terminal-dim text-center">
          Base case {fmtPrice(base)} · bars span the low-to-high implied price for each driver
        </div>
        <div className="w-16 flex-shrink-0 text-right text-2xs text-terminal-dim">swing</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared bits
// ═══════════════════════════════════════════════════════════════════════════

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <SubHead text={title} />
      {children}
    </div>
  );
}

function SubHead({ text }: { text: string }) {
  return (
    <div className="text-2xs uppercase tracking-[0.14em] text-terminal-muted mb-2">{text}</div>
  );
}

function DefRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-terminal-muted">{k}</span>
      <span className="tabular-nums font-mono text-terminal-text">{v}</span>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function caseKey(c: ScenarioCase): string {
  return (c.case || c.name || c.label || "").toLowerCase();
}

function casePrice(scenario: Scenario, key: string): Num {
  const c = (scenario.cases ?? []).find((x) => caseKey(x) === key);
  return c ? c.implied_price : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clayScale(v: Num, lo: number, hi: number): string {
  if (v == null || Number.isNaN(v)) return "#1a1714";
  const t = hi === lo ? 0.5 : clamp((v - lo) / (hi - lo), 0, 1);
  const alpha = (0.14 + 0.78 * t).toFixed(2);
  return `rgba(201, 120, 92, ${alpha})`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtPrice(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Money in $MM. Parentheses for negatives (banker convention).
function fmtMM(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : 1;
  const s = abs.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return v < 0 ? `(${s})` : s;
}

// Compact money for KPI tiles: $390.1B, $12.4B, $850.0M (input is $MM).
function fmtMMShort(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  const neg = v < 0;
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1_000_000) s = `$${(abs / 1_000_000).toFixed(2)}T`;
  else if (abs >= 1_000) s = `$${(abs / 1_000).toFixed(1)}B`;
  else s = `$${abs.toFixed(1)}M`;
  return neg ? `(${s})` : s;
}

// decimal ratio -> percent (0.58 -> 58.0%)
function fmtPctDec(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtX(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(1)}x`;
}

function fmtFactor(v: Num | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toFixed(3);
}

function fmtPlain(v: Num | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toFixed(digits);
}
