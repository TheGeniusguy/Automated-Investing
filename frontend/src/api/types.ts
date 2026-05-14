// API contract — mirrors backend Pydantic / dict shapes.

export type RegimeLabel = "risk_on" | "risk_off" | "transition";

export interface RegimeState {
  label: RegimeLabel;
  confidence: number;        // 0.0 - 1.0
  reason: string;
  inputs: {
    vix: number | null;
    y2: number | null;
    y10: number | null;
  };
}

export interface SeriesPoint {
  date: string;              // YYYY-MM-DD
  value: number | null;
}

export interface SeriesMeta {
  label: string;
  unit: string;
  source: string;
}

export interface SeriesBundle {
  days: number;
  meta: Record<string, SeriesMeta>;
  series: Record<string, SeriesPoint[]>;
}

export interface RegimeHistoryEntry {
  date: string;
  label: RegimeLabel;
  confidence: number;
  reason: string;
  inputs: { vix: number | null; y2: number | null; y10: number | null };
}

export interface RegimeHistoryResponse {
  days: number;
  history: RegimeHistoryEntry[];
  recent_transitions: {
    date: string;
    from: RegimeLabel;
    to: RegimeLabel;
    reason: string;
  }[];
}

export interface HealthResponse {
  status: string;
  fred_configured: boolean;
  anthropic_configured: boolean;
  claude_model: string;
}

// ---------- Panel 2: Regime Journal ----------

export interface RegimeSegment {
  label: RegimeLabel;
  start: string;            // YYYY-MM-DD
  end: string;              // YYYY-MM-DD inclusive
}

export interface JournalSpxResponse {
  days: number;
  spx: SeriesPoint[];
  regime_history: RegimeHistoryEntry[];
  segments: RegimeSegment[];
}

export interface StressTestPosition {
  ticker: string;
  weight: number;
}

export interface StressTestSegmentReturn {
  label: RegimeLabel;
  start: string;
  end: string;
  return: number | null;
}

export interface StressTestPositionResult {
  ticker: string;
  weight: number;
  regime_returns: Record<RegimeLabel, number | null>;
  per_segment: StressTestSegmentReturn[];
  total_return: number | null;
  data_points: number;
}

export interface StressTestResponse {
  segments: { label: RegimeLabel; start: string; end: string; days: number }[];
  positions: StressTestPositionResult[];
  aggregate_by_regime: Record<RegimeLabel, number | null>;
}

// ---------- Panel 3: Cross-Asset Correlations ----------

export interface CorrelationMatrix {
  recent:   (number | null)[][];
  baseline: (number | null)[][];
  delta:    (number | null)[][];
}

export interface CorrelationGroup {
  name:   string;
  ticker: string;
  label:  string;
}

export interface CorrelationBreakdown {
  a:        string;
  b:        string;
  recent:   number | null;
  baseline: number | null;
  delta:    number | null;
  flipped:  boolean;
}

export interface CorrelationsResponse {
  tickers:      string[];
  groups:       CorrelationGroup[];
  recent_days:  number;
  baseline_days: number;
  matrix:       CorrelationMatrix;
  breakdowns:   CorrelationBreakdown[];
  dates: { first: string | null; last: string | null; count: number };
}

// ---------- Panel 4: SEC Filings ----------

export interface Filing {
  ticker:      string;
  cik:         string;
  accession:   string;
  form:        string;
  filing_date: string;          // YYYY-MM-DD
  report_date: string;
  description: string;
  items:       string;          // comma-separated 8-K item codes
  url:         string;
  form_label:  string;
}

export interface FormMeta {
  label: string;
  color: string;
}

export interface FilingsResponse {
  filings:    Filing[];
  fetched_at: string;
  days:       number;
  tickers:    string[];
  resolved:   string[];
  unresolved: string[];
  forms:      string[];
  form_meta:  Record<string, FormMeta>;
}

export interface FilingsDefaults {
  default_tickers: string[];
  form_meta:       Record<string, FormMeta>;
}

// ---------- Panel 5 / 6: DuckDB ----------

export interface DbStatus {
  tables: Record<string, number>;
  instrument_types: Record<string, number>;
  price_range: { first: string | null; last: string | null };
  fundamentals_range: { first: string | null; last: string | null };
  recent_runs: EtlRun[];
  db_path: string;
}

export interface EtlRun {
  id: number;
  source: string;
  target: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  rows_out: number;
  note: string | null;
}

export interface InstrumentSearchResult {
  symbol: string;
  cik: string | null;
  name: string;
  type: string;
  source: string;
}

export interface FundamentalsQuarter {
  period_end: string;
  period_label: string;
  revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  net_income: number | null;
  eps_basic: number | null;
  eps_diluted: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  net_margin: number | null;
  operating_cash_flow: number | null;
  free_cash_flow: number | null;
  total_assets: number | null;
  total_equity: number | null;
  long_term_debt: number | null;
}

export interface FundamentalsResponse {
  symbol: string;
  quarters: FundamentalsQuarter[];
  count: number;
}

// ---------- Panel 7: News ----------

export interface NewsItem {
  title: string;
  publisher: string;
  url: string;
  summary: string;
  published: string | null;
  tickers: string[];
  source: string;
}

export interface NewsFeed {
  items: NewsItem[];
  tickers: string[];
  fetched_at: string;
  elapsed_s: number;
}

// ---------- Panel 8: Options ----------

export interface VixTenor {
  ticker: string;
  label: string;
  value: number | null;
}

export interface VixTerm {
  tenors: VixTenor[];
  spot: number | null;
  back: number | null;
  slope: number | null;
  structure: "contango" | "backwardation" | "flat" | "unknown";
  fetched_at: string;
}

export interface ChainSummary {
  symbol: string;
  expiry: string | null;
  spot: number | null;
  atm_strike: number | null;
  iv_calls: number | null;
  iv_puts: number | null;
  iv_skew: number | null;
  pc_ratio_oi: number | null;
  pc_ratio_vol: number | null;
  implied_move_1sigma: number | null;
  days_to_expiry: number | null;
  error: string | null;
}

export interface ChainSummaries {
  summaries: ChainSummary[];
  fetched_at: string;
}

// ---------- Panel 9: Earnings ----------

export interface EarningsEvent {
  date: string;
  estimate: number | null;
  actual: number | null;
  surprise_pct: number | null;       // decimal (0.0349 = +3.49%)
  reaction_1d: number | null;
  reaction_5d: number | null;
}

export interface EarningsStats {
  n: number;
  beat_rate: number | null;
  avg_surprise: number | null;
  avg_reaction_1d: number | null;
}

export interface EarningsResult {
  symbol: string;
  next_earnings: string | null;
  eps_estimate: number | null;
  revenue_estimate: number | null;
  stats: EarningsStats;
  events: EarningsEvent[];
  error: string | null;
}

export interface EarningsOverview {
  tickers: string[];
  results: EarningsResult[];
  fetched_at: string;
}
