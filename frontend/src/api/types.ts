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
  uw_configured: boolean;
  claude_model: string;
}

// ---------- Unusual Whales: Market News + Market Insiders ----------

export interface MarketNewsItem {
  id: string; title: string; url: string; source: string;
  published: string | null; tickers: string[];
  sentiment: string | null; is_major: boolean; tags: string[]; summary: string;
}
export interface MarketNewsResponse {
  items: MarketNewsItem[]; count: number;
  configured: boolean; degraded: boolean; error: string | null;
  fetched_at: string; source: string;
}
export interface MarketInsiderTransaction {
  ticker: string; company: string | null;
  insider_name: string; insider_title: string | null;
  is_director: boolean; is_officer: boolean; is_ten_pct: boolean;
  txn_date: string | null; filing_date: string | null;
  txn_code: string; direction: "buy" | "sell" | "other";
  shares: number | null; price: number | null; value: number | null;
  shares_after: number | null; source_url: string | null;
}
export interface MarketInsiderSummary {
  total: number; buy_count: number; sell_count: number;
  buy_value: number; sell_value: number; net_value: number;
  unique_tickers: number; unique_insiders: number; buy_sell_ratio: number;
}
export interface MarketInsidersResponse {
  transactions: MarketInsiderTransaction[]; summary: MarketInsiderSummary;
  count: number; configured: boolean; degraded: boolean; error: string | null;
  fetched_at: string; filters: { direction: string; min_value: number; ticker: string | null };
  source: string;
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

export interface DataHealthSource {
  source: string;
  last_updated: string | null;
  age_hours: number | null;
  status: "fresh" | "stale" | "missing";
}

export interface DataHealthResponse {
  sources: DataHealthSource[];
  cache: { rows: number | null; size_bytes: number | null };
  scheduler: {
    id: string;
    name: string;
    next_run_time: string | null;
    trigger: string;
  }[];
  summary: { fresh: number; stale: number; missing: number };
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

// ---------- Panel 10: Daily Briefing ----------

export interface DailyBriefingContext {
  regime?: RegimeState;
  vix_term?: VixTerm;
  top_breakdowns?: CorrelationBreakdown[];
  upcoming_earnings?: {
    symbol: string;
    date: string;
    in_days: number;
    eps_estimate: number | null;
    beat_rate: number | null;
    avg_reaction: number | null;
  }[];
  recent_8k?: {
    ticker: string;
    filing_date: string;
    items: string;
    url: string;
  }[];
  top_news?: { title: string; publisher: string; tickers: string[]; published: string | null }[];
  as_of?: string;
}

export interface DailyBriefingCached {
  date?: string;
  kind?: string;
  regime_label?: string | null;
  summary: string | null;
  context: DailyBriefingContext | null;
  generated_at: string | null;
}

// ---------- Panel 12/13/14: Macro Explorer + Energy + Shipping ----------

export interface MacroCatalogSeries {
  id: string;
  label: string;
  unit: string;
  frequency: string;
  note: string;
}

export interface MacroCategory {
  id: string;
  label: string;
  count: number;
  series: MacroCatalogSeries[];
}

export interface MacroCatalog {
  categories: MacroCategory[];
  order: string[];
}

export interface MacroTile {
  id: string;
  label: string;
  unit?: string;
  frequency?: string;
  note?: string;
  category?: string;
  source?: string;
  latest: number | null;
  latest_date: string | null;
  prior?: number | null;
  prior_date?: string | null;
  delta_abs?: number | null;
  delta_pct: number | null;
  min_1y?: number | null;
  max_1y?: number | null;
  trail: SeriesPoint[];
  error?: string | null;
}

export interface MacroSnapshot {
  category: string;
  category_label: string;
  tiles: MacroTile[];
}

export interface EnergySection {
  section: string;
  label: string;
  tiles: MacroTile[];
  fetched_at?: string;
}

export interface EnergyDashboard {
  sections: EnergySection[];
  fetched_at: string;
}

export interface ShippingDashboard {
  tiles: MacroTile[];
  fetched_at: string;
}

// ─── Wave 2: Watchlists (DB-backed multi) ─────────────────────────────────

export interface WatchlistSummary {
  id: number;
  name: string;
  description: string | null;
  is_default: boolean;
  created_at: string | null;
  updated_at: string | null;
  item_count: number;
}

export interface WatchlistItem {
  ticker: string;
  label: string | null;
  group_name: string | null;
  order_index: number;
  added_at: string | null;
}

export interface Watchlist {
  id: number;
  name: string;
  description: string | null;
  is_default: boolean;
  created_at: string | null;
  updated_at: string | null;
  items: WatchlistItem[];
}

// ─── Wave 2: Technical Indicators ─────────────────────────────────────────

export type IndicatorKind = "sma" | "ema" | "rsi" | "macd" | "bollinger" | "crossovers";

export interface IndicatorPoint {
  date: string;
  value: number;
}

export interface SmaEmaResponse {
  indicator: "sma" | "ema";
  period: number;
  points: IndicatorPoint[];
}

export interface RsiResponse {
  indicator: "rsi";
  period: number;
  overbought: number;
  oversold: number;
  points: IndicatorPoint[];
}

export interface MacdResponse {
  indicator: "macd";
  fast: number;
  slow: number;
  signal: number;
  line: IndicatorPoint[];
  signal_line: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

export interface BollingerResponse {
  indicator: "bollinger";
  period: number;
  std_dev: number;
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export interface CrossoverEvent {
  date: string;
  type: "golden_cross" | "death_cross";
  fast_ma: number | null;
  slow_ma: number | null;
}

export interface CrossoversResponse {
  indicator: "crossovers";
  fast: number;
  slow: number;
  events: CrossoverEvent[];
}

export type IndicatorResponse =
  | SmaEmaResponse
  | RsiResponse
  | MacdResponse
  | BollingerResponse
  | CrossoversResponse;

// ─── Wave 2: Sector Rotation ──────────────────────────────────────────────

export interface SectorReturn {
  abs: number | null;       // absolute return %
  rel: number | null;       // relative to benchmark %
}

export interface SectorRow {
  ticker: string;
  name: string;
  last_close: number | null;
  last_date: string | null;
  returns: Record<string, SectorReturn>;
}

export interface SectorRotationWindow {
  key: string;
  label: string;
  days: number | null;
}

export interface SectorRotationResponse {
  windows: SectorRotationWindow[];
  benchmark: {
    ticker: string;
    returns: Record<string, number | null>;
  };
  sectors: SectorRow[];
}

// ─── Insider Transactions ─────────────────────────────────────────────────

export interface InsiderTransaction {
  insider_name: string;
  insider_title: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_pct: boolean;
  txn_date: string | null;
  txn_code: string;
  shares: number | null;
  price_per_share: number | null;
  total_value: number | null;
  shares_after: number | null;
  ownership_type: string | null;
  filing_date: string | null;
  source_url: string | null;
}

export interface InsiderCluster {
  start_date: string;
  end_date: string;
  insider_count: number;
  insiders: string[];
  signal: string;
}

export interface InsiderSummary {
  total_transactions: number;
  buy_count: number;
  sell_count: number;
  buy_value: number;
  sell_value: number;
  buy_shares: number;
  sell_shares: number;
  net_value: number;
  net_shares: number;
  unique_buyers: number;
  unique_sellers: number;
  buy_sell_ratio: number;
}

export interface InsiderTickerResponse {
  symbol: string;
  days: number;
  transactions: InsiderTransaction[];
  summary: InsiderSummary;
  clusters: InsiderCluster[];
}

// ─── 13F Institutional Holdings ──────────────────────────────────────────

export interface InstitutionalFiler {
  name: string;
  cik: string;
  holdings_count: number;
  latest_quarter: string | null;
  latest_filing: string | null;
}

export interface InstitutionalHolding {
  name_of_issuer: string;
  cusip: string | null;
  symbol: string | null;
  shares: number | null;
  value_x1000: number | null;
  put_call: string | null;
  report_date: string | null;
  filing_date: string | null;
}

export interface InstitutionalHolder {
  filer_name: string;
  filer_cik: string;
  shares: number | null;
  value_x1000: number | null;
  report_date: string | null;
  filing_date: string | null;
}

export interface InstitutionalPortfolio {
  filer_cik: string;
  filer_name: string;
  report_date: string | null;
  holdings: InstitutionalHolding[];
  total_value: number;
  position_count: number;
}

export interface InstitutionalChange {
  cusip: string;
  name_of_issuer: string;
  change_type: "new_position" | "exited" | "increased" | "decreased" | "unchanged";
  current_shares: number;
  prior_shares: number;
  share_delta: number;
  share_delta_pct: number | null;
  current_value: number;
  prior_value: number;
}

export interface InstitutionalChanges {
  filer_cik: string;
  filer_name: string;
  current_quarter: string;
  prior_quarter: string;
  changes: InstitutionalChange[];
  summary: {
    new_positions: number;
    exited: number;
    increased: number;
    decreased: number;
    unchanged: number;
  };
}

// ─── Compare / Portfolio Simulator ────────────────────────────────────────

export interface CompareMetric {
  symbol: string;
  data_points: number;
  start_date: string | null;
  end_date: string | null;
  start_price: number | null;
  end_price: number | null;
  total_return_pct: number | null;
  annualized_return_pct: number | null;
  volatility_pct: number | null;
  sharpe_ratio: number | null;
  max_drawdown_pct: number | null;
  dividend_yield: number | null;
}

export interface CompareResponse {
  tickers: string[];
  days: number;
  normalized: Record<string, SeriesPoint[]>;
  metrics: CompareMetric[];
  correlation: {
    symbols: string[];
    matrix: (number | null)[][];
  };
}

export interface PortfolioSimResponse {
  positions: { ticker: string; weight: number }[];
  days: number;
  common_dates: number;
  equity_curve: SeriesPoint[];
  total_return_pct: number | null;
  annualized_return_pct: number | null;
  volatility_pct: number | null;
  sharpe_ratio: number | null;
  max_drawdown_pct: number | null;
  blended_dividend_yield: number | null;
}

// ─── Real Estate Deep-Dive ────────────────────────────────────────────────

export interface ReSubsectorListItem {
  id: string;
  name: string;
  description: string;
  stock_count: number;
  etfs: string[];
}

export interface ReStockRow {
  symbol: string;
  name: string;
  last_close: number | null;
  last_date: string | null;
  returns: Record<string, SectorReturn>;
  market_cap: number | null;
  pe_ratio: number | null;
  forward_pe: number | null;
  dividend_yield: number | null;
  price_to_book: number | null;
  beta: number | null;
  fifty_two_week_high: number | null;
  fifty_two_week_low: number | null;
  avg_volume: number | null;
  industry: string | null;
  payout_ratio: number | null;
  debt_to_equity: number | null;
  return_on_equity: number | null;
  revenue_growth: number | null;
  earnings_growth: number | null;
}

export interface ReSubsectorDetail {
  subsector_id: string;
  name: string;
  description: string;
  windows: SectorRotationWindow[];
  benchmark: {
    ticker: string;
    returns: Record<string, number | null>;
  };
  etfs: SectorEtfRow[];
  stocks: ReStockRow[];
}

export interface ReOverview {
  windows: SectorRotationWindow[];
  spy_returns: Record<string, number | null>;
  benchmarks: SectorEtfRow[];
  subsectors: ReSubsectorListItem[];
}

// ─── Sector Detail ────────────────────────────────────────────────────────

export interface SectorListItem {
  id: string;
  name: string;
  etf: string;
  icon: string;
  description: string;
  stock_count: number;
}

export interface SectorStockRow {
  symbol: string;
  name: string;
  last_close: number | null;
  last_date: string | null;
  returns: Record<string, SectorReturn>;
  market_cap: number | null;
  pe_ratio: number | null;
  forward_pe: number | null;
  dividend_yield: number | null;
  beta: number | null;
  fifty_two_week_high: number | null;
  fifty_two_week_low: number | null;
  avg_volume: number | null;
  sector: string | null;
  industry: string | null;
}

export interface SectorEtfRow {
  ticker: string;
  last_close: number | null;
  returns: Record<string, SectorReturn>;
}

export interface SectorDetailResponse {
  sector_id: string;
  name: string;
  description: string;
  icon: string;
  sub_industries: string[];
  windows: SectorRotationWindow[];
  benchmark: {
    ticker: string;
    returns: Record<string, number | null>;
  };
  etf: {
    ticker: string;
    name: string;
    last_close: number | null;
    returns: Record<string, SectorReturn>;
    market_cap: number | null;
  };
  stocks: SectorStockRow[];
  related_etfs: SectorEtfRow[];
}

export interface SectorOverviewItem {
  id: string;
  name: string;
  etf: string;
  icon: string;
  last_close: number | null;
  returns: Record<string, SectorReturn>;
}

export interface SectorOverviewResponse {
  windows: SectorRotationWindow[];
  benchmark: {
    ticker: string;
    returns: Record<string, number | null>;
  };
  sectors: SectorOverviewItem[];
}

// ─── Sector Supply Chain ──────────────────────────────────────────────────

export interface SupplyChainNode {
  id: string;
  name: string;
  etf: string;
}

export interface SectorSupplyChainResponse {
  sector_id: string;
  upstream: SupplyChainNode[];
  downstream: SupplyChainNode[];
  correlated: SupplyChainNode[];
  notes: string;
}

// ─── Sector Relative Strength ─────────────────────────────────────────────

export interface RsSeries {
  key: string;
  label: string;
  color: string;
  points: { date: string; value: number }[];
}

export interface SectorRsResponse {
  sector_id: string;
  etf: string;
  benchmark: string;
  error?: string;
  series: RsSeries[];
  current: { rs_raw?: number | null; rs_20d?: number | null; rs_60d?: number | null };
  outperforming_20d: boolean | null;
  outperforming_60d: boolean | null;
}

// ─── Sector News + Earnings ───────────────────────────────────────────────

export interface NewsItem {
  title: string;
  publisher: string;
  url: string;
  summary: string;
  published: string | null;
  tickers: string[];
  source: string;
}

export interface SectorNewsResponse {
  items: NewsItem[];
  tickers: string[];
  fetched_at: string;
  elapsed_s: number;
}

export interface EarningsCalendar {
  symbol: string;
  next_earnings: string | null;
  eps_estimate: number | null;
  revenue_estimate: number | null;
  error: string | null;
}

export interface SectorEarningsResponse {
  sector_id: string;
  today: string;
  calendars: EarningsCalendar[];
}

// ─── Sector Macro Drivers ─────────────────────────────────────────────────

export interface SectorMacroDriver {
  id: string;
  label: string;
  source: "fred" | "yfinance";
  direction: "+" | "-";
  desc: string;
  correlation: number | null;
  available: boolean;
  n_obs?: number;
}

export interface SectorMacroDriversResponse {
  sector_id: string;
  etf: string;
  lookback_days: number;
  fred_available: boolean;
  drivers: SectorMacroDriver[];
}

// ─── Sector KPIs ──────────────────────────────────────────────────────────

export interface SectorKpiDef {
  key: string;
  label: string;
  unit: string;
  desc: string;
}

export interface SectorKpisResponse {
  sector_id: string;
  kpi_defs: SectorKpiDef[];
  sector_medians: Record<string, number | null>;
  stocks: Array<Record<string, number | null | string>>;
}

// ─── Sector: Peer comparison chart ───────────────────────────────────────

export interface PeerSeries {
  symbol: string;
  points: { date: string; value: number }[];
  ytd_pct: number;
  last_close: number;
}

export interface SectorPeerComparisonResponse {
  sector_id: string;
  etf: string;
  series: PeerSeries[];
  best: string | null;
  worst: string | null;
}

// ─── Sector: Breadth indicators ──────────────────────────────────────────

export interface SectorBreadthStock {
  symbol: string;
  price: number;
  ma50: number | null;
  ma200: number | null;
  high_52w: number;
  low_52w: number;
  above_50ma: boolean;
  above_200ma: boolean;
  at_52w_high: boolean;
  at_52w_low: boolean;
  dist_from_52w_high_pct: number | null;
}

export interface SectorBreadthSummary {
  above_50ma_count: number;
  above_50ma_pct: number;
  above_200ma_count: number;
  above_200ma_pct: number;
  at_52w_high_count: number;
  at_52w_high_pct: number;
  at_52w_low_count: number;
  at_52w_low_pct: number;
  avg_dist_from_52w_high_pct: number | null;
}

export interface SectorBreadthResponse {
  sector_id: string;
  stock_count: number;
  stocks: SectorBreadthStock[];
  summary: SectorBreadthSummary | null;
}

// ─── Sector: Regime playbook ──────────────────────────────────────────────

export interface RegimePlaybookRow {
  regime: string;
  label: string;
  is_current: boolean;
  days: number;
  etf_avg_daily_pct: number;
  etf_annualized_pct: number;
  spy_avg_daily_pct: number;
  spy_annualized_pct: number;
  avg_excess_daily_pct: number;
  avg_excess_annualized_pct: number;
  beat_rate_pct: number;
  best_day_pct: number;
  worst_day_pct: number;
}

export interface SectorRegimePlaybookResponse {
  sector_id: string;
  etf: string;
  current_regime: string;
  total_days?: number;
  regimes: RegimePlaybookRow[];
  error?: string;
}

// ─── Sector: Sub-industry decomposition ──────────────────────────────────

export interface SubIndustryMember {
  symbol: string;
  market_cap: number | null;
  returns_pct: Record<string, number | null>;
}

export interface SubIndustryTopPerformer {
  symbol: string;
  return_pct: number;
  weight_in_subi: number | null;
  contribution_pct: number | null;
}

export interface SubIndustryRow {
  name: string;
  stock_count: number;
  total_market_cap: number | null;
  weight_pct_of_sector: number | null;
  members: SubIndustryMember[];
  returns_pct: Record<string, number | null>;
  top_per_window: Record<string, SubIndustryTopPerformer | null>;
}

export interface SectorSubIndustriesResponse {
  sector_id: string;
  name: string;
  etf: string;
  available: boolean;
  reason?: string;
  windows: { key: string; label: string }[];
  sub_industries: SubIndustryRow[];
  sector_total_market_cap: number | null;
  notes?: string;
}

// ─── Sector: Flows (pair spreads + options) ──────────────────────────────

export interface PairSpread {
  label: string;
  numer: string;
  denom: string;
  current: number | null;
  change_1w_pct: number | null;
  change_1m_pct: number | null;
  change_3m_pct: number | null;
  change_ytd_pct: number | null;
  spark: { date: string; value: number }[];
  n_obs: number;
}

export interface SectorFlowsOptions {
  spot: number | null;
  expiry_30: string | null;
  expiry_90: string | null;
  days_to_30: number | null;
  days_to_90: number | null;
  atm_iv_30d: number | null;
  atm_iv_90d: number | null;
  term_structure_delta: number | null;
  term_inverted: boolean;
  iv_skew_30d: number | null;
  iv_skew_90d: number | null;
  pc_ratio_oi_30d: number | null;
  pc_ratio_vol_30d: number | null;
  implied_move_1sigma_30d: number | null;
  implied_move_1sigma_90d: number | null;
  realized_vol_21d_ann: number | null;
  iv_vs_realized_ratio: number | null;
  error_30: string | null;
  error_90: string | null;
}

export interface SectorFlowsResponse {
  sector_id: string;
  name?: string;
  etf: string;
  pair_partner: string;
  pair_description: string;
  pairs: PairSpread[];
  options: SectorFlowsOptions;
  available: boolean;
}

// ─── Sector: Credit + bond layer ─────────────────────────────────────────

export interface SectorCreditKpi {
  id: string;
  label: string;
  source: "fred" | "yfinance" | "derived";
  unit: string;
  desc: string;
  last_value: number | null;
  last_date: string | null;
  change_1d_pct: number | null;
  change_1w_pct: number | null;
  change_1m_pct: number | null;
  change_3m_pct: number | null;
  change_ytd_pct: number | null;
  change_1d_abs: number | null;
  change_1w_abs: number | null;
  change_1m_abs: number | null;
  spark: { date: string; value: number }[];
  available: boolean;
  reason?: string;
}

export interface SectorCreditBucket {
  label: string;
  kpis: SectorCreditKpi[];
  sector_specific?: boolean;
}

export interface CreditDivergence {
  available: boolean;
  reason?: string;
  current_corr?: number;
  baseline_mean?: number;
  baseline_std?: number;
  z_score?: number | null;
  flagged?: boolean;
  window?: number;
  n_obs?: number;
  interpretation?: string;
}

export interface SectorCreditResponse {
  sector_id: string;
  name?: string;
  etf: string;
  fred_available: boolean;
  lookback_days?: number;
  spark_tail?: number;
  buckets: SectorCreditBucket[];
  divergence: CreditDivergence;
  available: boolean;
}

// ─── Sector: Risk + drawdowns ────────────────────────────────────────────

export interface DrawdownRow {
  peak_date: string;
  peak_value: number;
  trough_date: string;
  trough_value: number;
  recovery_date: string | null;
  depth_pct: number;
  drawdown_days: number | null;
  recovery_days: number | null;
  total_days: number | null;
  ongoing: boolean;
  trough_regime: string;
}

export interface TailRisk {
  annual_return_pct: number | null;
  annual_vol_pct: number | null;
  vol_21d_annualized_pct: number | null;
  vol_252d_annualized_pct: number | null;
  sharpe_ann: number | null;
  sortino_ann: number | null;
  downside_dev_ann_pct: number | null;
  cvar_95_daily_pct: number | null;
  max_dd_depth_pct: number | null;
  max_dd_duration_days: number | null;
  n_obs: number;
}

export interface VolRegime {
  current_vol_pct: number | null;
  percentile: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

export interface CorrelationToSpy {
  current: number | null;
  mean: number | null;
  std: number | null;
  z: number | null;
  percentile: number | null;
  window?: number;
}

export interface SectorRiskResponse {
  sector_id: string;
  name?: string;
  etf: string;
  lookback_days?: number;
  available: boolean;
  reason?: string;
  regime_classifier_available: boolean;
  drawdowns: DrawdownRow[];
  drawdown_count_total?: number;
  tail_risk: TailRisk | Record<string, never>;
  vol_regime: VolRegime;
  correlation_to_spy: CorrelationToSpy;
  equity_curve: { date: string; value: number }[];
}

// ─── Sector: AI Briefing ─────────────────────────────────────────────────

export interface SectorBriefingContext {
  sector_id: string;
  sector_name: string;
  etf: string;
  etf_returns_pct: Record<string, number | null>;
  concentration: {
    herfindahl: number;
    constituent_count: number;
    top1_weight_pct: number;
    top3_weight_pct: number;
    top5_weight_pct: number;
    top10_weight_pct: number;
  } | null;
  top_contributors_1m: Array<{
    symbol: string;
    weight_pct: number;
    return_1m_pct: number | null;
    contribution_1m_pct: number | null;
  }>;
  bottom_contributors_1m: Array<{
    symbol: string;
    weight_pct: number;
    return_1m_pct: number | null;
    contribution_1m_pct: number | null;
  }>;
  hidden_weakness: {
    window: string;
    basket_return_pct: number;
    pct_constituents_negative: number;
    n_constituents: number;
    n_negative: number;
    masking_names: { symbol: string; contribution_pct: number }[];
  } | null;
  breadth: {
    above_50ma_pct: number | null;
    above_200ma_pct: number | null;
    at_52w_high_pct: number | null;
    at_52w_low_pct: number | null;
    avg_dist_from_52w_high_pct: number | null;
    stock_count: number | null;
  } | null;
  top_macro_drivers: Array<{
    id: string;
    label: string;
    correlation: number;
    expected: "+" | "-" | null;
    desc: string | null;
  }>;
  recent_news: Array<{
    title: string | null;
    publisher: string | null;
    tickers: string[];
    published: string | null;
  }>;
  regime: Record<string, unknown>;
  as_of: string;
}

export interface SectorBriefingCached {
  sector_id: string;
  date: string | null;
  regime_label?: string;
  summary: string | null;
  context: SectorBriefingContext | null;
  generated_at?: string;
}

// ─── Sector: Constituent decomposition ──────────────────────────────────

export interface DecompositionConstituent {
  symbol: string;
  market_cap: number | null;
  weight_pct: number;
  returns_pct: Record<string, number | null>;
  contributions_pct: Record<string, number | null>;
}

export interface DecompositionConcentration {
  herfindahl: number;
  constituent_count: number;
  top1_weight_pct: number;
  top3_weight_pct: number;
  top5_weight_pct: number;
  top10_weight_pct: number;
}

export interface IfRemovedRow {
  label: string;
  removed: string[];
  return_pct: number | null;
  delta_vs_full_pct: number | null;
}

export interface HiddenWeaknessResult {
  basket_return_pct: number;
  pct_constituents_negative: number;
  n_constituents: number;
  n_negative: number;
  masking_names: { symbol: string; contribution_pct: number }[];
}

export interface SectorDecompositionResponse {
  sector_id: string;
  name: string;
  etf: string;
  windows: { key: string; label: string }[];
  constituents: DecompositionConstituent[];
  basket_returns_pct: Record<string, number | null>;
  etf_returns_pct: Record<string, number | null>;
  concentration: DecompositionConcentration;
  if_removed: Record<string, IfRemovedRow[]>;
  hidden_weakness: Record<string, HiddenWeaknessResult | null>;
  notes: string;
}

// ─── Sector: Operational KPIs (factory dashboard) ────────────────────────

export interface SectorOperationalKpi {
  id: string;
  label: string;
  source: "fred" | "yfinance" | "derived";
  unit: string;
  desc: string;
  last_value: number | null;
  last_date: string | null;
  change_1d_pct: number | null;
  change_1w_pct: number | null;
  change_1m_pct: number | null;
  change_3m_pct: number | null;
  change_ytd_pct: number | null;
  change_1d_abs: number | null;
  change_1w_abs: number | null;
  change_1m_abs: number | null;
  spark: { date: string; value: number }[];
  available: boolean;
  reason?: string;
}

export interface SectorOperationalBucket {
  label: string;
  kpis: SectorOperationalKpi[];
}

export interface SectorOperationalResponse {
  sector_id: string;
  fred_available: boolean;
  lookback_days?: number;
  spark_tail?: number;
  buckets: SectorOperationalBucket[];
  derived: SectorOperationalKpi[];
  available: boolean;
  reason?: string;
}

// ─── Wave 2: Screener ─────────────────────────────────────────────────────

export type ScreenerFilterType = "number" | "text";

export interface ScreenerFilterMeta {
  key: string;
  type: ScreenerFilterType;
}

export interface ScreenerSchema {
  filters: ScreenerFilterMeta[];
  ops: {
    number: string[];
    text: string[];
  };
  sort_keys: string[];
}

export interface ScreenerFilter {
  key: string;
  op: string;
  value: number | string | (number | string)[];
}

export interface ScreenerResult {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  type: string | null;
  country: string | null;
  last_close: number | null;
  last_close_date: string | null;
  revenue: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  net_margin: number | null;
  eps_diluted: number | null;
  free_cash_flow: number | null;
  revenue_yoy_pct: number | null;
}

export interface ScreenerResponse {
  filters: ScreenerFilter[];
  sort: string;
  sort_dir: string;
  limit: number;
  offset: number;
  count: number;
  results: ScreenerResult[];
}

// ─── Wave 3: Multi-indicator + Calendar + Drawings ────────────────────────

export type Timeframe = "1d" | "1w" | "1mo";

export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number;
  volume: number;
}

export interface MultiIndicatorRequest {
  symbol: string;
  indicators: string[];
  timeframe?: Timeframe;
  days?: number;
  params?: Record<string, Record<string, number | string>>;
}

export interface SignalVotes {
  [key: string]: number;
}

export interface SignalStrengthResponse {
  indicator: "signal_strength";
  score: number | null;
  bucket: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" | "insufficient_data";
  votes: SignalVotes;
}

export interface MultiIndicatorResponse {
  symbol: string;
  timeframe: Timeframe;
  bars: OHLCVBar[];
  // Each indicator key maps to its own response shape; consumers should
  // narrow by `indicator` field. Untyped here because the union is big.
  indicators: Record<string, unknown>;
}

// Events Calendar

export type EventImpact = "high" | "medium" | "low";
export type EventCategory =
  | "inflation" | "employment" | "growth" | "monetary_policy"
  | "housing" | "sentiment" | "trade" | "earnings";

export interface CalendarEvent {
  date: string;
  time: string | null;
  name: string;
  category: EventCategory;
  impact: EventImpact;
  source: string;
  description: string;
  market_impact: string;
}

export interface CalendarDay {
  date: string;
  weekday: string;
  events: CalendarEvent[];
}

export interface CalendarWeekResponse {
  start: string;
  end: string;
  days: CalendarDay[];
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface CalendarUpcomingResponse {
  start: string;
  end: string;
  events: CalendarEvent[];
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
  };
}

// Chart Drawings

export type DrawingType =
  | "trend_line" | "hline" | "vline" | "fib_retracement" | "rectangle" | "text";

export interface DrawingPoint {
  time: string;
  price: number;
}

export interface DrawingStyle {
  color?: string;
  line_width?: number;
  line_style?: "solid" | "dashed" | "dotted";
  fill?: string;
  opacity?: number;
}

export interface Drawing {
  id: number;
  symbol: string;
  timeframe: Timeframe;
  drawing_type: DrawingType | "parallel_channel" | "fib_extension" | "fib_time_zones"
              | "risk_reward" | "arrow" | "anchored_vwap_anchor";
  points: DrawingPoint[];
  style: DrawingStyle;
  label: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ─── Wave 4: extended TA panel types ──────────────────────────────────────

export type ExtendedDrawingType = DrawingType |
  "parallel_channel" | "fib_extension" | "fib_time_zones" |
  "risk_reward" | "arrow" | "anchored_vwap_anchor";

export interface ChartLayoutState {
  enabled?: string[];                                       // indicator keys turned on
  params?: Record<string, Record<string, number | string>>; // per-indicator overrides
  chartType?: "candle" | "line" | "area" | "heikin_ashi";
  scaleType?: "linear" | "log";
  compareSymbol?: string | null;
  showMarkers?: boolean;
  snapToOhlc?: boolean;
  drawingsLocked?: boolean;
  days?: number;
}

export interface ChartLayout {
  symbol: string;
  timeframe: Timeframe;
  state: ChartLayoutState | null;
  updated_at: string | null;
}

export type ChartMarkerKind = "filing" | "earnings" | "macro";

export interface ChartMarker {
  date: string;
  kind: ChartMarkerKind;
  label: string;
  detail: string;
  impact: "high" | "medium" | "low";
  color: string;
}

export interface ChartEventsResponse {
  symbol: string;
  markers: ChartMarker[];
}

// Support/resistance & divergence response shapes

export interface SupportResistanceLevel {
  price: number;
  touches: number;
  first_date: string;
  last_date: string;
  types: ("support" | "resistance")[];
}

export interface SupportResistanceResponse {
  indicator: "support_resistance";
  pivot_window: number;
  levels: SupportResistanceLevel[];
}

export interface DivergenceEvent {
  type: "bullish" | "bearish";
  from_date: string;
  to_date: string;
  price_from: number;
  price_to: number;
  indicator_from: number;
  indicator_to: number;
}

export interface DivergenceResponse {
  indicator: "divergence";
  kind: "rsi" | "macd";
  period: number;
  events: DivergenceEvent[];
}

export interface HeikinAshiBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface HeikinAshiResponse {
  indicator: "heikin_ashi";
  bars: HeikinAshiBar[];
}

// ───────── Wave 5: Mile-deep Macro ─────────

export interface CurvePoint {
  maturity: string;
  years: number;
  yield: number | null;
  prior?: number | null;
  delta_bps?: number | null;
  fred_id: string;
}

export interface YieldCurve {
  date: string | null;
  prior_date: string | null;
  kind: "nominal" | "real";
  points: CurvePoint[];
}

export interface CurveShape {
  spread_2_10_bps: number | null;
  spread_3m_10y_bps: number | null;
  spread_10_30_bps: number | null;
  classification: string;
}

export interface SpreadSeries {
  id: string;
  label?: string;
  description: string;
  points: SeriesPoint[];
}

export interface RecessionProbabilityPoint {
  date: string;
  spread: number;
  probability: number;
}

export interface RecessionProbabilityCurrent extends RecessionProbabilityPoint {
  summary: string;
  model: string;
}

export interface YieldCurveDashboard {
  curve: YieldCurve;
  real_curve: YieldCurve;
  shape: CurveShape;
  spreads: SpreadSeries[];
  butterflies: SpreadSeries[];
  recession: {
    current: RecessionProbabilityCurrent;
    history: RecessionProbabilityPoint[];
  };
  term_premium: {
    points: SeriesPoint[];
    summary: string | null;
    method: string;
  };
  maturities: { id: string; label: string; years: number }[];
}

// ── Inflation
export interface InflationMomentumSeries {
  series_id: string;
  label?: string;
  yoy: SeriesPoint[];
  mom_annualized: SeriesPoint[];
  three_m_ann: SeriesPoint[];
  six_m_ann: SeriesPoint[];
  is_rate: boolean;
}

export interface InflationClassification {
  label: string;
  summary: string;
  above_target_pp?: number;
  accelerating?: boolean;
}

export interface InflationExpectationPoint {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  date: string | null;
}

export interface InflationDecomposition {
  nominal: SeriesPoint[];
  real: SeriesPoint[];
  breakeven: SeriesPoint[];
}

export interface InflationDashboard {
  series: InflationMomentumSeries[];
  expectations: { points: InflationExpectationPoint[] };
  decomposition: InflationDecomposition;
  classification: InflationClassification;
  summary: {
    core_pce_yoy: number | null;
    headline_pce_yoy: number | null;
    core_pce_3m_ann: number | null;
    fed_target: number;
  };
}

// ── Recession
export interface SahmRule {
  current: number | null;
  triggered: boolean;
  history: { date: string; value: number; triggered: boolean }[];
  summary: string;
  threshold: number;
}

export interface ClaimsMomentum {
  current_yoy: number | null;
  current_ma: number | null;
  history: { date: string; ma: number; value: number }[];
  summary: string;
  threshold: number;
}

export interface LeiProxy {
  current: number | null;
  history: SeriesPoint[];
  summary: string;
}

export interface RecessionComposite {
  composite: number | null;
  bucket: string;
  components: { label: string; value: number | null; score: number | null }[];
}

export interface RecessionDashboard {
  composite: RecessionComposite;
  sahm: SahmRule;
  nyfed: {
    current: RecessionProbabilityCurrent;
    history: RecessionProbabilityPoint[];
  };
  lei_proxy: LeiProxy;
  claims: ClaimsMomentum;
  industrial: { current: number | null; history: SeriesPoint[]; summary: string };
  real_retail: { current: number | null; history: SeriesPoint[]; summary: string };
}

// ── Nowcast
export interface NowcastComponent {
  label: string;
  series_id: string;
  transform: string;
  latest: number | null;
  latest_date: string | null;
  z: number | null;
  history: SeriesPoint[];
}

export interface NowcastDashboard {
  atlanta_fed: {
    value: number | null;
    asof: string | null;
    quarter: string | null;
    source: string;
    url?: string;
    summary: string;
  };
  composite: {
    components: NowcastComponent[];
    composite_z: number | null;
    summary: string;
  };
}

// ── Series detail
export type MacroTransform = "level" | "yoy" | "mom" | "mom_ann"
  | "three_m_ann" | "six_m_ann" | "log_diff" | "z_score" | "percentile" | "detrend";

export interface SeriesDescriptiveStats {
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
  last?: number;
  last_date?: string;
  z_5y?: number | null;
  percentile?: number;
}

export interface MacroSeriesDetail {
  series_id: string;
  transform: MacroTransform;
  label: string;
  unit: string;
  frequency: string;
  note: string;
  points: SeriesPoint[];
  stats: SeriesDescriptiveStats;
}

// ── Heatmap
export interface HeatmapTile {
  id: string;
  label: string;
  unit?: string;
  category: string;
  last: number | null;
  last_date?: string;
  z: number | null;
  percentile: number | null;
}

export interface MacroHeatmap {
  tiles: HeatmapTile[];
  transform: string;
}

// ── Regime v2
export type RegimeV2Label = "risk_on" | "early_cycle" | "late_cycle" | "risk_off" | "recession";

export interface RegimeV2Driver {
  name: string;
  value: number;
  interpretation: string;
}

export interface RegimeV2State {
  label: RegimeV2Label;
  probabilities: Record<RegimeV2Label, number>;
  confidence: number;
  reason: string;
  drivers: RegimeV2Driver[];
}

// ── Macro boards
export interface MacroBoard {
  id: number;
  name: string;
  description: string | null;
  series_ids: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface MacroBoardSnapshot {
  board: MacroBoard;
  tiles: MacroTile[];
}

// ── Portfolio Tracker ────────────────────────────────────────
export interface Portfolio {
  id: number;
  name: string;
  description: string | null;
  cash_balance: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface PortfolioTransaction {
  id: number;
  portfolio_id: number;
  symbol: string;
  trade_date: string;
  trade_type: "buy" | "sell" | "dividend" | "deposit" | "withdrawal";
  quantity: number;
  price: number;
  commission: number;
  notes: string | null;
  created_at: string | null;
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  shares: number;
  avg_cost: number;
  total_cost: number;
  current_price: number;
  prev_close: number;
  day_change: number;
  day_change_pct: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_pl_pct: number;
  realized_pl: number;
  total_pl: number;
  "52w_high": number | null;
  "52w_low": number | null;
  pct_from_52w_high: number | null;
  ytd_return_pct: number | null;
  beta: number | null;
  volume: number | null;
  avg_volume: number | null;
  market_cap: number | null;
  pe_ratio: number | null;
  forward_pe: number | null;
  dividend_yield: number | null;
  dividend_rate: number | null;
  portfolio_weight: number;
  day_pl: number;
  cash_weight: number;
  lots: Array<{ quantity: number; cost_per_share: number; trade_date: string }>;
}

export interface PortfolioSummary {
  total_market_value: number;
  cash_balance: number;
  total_value: number;
  total_cost_basis: number;
  total_unrealized_pl: number;
  total_realized_pl: number;
  total_pl: number;
  total_pl_pct: number;
  total_day_pl: number;
  total_day_pl_pct: number;
  position_count: number;
  cash_pct: number;
}

export interface PortfolioMetrics {
  ann_return_pct: number | null;
  ann_volatility_pct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  treynor: number | null;
  information_ratio: number | null;
  tracking_error_pct: number | null;
  alpha_pct: number | null;
  beta: number | null;
  r_squared: number | null;
  max_drawdown_pct: number | null;
  max_drawdown_start: string | null;
  max_drawdown_end: string | null;
  win_rate_pct: number | null;
  twr_pct: number | null;
  mwr_pct: number | null;
}

export interface PortfolioAllocation {
  sectors: Array<{ sector: string; weight_pct: number }>;
  cash_pct: number;
  total_value: number | null;
}

// ── Portfolio Comparison ─────────────────────────────────────
export interface ComparePortfolio {
  id: number;
  name: string;
  curve: {
    dates: string[];
    portfolio: number[];
    benchmarks: { SPY: number[]; QQQ: number[] };
  };
  metrics: {
    ann_return_pct: number | null;
    ann_volatility_pct: number | null;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    max_drawdown_pct: number | null;
    beta: number | null;
    alpha_pct: number | null;
    twr_pct: number | null;
  };
  risk: {
    var_95_daily_pct: number | null;
    portfolio_volatility_pct: number | null;
    herfindahl: number | null;
  };
  summary: {
    total_value: number;
    total_pl: number;
    total_pl_pct: number;
  };
}

export interface PortfolioCompareResponse {
  portfolios: ComparePortfolio[];
  common_dates: string[];
  correlation_matrix: Array<Array<number | null>>;
  correlation_labels: string[];
}

// ── Portfolio Tax / Wash-Sale / TLH ──────────────────────────
export interface TaxWashSaleFlag {
  symbol: string;
  close_date: string;
  loss: number;
  repurchase_date: string;
  disallowed: boolean;
}

export interface TaxLot {
  symbol: string;
  quantity: number;
  open_date: string;
  close_date: string;
  proceeds: number;
  cost_basis: number;
  gain: number;
  term: "short" | "long";
  holding_days: number | null;
}

export interface TaxSummary {
  year: number | null;
  short_term_gain: number;
  long_term_gain: number;
  total_realized: number;
  lot_count: number;
  wash_sale_flags: TaxWashSaleFlag[];
  lots: TaxLot[];
}

export interface TlhCandidate {
  symbol: string;
  unrealized_pl: number;
  unrealized_pl_pct: number;
  market_value: number;
}

export interface PortfolioTaxResponse {
  summary: TaxSummary;
  tlh: TlhCandidate[];
}

// ── Portfolio Rebalance ──────────────────────────────────────
export interface RebalanceRow {
  symbol: string;
  current_weight_pct: number;
  target_weight_pct: number;
  drift_pct: number;
  current_value: number;
  target_value: number;
  trade_value: number;
  action: "buy" | "sell" | "hold";
}

export interface RebalanceResponse {
  rows: RebalanceRow[];
  total_drift_pct: number;
  threshold_pct: number;
  rebalance_needed: boolean;
  total_value: number;
}

// ── Portfolio Regime Stress ──────────────────────────────────
export interface RegimeStressSegment {
  label: string;
  start: string;
  end: string;
  days: number;
}

export interface RegimeStressPerSegment {
  label: string;
  start: string;
  end: string;
  return: number | null;
}

export interface RegimeStressPosition {
  ticker: string;
  weight: number;
  regime_returns: {
    risk_on: number | null;
    risk_off: number | null;
    transition: number | null;
  };
  per_segment: RegimeStressPerSegment[];
  total_return: number | null;
  data_points: number;
}

export interface RegimeStressResponse {
  segments: RegimeStressSegment[];
  positions: RegimeStressPosition[];
  aggregate_by_regime: {
    risk_on: number | null;
    risk_off: number | null;
    transition: number | null;
  };
}

// ── Portfolio CSV Import ─────────────────────────────────────
export interface ImportRow {
  symbol: string;
  trade_date: string;
  trade_type: string;
  quantity: number;
  price: number;
  commission: number;
}

export interface ImportPreviewResponse {
  rows: ImportRow[];
  errors: string[];
  detected_format: string | null;
}

// ── ETF Comparison ───────────────────────────────────────────
export interface ETFMetrics {
  ann_return_pct: number | null;
  ann_volatility_pct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  max_drawdown_pct: number | null;
  max_drawdown_start: string | null;
  max_drawdown_end: string | null;
  beta_vs_benchmark: number | null;
  alpha_vs_benchmark_pct: number | null;
  r_squared: number | null;
  var_95_daily_pct: number | null;
  cvar_95_daily_pct: number | null;
  var_99_daily_pct: number | null;
  total_return_pct: number | null;
  ytd_return_pct: number | null;
  win_rate_vs_benchmark_pct: number | null;
  up_capture: number | null;
  down_capture: number | null;
}

export interface ETFInfo {
  name: string | null;
  category: string | null;
  expense_ratio: number | null;
  aum: number | null;
  inception_date: string | null;
  beta: number | null;
  pe_ratio: number | null;
  dividend_yield: number | null;
  holdings_count: number | null;
}

export interface ETFCompareResponse {
  symbols: string[];
  benchmark: string;
  lookback_days: number;
  curves: {
    dates: string[];
    series: Record<string, number[]>;
  };
  metrics: Record<string, ETFMetrics>;
  correlation_matrix: Array<Array<number | null>>;
  correlation_labels: string[];
  factor_exposures: Record<string, Array<{ factor: string; beta: number }>>;
  monthly_returns: Record<string, Record<string, number>>;
  rolling_returns: Record<string, Record<string, number | null>>;
  info: Record<string, ETFInfo>;
}

// ── Cross-Asset Investment Comparator ────────────────────────────────────────
export interface RealEstateParams {
  purchase_price: number;
  down_payment_pct: number;
  loan_rate: number;
  loan_term_years: number;
  monthly_rent: number;
  monthly_expenses: number;
  vacancy_pct: number;
  annual_appreciation_pct: number;
  rent_growth_pct?: number;
  expense_growth_pct?: number;
  hold_years: number;
  sale_cost_pct: number;
  closing_cost_pct?: number;
}

export interface MarketParams {
  symbol: string;
  initial_investment: number;
  hold_years: number;
  monthly_contribution?: number;
  dividend_yield_pct?: number;
}

export interface CustomCashflow {
  date: string;
  amount: number;
}

export interface CustomParams {
  initial_investment: number;
  cashflows: CustomCashflow[];
  terminal_value?: number;
  hold_years: number;
}

export type InvestmentSpec =
  | { kind: "real_estate"; label: string; params: RealEstateParams }
  | { kind: "market"; label: string; params: MarketParams }
  | { kind: "custom"; label: string; params: CustomParams };

export interface InvestmentResult {
  kind: string;
  label: string;
  metrics: Record<string, number | null>;
  monthly: { month: number; date: string; equity: number }[];
  normalized_curve?: number[];
  error?: string;
}

export interface InvestmentMetricsRow {
  label: string;
  irr_annual: number | null;     // decimal (0.156 = 15.6%)
  cagr: number | null;           // decimal
  total_return_pct: number | null; // already a percent
  equity_multiple: number | null;  // multiple (1.8 = 1.8x)
}

export interface CompareInvestmentsResponse {
  investments: InvestmentResult[];
  comparison: {
    dates: string[];
    series: Record<string, (number | null)[]>; // each normalized to 100 at start
    metrics_table: InvestmentMetricsRow[];
    best_by_irr: string | null;
  };
}

// ── Cross-Asset: Crypto ──────────────────────────────────────────────────────
export interface CryptoCoin {
  symbol: string;
  name: string;
  price: number | null;
  change_24h_pct: number | null;
  change_7d_pct: number | null;
  market_cap: number | null;
  volume_24h: number | null;
}

export interface CryptoGlobalStats {
  total_market_cap_usd: number | null;
  btc_dominance_pct: number | null;
  market_cap_change_24h_pct: number | null;
}

export interface CryptoOverviewResponse {
  coins: CryptoCoin[];
  global: CryptoGlobalStats;
}

export interface CryptoCompareMetric {
  return_pct: number | null;
  start: number | null;
  latest: number | null;
}

export interface CryptoCompareResponse {
  symbols: string[];
  days: number;
  series: Record<string, Array<{ date: string; value: number }>>;
  metrics: Record<string, CryptoCompareMetric>;
}

// ── Cross-Asset: FX ──────────────────────────────────────────────────────────
export interface FxPair {
  symbol: string;
  pair: string;
  rate: number | null;
  change_1d_pct: number | null;
  change_1m_pct: number | null;
}

export interface FxDxy {
  symbol: string;
  level: number | null;
  change_1d_pct: number | null;
  change_1m_pct: number | null;
  trend: string | null;
}

export interface FxMatrixResponse {
  pairs: FxPair[];
  dxy: FxDxy;
}

// ── Cross-Asset: Fixed Income ────────────────────────────────────────────────
export interface FiTreasuryMaturity {
  maturity: string;
  years: number;
  yield_pct: number | null;
  change_bps: number | null;
}

export interface FiCurveShape {
  spread_2_10_bps: number | null;
  spread_3m_10y_bps: number | null;
  spread_10_30_bps: number | null;
  classification: string;
}

export interface FiTreasurySection {
  date: string | null;
  maturities: FiTreasuryMaturity[];
  shape: FiCurveShape | null;
}

export interface FiBondEtf {
  symbol: string;
  tracks: string;
  price: number | null;
  yield_pct: number | null;
  change_1m_pct: number | null;
  change_ytd_pct: number | null;
}

export interface FixedIncomeOverviewResponse {
  treasuries: FiTreasurySection;
  bond_etfs: FiBondEtf[];
}

// ── Unified search (command palette) ─────────────────────────────────────────
export interface SearchResult {
  type: "ticker" | "series";
  key: string;
  label: string;
  sublabel: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
}

// ── Single-ticker dossier ────────────────────────────────────────────────────
export interface DossierProfile {
  name: string;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  currency: string | null;
  market_cap: number | null;
  pe_ratio: number | null;
  forward_pe: number | null;
  dividend_yield: number | null;
  beta: number | null;
  current_price: number | null;
  prev_close: number | null;
  day_change: number | null;
  day_change_pct: number | null;
  summary: string | null;
}

export interface DossierPrice {
  last: number;
  prior: number;
  change: number;
  change_pct: number;
  high_52w: number;
  low_52w: number;
  pct_from_high: number | null;
  pct_from_low: number | null;
  avg_365d: number;
  points: SeriesPoint[];
}

export interface DossierTechnicals {
  indicator: string;
  score: number | null;
  bucket: string;
  votes: Record<string, number>;
}

export interface DossierFiling {
  ticker: string;
  cik: string;
  accession: string;
  form: string;
  filing_date: string;
  report_date: string;
  description: string;
  items: string;
  url: string;
  form_label: string;
}

export interface DossierResponse {
  symbol: string;
  profile: DossierProfile | null;
  price: DossierPrice | null;
  fundamentals: Record<string, number | string | null> | null;
  technicals: DossierTechnicals | null;
  news: NewsItem[];
  filings: DossierFiling[];
  options: ChainSummary | null;
}
