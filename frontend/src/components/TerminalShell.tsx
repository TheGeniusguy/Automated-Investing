import { useCallback, useEffect, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { api } from "../api/client";
import type { HealthResponse } from "../api/types";
import { AdvancedAnalyticsPanel } from "./AdvancedAnalyticsPanel";
import { ChatPanel } from "./ChatPanel";
import { CommandPalette } from "./CommandPalette";
import { ComparePanel } from "./ComparePanel";
import { CorrelationsPanel } from "./CorrelationsPanel";
import { CryptoPanel } from "./CryptoPanel";
import { FixedIncomePanel } from "./FixedIncomePanel";
import { FXPanel } from "./FXPanel";
import { DailyBriefingPanel } from "./DailyBriefingPanel";
import { DataInfraPanel } from "./DataInfraPanel";
import { DeepEconomyPanel } from "./DeepEconomyPanel";
import { OptionsAnalyticsPanel } from "./OptionsAnalyticsPanel";
import { RatePathPanel } from "./RatePathPanel";
import { BacktestPanel } from "./BacktestPanel";
import { BondAnalyticsPanel } from "./BondAnalyticsPanel";
import { COTPositioningPanel } from "./COTPositioningPanel";
import { EarningsPanel } from "./EarningsPanel";
import { EnergyPanel } from "./EnergyPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { ETFComparePanel } from "./ETFComparePanel";
import { ETFTrackingPanel } from "./ETFTrackingPanel";
import { EventsCalendarPanel } from "./EventsCalendarPanel";
import { FilingsPanel } from "./FilingsPanel";
import { FundamentalsBrowser } from "./FundamentalsBrowser";
import { InflationDashboard } from "./InflationDashboard";
import { InsiderTransactionsPanel } from "./InsiderTransactionsPanel";
import { InstitutionalHoldingsPanel } from "./InstitutionalHoldingsPanel";
import { InvestmentComparePanel } from "./InvestmentComparePanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { MacroExplorer } from "./MacroExplorer";
import { MacroHeatmap } from "./MacroHeatmap";
import { MarketInsidersPanel } from "./MarketInsidersPanel";
import { MarketNewsPanel } from "./MarketNewsPanel";
import { MacroPinboard } from "./MacroPinboard";
import { MacroRegimeTracker } from "./MacroRegimeTracker";
import { NewsPanel } from "./NewsPanel";
import { OptionsPanel } from "./OptionsPanel";
import { PaperTradingPanel } from "./PaperTradingPanel";
import { ProFormaPanel } from "./ProFormaPanel";
import { RealEstatePanel } from "./RealEstatePanel";
import { RecessionDashboard } from "./RecessionDashboard";
import { RegimeJournal } from "./RegimeJournal";
import { RegimeV2Panel } from "./RegimeV2Panel";
import { ScreenerPanel } from "./ScreenerPanel";
import { SectorDetailPanel } from "./SectorDetailPanel";
import { SectorRotationPanel } from "./SectorRotationPanel";
import { ShippingPanel } from "./ShippingPanel";
import { Sidebar } from "./Sidebar";
import { TechnicalIndicatorsPanel } from "./TechnicalIndicatorsPanel";
import { TickerDossierPanel } from "./TickerDossierPanel";
import { WatchlistsPanel } from "./WatchlistsPanel";
import { WeightedPortfolioPanel } from "./WeightedPortfolioPanel";
import { YieldCurvePanel } from "./YieldCurvePanel";
// Bloomberg Waves D + E
import { FXAnalyticsPanel } from "./FXAnalyticsPanel";
import { CommoditiesCurvePanel } from "./CommoditiesCurvePanel";
import { EstimatesPanel } from "./EstimatesPanel";
import { CreditCurvesPanel } from "./CreditCurvesPanel";
import { AlertsPanel } from "./AlertsPanel";
import { EconSurprisePanel } from "./EconSurprisePanel";
import { SeasonalityPanel } from "./SeasonalityPanel";
import { FactorAnalysisPanel } from "./FactorAnalysisPanel";
import { MonteCarloPanel } from "./MonteCarloPanel";
import { ShortInterestPanel } from "./ShortInterestPanel";
import { DealsMonitorPanel } from "./DealsMonitorPanel";
import { OptionsStrategyPanel } from "./OptionsStrategyPanel";
import { EconCalendarPanel } from "./EconCalendarPanel";
import { PairsTradingPanel } from "./PairsTradingPanel";
import { AllocationOptimizerPanel } from "./AllocationOptimizerPanel";
import { RRGPanel } from "./RRGPanel";
import { VolDashboardPanel } from "./VolDashboardPanel";
import { WorldIndicesPanel } from "./WorldIndicesPanel";
import { PortfolioRiskPanel } from "./PortfolioRiskPanel";
import { DividendTrackerPanel } from "./DividendTrackerPanel";
import { CompsGridPanel } from "./CompsGridPanel";
import { CentralBankRatesPanel } from "./CentralBankRatesPanel";
import { TreasuryAuctionsPanel } from "./TreasuryAuctionsPanel";
import { NetLiquidityPanel } from "./NetLiquidityPanel";
import { NewsSentimentPanel } from "./NewsSentimentPanel";
import { EarningsQualityPanel } from "./EarningsQualityPanel";
import { FearGreedPanel } from "./FearGreedPanel";
import { CrackSpreadsPanel } from "./CrackSpreadsPanel";
import { CommoditySpreadsPanel } from "./CommoditySpreadsPanel";
import { TaylorRulePanel } from "./TaylorRulePanel";
import { OASCurvesPanel } from "./OASCurvesPanel";
import { BreakevensPanel } from "./BreakevensPanel";
import { REERPanel } from "./REERPanel";
import { CDSPricerPanel } from "./CDSPricerPanel";
import { NewsHeatPanel } from "./NewsHeatPanel";
import { SuperinvestorsPanel } from "./SuperinvestorsPanel";
import { VolumeProfilePanel } from "./VolumeProfilePanel";
import { SocialSentimentPanel } from "./SocialSentimentPanel";
import { ForwardRatesPanel } from "./ForwardRatesPanel";
import { CarryRolldownPanel } from "./CarryRolldownPanel";
import { SovereignBondsPanel } from "./SovereignBondsPanel";

// react-grid-layout uses 12-column x N-row grid; layout values are in grid units.
const LAYOUT: Layout[] = [
  { i: "briefing",      x: 0, y: 0,   w: 12, h: 16, minW: 6, minH: 10 },
  { i: "chat",          x: 0, y: 16,  w: 12, h: 18, minW: 6, minH: 12 },
  { i: "macro",         x: 0, y: 34,  w: 12, h: 18, minW: 6, minH: 10 },
  { i: "regime-v2",     x: 0, y: 52,  w: 12, h: 16, minW: 6, minH: 10 },
  { i: "yield-curve",   x: 0, y: 68,  w: 12, h: 24, minW: 6, minH: 14 },
  { i: "inflation",     x: 0, y: 92,  w: 12, h: 22, minW: 6, minH: 14 },
  { i: "recession",     x: 0, y: 114, w: 12, h: 24, minW: 6, minH: 14 },
  { i: "macro-heatmap", x: 0, y: 138, w: 12, h: 26, minW: 6, minH: 14 },
  { i: "pinboard",      x: 0, y: 164, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "macro-explorer",x: 0, y: 186, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "energy",        x: 0, y: 208, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "shipping",      x: 0, y: 230, w: 12, h: 16, minW: 6, minH: 10 },
  { i: "journal",       x: 0, y: 246, w: 12, h: 20, minW: 6, minH: 12 },
  { i: "correlations",  x: 0, y: 266, w: 12, h: 22, minW: 6, minH: 12 },
  { i: "options",       x: 0, y: 288, w: 12, h: 16, minW: 6, minH: 10 },
  { i: "earnings",      x: 0, y: 304, w: 12, h: 18, minW: 6, minH: 10 },
  { i: "news",          x: 0, y: 322, w: 12, h: 18, minW: 6, minH: 10 },
  { i: "filings",       x: 0, y: 340, w: 12, h: 18, minW: 6, minH: 10 },
  { i: "data-infra",    x: 0, y: 358, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "fundamentals",  x: 0, y: 380, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "sector-rotation", x: 0, y: 402, w: 12, h: 18, minW: 6, minH: 12 },
  { i: "indicators",      x: 0, y: 420, w: 12, h: 30, minW: 6, minH: 18 },
  { i: "calendar",        x: 0, y: 450, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "screener",        x: 0, y: 472, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "watchlists",      x: 0, y: 494, w: 12, h: 20, minW: 6, minH: 12 },
  { i: "compare",         x: 0, y: 514, w: 12, h: 26, minW: 6, minH: 16 },
  { i: "real-estate",     x: 0, y: 540, w: 12, h: 28, minW: 6, minH: 16 },
  { i: "insider",         x: 0, y: 542, w: 12, h: 24, minW: 6, minH: 14 },
  { i: "institutional",   x: 0, y: 566, w: 12, h: 24, minW: 6, minH: 14 },
  { i: "portfolio",       x: 0, y: 590, w: 12, h: 44, minW: 6, minH: 24 },
  { i: "etf-compare",     x: 0, y: 634, w: 12, h: 48, minW: 6, minH: 24 },
  { i: "crypto",          x: 0, y: 682, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "fx",              x: 0, y: 706, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "fixed-income",    x: 0, y: 730, w: 12, h: 22, minW: 6, minH: 14 },
  { i: "ticker-dossier",  x: 0, y: 758, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "investment-compare", x: 0, y: 788, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "market-news",     x: 0, y: 822, w: 12, h: 20, minW: 6, minH: 12 },
  { i: "market-insiders", x: 0, y: 842, w: 12, h: 24, minW: 6, minH: 14 },
  // v2 wave: Analytics + Modeling + Deep Economy (appended at the bottom)
  { i: "advanced-analytics", x: 0, y: 866,  w: 12, h: 26, minW: 6, minH: 16 },
  { i: "proforma",           x: 0, y: 892,  w: 12, h: 36, minW: 6, minH: 20 },
  { i: "weighted-portfolio", x: 0, y: 928,  w: 12, h: 28, minW: 6, minH: 16 },
  { i: "paper-trading",      x: 0, y: 956,  w: 12, h: 28, minW: 6, minH: 16 },
  { i: "etf-tracking",       x: 0, y: 984,  w: 12, h: 28, minW: 6, minH: 16 },
  { i: "deep-economy",       x: 0, y: 1012, w: 12, h: 30, minW: 6, minH: 18 },
  { i: "options-analytics",  x: 0, y: 1042, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "rate-path",          x: 0, y: 1076, w: 12, h: 26, minW: 6, minH: 14 },
  { i: "backtest",           x: 0, y: 1102, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "bond-analytics",     x: 0, y: 1134, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "cot",                x: 0, y: 1164, w: 12, h: 30, minW: 6, minH: 16 },
  // Bloomberg Waves D + E (appended at the bottom, non-overlapping)
  { i: "fx-analytics",       x: 0, y: 1194, w: 12, h: 28, minW: 6, minH: 16 },
  { i: "commodities-curve",  x: 0, y: 1222, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "estimates",          x: 0, y: 1252, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "credit-curves",      x: 0, y: 1282, w: 12, h: 28, minW: 6, minH: 16 },
  { i: "alerts",             x: 0, y: 1310, w: 12, h: 28, minW: 6, minH: 16 },
  { i: "econ-surprise",      x: 0, y: 1338, w: 12, h: 26, minW: 6, minH: 14 },
  { i: "seasonality",        x: 0, y: 1364, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "factor-analysis",    x: 0, y: 1394, w: 12, h: 28, minW: 6, minH: 16 },
  { i: "montecarlo",         x: 0, y: 1422, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "short-interest",     x: 0, y: 1454, w: 12, h: 28, minW: 6, minH: 16 },
  // Bloomberg Wave F (appended at the bottom, non-overlapping)
  { i: "deals",                x: 0, y: 1482, w: 12, h: 30, minW: 6, minH: 16 },
  { i: "options-strategy",     x: 0, y: 1512, w: 12, h: 36, minW: 6, minH: 20 },
  { i: "econ-calendar",        x: 0, y: 1548, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "pairs",                x: 0, y: 1580, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "allocation-optimizer", x: 0, y: 1614, w: 12, h: 34, minW: 6, minH: 18 },
  // Bloomberg Wave G (appended at the bottom, non-overlapping)
  { i: "rrg",             x: 0, y: 1648, w: 12, h: 36, minW: 6, minH: 20 },
  { i: "vol-dashboard",   x: 0, y: 1684, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "world-indices",   x: 0, y: 1716, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "portfolio-risk",  x: 0, y: 1750, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "dividend-tracker", x: 0, y: 1784, w: 12, h: 34, minW: 6, minH: 18 },
  // Bloomberg Wave H (appended at the bottom, non-overlapping)
  { i: "comps",             x: 0, y: 1818, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "central-bank-rates", x: 0, y: 1852, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "treasury-auctions", x: 0, y: 1886, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "net-liquidity",     x: 0, y: 1918, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "news-sentiment",    x: 0, y: 1950, w: 12, h: 32, minW: 6, minH: 18 },
  // Bloomberg Wave I (appended at the bottom, non-overlapping)
  { i: "earnings-quality",  x: 0, y: 1982, w: 12, h: 36, minW: 6, minH: 20 },
  { i: "fear-greed",        x: 0, y: 2018, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "crack-spreads",     x: 0, y: 2052, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "commodity-spreads", x: 0, y: 2084, w: 12, h: 32, minW: 6, minH: 18 },
  { i: "taylor-rule",       x: 0, y: 2116, w: 12, h: 34, minW: 6, minH: 18 },
  // Bloomberg Wave J (appended at the bottom, non-overlapping)
  { i: "oas-curves",        x: 0, y: 2150, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "breakevens",        x: 0, y: 2184, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "reer",              x: 0, y: 2218, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "cds-pricer",        x: 0, y: 2252, w: 12, h: 36, minW: 6, minH: 20 },
  { i: "news-heat",         x: 0, y: 2288, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "superinvestors",    x: 0, y: 2322, w: 12, h: 38, minW: 6, minH: 20 },
  { i: "volume-profile",    x: 0, y: 2360, w: 12, h: 36, minW: 6, minH: 18 },
  { i: "social-sentiment",  x: 0, y: 2396, w: 12, h: 34, minW: 6, minH: 18 },
  { i: "forward-rates",     x: 0, y: 2430, w: 12, h: 36, minW: 6, minH: 18 },
  { i: "carry-rolldown",    x: 0, y: 2466, w: 12, h: 36, minW: 6, minH: 18 },
  { i: "sovereign-bonds",   x: 0, y: 2502, w: 12, h: 36, minW: 6, minH: 18 },
];

const ROW_HEIGHT = 30;

const SIDEBAR_WIDTH = 224; // w-56 = 14rem = 224px

export function TerminalShell() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(new Date());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSector, setActiveSector] = useState<string | null>(null);
  const [dossierSymbol, setDossierSymbol] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState<number>(
    typeof window !== "undefined"
      ? window.innerWidth - 16 - (true ? SIDEBAR_WIDTH : 0)
      : 1200,
  );

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    const resize = () => {
      setGridWidth(
        window.innerWidth - 16 - (sidebarOpen ? SIDEBAR_WIDTH : 0),
      );
    };
    window.addEventListener("resize", resize);
    return () => {
      clearInterval(tick);
      window.removeEventListener("resize", resize);
    };
  }, [sidebarOpen]);

  // Recalc grid width when sidebar toggles.
  useEffect(() => {
    setGridWidth(
      window.innerWidth - 16 - (sidebarOpen ? SIDEBAR_WIDTH : 0),
    );
  }, [sidebarOpen]);

  const handleScrollTo = useCallback((panelKey: string) => {
    const el = mainRef.current?.querySelector(`[data-panel-key="${panelKey}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      <Topbar health={health} now={now} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            activeSector={activeSector}
            onSelectSector={setActiveSector}
            onScrollTo={handleScrollTo}
          />
        )}

        {/* Main content */}
        {activeSector ? (
          <div className="flex-1 overflow-auto">
            <ErrorBoundary label="Sector Detail">
              <SectorDetailPanel
                sectorId={activeSector}
                onBack={() => setActiveSector(null)}
                onSelectSector={setActiveSector}
              />
            </ErrorBoundary>
          </div>
        ) : (
          <div ref={mainRef} className="flex-1 overflow-auto px-2">
            <GridLayout
              className="layout"
              layout={LAYOUT}
              cols={12}
              rowHeight={ROW_HEIGHT}
              width={gridWidth}
              margin={[8, 8]}
              draggableHandle=".panel-header"
              isBounded
            >
              <div key="briefing" data-panel-key="briefing">
                <ErrorBoundary label="Daily Briefing"><DailyBriefingPanel /></ErrorBoundary>
              </div>
              <div key="chat" data-panel-key="chat">
                <ErrorBoundary label="Ask the Terminal"><ChatPanel /></ErrorBoundary>
              </div>
              <div key="macro" data-panel-key="macro">
                <ErrorBoundary label="Macro Regime Tracker"><MacroRegimeTracker /></ErrorBoundary>
              </div>
              <div key="regime-v2" data-panel-key="regime-v2">
                <ErrorBoundary label="Regime Tracker"><RegimeV2Panel /></ErrorBoundary>
              </div>
              <div key="yield-curve" data-panel-key="yield-curve">
                <ErrorBoundary label="Yield Curve"><YieldCurvePanel /></ErrorBoundary>
              </div>
              <div key="inflation" data-panel-key="inflation">
                <ErrorBoundary label="Inflation"><InflationDashboard /></ErrorBoundary>
              </div>
              <div key="recession" data-panel-key="recession">
                <ErrorBoundary label="Recession"><RecessionDashboard /></ErrorBoundary>
              </div>
              <div key="macro-heatmap" data-panel-key="macro-heatmap">
                <ErrorBoundary label="Macro Heatmap"><MacroHeatmap /></ErrorBoundary>
              </div>
              <div key="pinboard" data-panel-key="pinboard">
                <ErrorBoundary label="Pinboard"><MacroPinboard /></ErrorBoundary>
              </div>
              <div key="macro-explorer" data-panel-key="macro-explorer">
                <ErrorBoundary label="Macro Explorer"><MacroExplorer /></ErrorBoundary>
              </div>
              <div key="energy" data-panel-key="energy">
                <ErrorBoundary label="Energy"><EnergyPanel /></ErrorBoundary>
              </div>
              <div key="shipping" data-panel-key="shipping">
                <ErrorBoundary label="Shipping"><ShippingPanel /></ErrorBoundary>
              </div>
              <div key="journal" data-panel-key="journal">
                <ErrorBoundary label="Regime Journal"><RegimeJournal /></ErrorBoundary>
              </div>
              <div key="correlations" data-panel-key="correlations">
                <ErrorBoundary label="Correlations"><CorrelationsPanel /></ErrorBoundary>
              </div>
              <div key="options" data-panel-key="options">
                <ErrorBoundary label="Options"><OptionsPanel /></ErrorBoundary>
              </div>
              <div key="earnings" data-panel-key="earnings">
                <ErrorBoundary label="Earnings"><EarningsPanel /></ErrorBoundary>
              </div>
              <div key="news" data-panel-key="news">
                <ErrorBoundary label="News"><NewsPanel /></ErrorBoundary>
              </div>
              <div key="filings" data-panel-key="filings">
                <ErrorBoundary label="Filings"><FilingsPanel /></ErrorBoundary>
              </div>
              <div key="data-infra" data-panel-key="data-infra">
                <ErrorBoundary label="DB Status"><DataInfraPanel /></ErrorBoundary>
              </div>
              <div key="fundamentals" data-panel-key="fundamentals">
                <ErrorBoundary label="Fundamentals"><FundamentalsBrowser /></ErrorBoundary>
              </div>
              <div key="sector-rotation" data-panel-key="sector-rotation">
                <ErrorBoundary label="Sector Rotation"><SectorRotationPanel /></ErrorBoundary>
              </div>
              <div key="indicators" data-panel-key="indicators">
                <ErrorBoundary label="Indicators"><TechnicalIndicatorsPanel /></ErrorBoundary>
              </div>
              <div key="calendar" data-panel-key="calendar">
                <ErrorBoundary label="Calendar"><EventsCalendarPanel /></ErrorBoundary>
              </div>
              <div key="screener" data-panel-key="screener">
                <ErrorBoundary label="Screener"><ScreenerPanel /></ErrorBoundary>
              </div>
              <div key="watchlists" data-panel-key="watchlists">
                <ErrorBoundary label="Watchlists"><WatchlistsPanel /></ErrorBoundary>
              </div>
              <div key="compare" data-panel-key="compare">
                <ErrorBoundary label="Compare"><ComparePanel /></ErrorBoundary>
              </div>
              <div key="real-estate" data-panel-key="real-estate">
                <ErrorBoundary label="Real Estate"><RealEstatePanel /></ErrorBoundary>
              </div>
              <div key="insider" data-panel-key="insider">
                <ErrorBoundary label="Insider"><InsiderTransactionsPanel /></ErrorBoundary>
              </div>
              <div key="institutional" data-panel-key="institutional">
                <ErrorBoundary label="Institutional"><InstitutionalHoldingsPanel /></ErrorBoundary>
              </div>
              <div key="portfolio" data-panel-key="portfolio">
                <ErrorBoundary label="Portfolio"><PortfolioPanel /></ErrorBoundary>
              </div>
              <div key="etf-compare" data-panel-key="etf-compare">
                <ErrorBoundary label="ETF Compare"><ETFComparePanel /></ErrorBoundary>
              </div>
              <div key="crypto" data-panel-key="crypto">
                <ErrorBoundary label="Crypto"><CryptoPanel /></ErrorBoundary>
              </div>
              <div key="fx" data-panel-key="fx">
                <ErrorBoundary label="FX / Currencies"><FXPanel /></ErrorBoundary>
              </div>
              <div key="fixed-income" data-panel-key="fixed-income">
                <ErrorBoundary label="Fixed Income"><FixedIncomePanel /></ErrorBoundary>
              </div>
              <div key="ticker-dossier" data-panel-key="ticker-dossier">
                <ErrorBoundary label="Ticker Dossier"><TickerDossierPanel symbol={dossierSymbol} /></ErrorBoundary>
              </div>
              <div key="investment-compare" data-panel-key="investment-compare">
                <ErrorBoundary label="Investment Compare"><InvestmentComparePanel /></ErrorBoundary>
              </div>
              <div key="market-news" data-panel-key="market-news">
                <ErrorBoundary label="Market News"><MarketNewsPanel /></ErrorBoundary>
              </div>
              <div key="market-insiders" data-panel-key="market-insiders">
                <ErrorBoundary label="Market Insiders"><MarketInsidersPanel /></ErrorBoundary>
              </div>
              <div key="advanced-analytics" data-panel-key="advanced-analytics">
                <ErrorBoundary label="Advanced Analytics"><AdvancedAnalyticsPanel /></ErrorBoundary>
              </div>
              <div key="proforma" data-panel-key="proforma">
                <ErrorBoundary label="Pro Forma Modeling"><ProFormaPanel /></ErrorBoundary>
              </div>
              <div key="weighted-portfolio" data-panel-key="weighted-portfolio">
                <ErrorBoundary label="Weighted Portfolio"><WeightedPortfolioPanel /></ErrorBoundary>
              </div>
              <div key="paper-trading" data-panel-key="paper-trading">
                <ErrorBoundary label="Paper Trading"><PaperTradingPanel /></ErrorBoundary>
              </div>
              <div key="etf-tracking" data-panel-key="etf-tracking">
                <ErrorBoundary label="ETF Tracking"><ETFTrackingPanel /></ErrorBoundary>
              </div>
              <div key="deep-economy" data-panel-key="deep-economy">
                <ErrorBoundary label="Deep Economy"><DeepEconomyPanel /></ErrorBoundary>
              </div>
              <div key="options-analytics" data-panel-key="options-analytics">
                <ErrorBoundary label="Options Analytics"><OptionsAnalyticsPanel /></ErrorBoundary>
              </div>
              <div key="rate-path" data-panel-key="rate-path">
                <ErrorBoundary label="Fed Rate Path"><RatePathPanel /></ErrorBoundary>
              </div>
              <div key="backtest" data-panel-key="backtest">
                <ErrorBoundary label="Backtester"><BacktestPanel /></ErrorBoundary>
              </div>
              <div key="bond-analytics" data-panel-key="bond-analytics">
                <ErrorBoundary label="Bond Analytics"><BondAnalyticsPanel /></ErrorBoundary>
              </div>
              <div key="cot" data-panel-key="cot">
                <ErrorBoundary label="Positioning (COT)"><COTPositioningPanel /></ErrorBoundary>
              </div>
              <div key="fx-analytics" data-panel-key="fx-analytics">
                <ErrorBoundary label="FX Analytics"><FXAnalyticsPanel /></ErrorBoundary>
              </div>
              <div key="commodities-curve" data-panel-key="commodities-curve">
                <ErrorBoundary label="Commodities Curve"><CommoditiesCurvePanel /></ErrorBoundary>
              </div>
              <div key="estimates" data-panel-key="estimates">
                <ErrorBoundary label="Analyst Estimates"><EstimatesPanel /></ErrorBoundary>
              </div>
              <div key="credit-curves" data-panel-key="credit-curves">
                <ErrorBoundary label="Credit & CDS"><CreditCurvesPanel /></ErrorBoundary>
              </div>
              <div key="alerts" data-panel-key="alerts">
                <ErrorBoundary label="Alerts"><AlertsPanel /></ErrorBoundary>
              </div>
              <div key="econ-surprise" data-panel-key="econ-surprise">
                <ErrorBoundary label="Econ Surprise"><EconSurprisePanel /></ErrorBoundary>
              </div>
              <div key="seasonality" data-panel-key="seasonality">
                <ErrorBoundary label="Seasonality"><SeasonalityPanel /></ErrorBoundary>
              </div>
              <div key="factor-analysis" data-panel-key="factor-analysis">
                <ErrorBoundary label="Factor Analysis"><FactorAnalysisPanel /></ErrorBoundary>
              </div>
              <div key="montecarlo" data-panel-key="montecarlo">
                <ErrorBoundary label="Monte Carlo"><MonteCarloPanel /></ErrorBoundary>
              </div>
              <div key="short-interest" data-panel-key="short-interest">
                <ErrorBoundary label="Short Interest"><ShortInterestPanel /></ErrorBoundary>
              </div>
              <div key="deals" data-panel-key="deals">
                <ErrorBoundary label="M&A / Deals Monitor"><DealsMonitorPanel /></ErrorBoundary>
              </div>
              <div key="options-strategy" data-panel-key="options-strategy">
                <ErrorBoundary label="Options Strategy Builder"><OptionsStrategyPanel /></ErrorBoundary>
              </div>
              <div key="econ-calendar" data-panel-key="econ-calendar">
                <ErrorBoundary label="Economic Calendar"><EconCalendarPanel /></ErrorBoundary>
              </div>
              <div key="pairs" data-panel-key="pairs">
                <ErrorBoundary label="Pairs / Relative Value"><PairsTradingPanel /></ErrorBoundary>
              </div>
              <div key="allocation-optimizer" data-panel-key="allocation-optimizer">
                <ErrorBoundary label="Allocation Optimizer"><AllocationOptimizerPanel /></ErrorBoundary>
              </div>
              <div key="rrg" data-panel-key="rrg">
                <ErrorBoundary label="Relative Rotation Graph"><RRGPanel /></ErrorBoundary>
              </div>
              <div key="vol-dashboard" data-panel-key="vol-dashboard">
                <ErrorBoundary label="Volatility Dashboard"><VolDashboardPanel /></ErrorBoundary>
              </div>
              <div key="world-indices" data-panel-key="world-indices">
                <ErrorBoundary label="World Equity Indices"><WorldIndicesPanel /></ErrorBoundary>
              </div>
              <div key="portfolio-risk" data-panel-key="portfolio-risk">
                <ErrorBoundary label="Portfolio Risk / VaR"><PortfolioRiskPanel /></ErrorBoundary>
              </div>
              <div key="dividend-tracker" data-panel-key="dividend-tracker">
                <ErrorBoundary label="Dividend & Buyback Tracker"><DividendTrackerPanel /></ErrorBoundary>
              </div>
              <div key="comps" data-panel-key="comps">
                <ErrorBoundary label="Relative Valuation (Comps)"><CompsGridPanel /></ErrorBoundary>
              </div>
              <div key="central-bank-rates" data-panel-key="central-bank-rates">
                <ErrorBoundary label="Global Central-Bank Rates"><CentralBankRatesPanel /></ErrorBoundary>
              </div>
              <div key="treasury-auctions" data-panel-key="treasury-auctions">
                <ErrorBoundary label="Treasury Auctions"><TreasuryAuctionsPanel /></ErrorBoundary>
              </div>
              <div key="net-liquidity" data-panel-key="net-liquidity">
                <ErrorBoundary label="Fed Net Liquidity"><NetLiquidityPanel /></ErrorBoundary>
              </div>
              <div key="news-sentiment" data-panel-key="news-sentiment">
                <ErrorBoundary label="News Sentiment"><NewsSentimentPanel /></ErrorBoundary>
              </div>
              <div key="earnings-quality" data-panel-key="earnings-quality">
                <ErrorBoundary label="Earnings Quality"><EarningsQualityPanel /></ErrorBoundary>
              </div>
              <div key="fear-greed" data-panel-key="fear-greed">
                <ErrorBoundary label="Fear & Greed Index"><FearGreedPanel /></ErrorBoundary>
              </div>
              <div key="crack-spreads" data-panel-key="crack-spreads">
                <ErrorBoundary label="Crack Spreads"><CrackSpreadsPanel /></ErrorBoundary>
              </div>
              <div key="commodity-spreads" data-panel-key="commodity-spreads">
                <ErrorBoundary label="Inter-Commodity Spreads"><CommoditySpreadsPanel /></ErrorBoundary>
              </div>
              <div key="taylor-rule" data-panel-key="taylor-rule">
                <ErrorBoundary label="Taylor Rule"><TaylorRulePanel /></ErrorBoundary>
              </div>
              <div key="oas-curves" data-panel-key="oas-curves">
                <ErrorBoundary label="Credit Spreads by Rating"><OASCurvesPanel /></ErrorBoundary>
              </div>
              <div key="breakevens" data-panel-key="breakevens">
                <ErrorBoundary label="Breakevens & Real Yields"><BreakevensPanel /></ErrorBoundary>
              </div>
              <div key="reer" data-panel-key="reer">
                <ErrorBoundary label="REER Fair Value"><REERPanel /></ErrorBoundary>
              </div>
              <div key="cds-pricer" data-panel-key="cds-pricer">
                <ErrorBoundary label="CDS Pricer"><CDSPricerPanel /></ErrorBoundary>
              </div>
              <div key="news-heat" data-panel-key="news-heat">
                <ErrorBoundary label="News Heat Monitor"><NewsHeatPanel /></ErrorBoundary>
              </div>
              <div key="superinvestors" data-panel-key="superinvestors">
                <ErrorBoundary label="Superinvestor Tracker"><SuperinvestorsPanel /></ErrorBoundary>
              </div>
              <div key="volume-profile" data-panel-key="volume-profile">
                <ErrorBoundary label="Volume Profile"><VolumeProfilePanel /></ErrorBoundary>
              </div>
              <div key="social-sentiment" data-panel-key="social-sentiment">
                <ErrorBoundary label="Social Sentiment"><SocialSentimentPanel /></ErrorBoundary>
              </div>
              <div key="forward-rates" data-panel-key="forward-rates">
                <ErrorBoundary label="Forward-Rate Matrix"><ForwardRatesPanel /></ErrorBoundary>
              </div>
              <div key="carry-rolldown" data-panel-key="carry-rolldown">
                <ErrorBoundary label="Carry & Rolldown"><CarryRolldownPanel /></ErrorBoundary>
              </div>
              <div key="sovereign-bonds" data-panel-key="sovereign-bonds">
                <ErrorBoundary label="Sovereign Bonds"><SovereignBondsPanel /></ErrorBoundary>
              </div>
            </GridLayout>
          </div>
        )}
      </div>

      <CommandPalette
        onPickTicker={(s) => setDossierSymbol(s)}
        onScrollTo={handleScrollTo}
      />

      <StatusBar health={health} now={now} />
    </div>
  );
}

function Topbar({
  health,
  now,
  sidebarOpen,
  onToggleSidebar,
}: {
  health: HealthResponse | null;
  now: Date;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex items-center justify-between px-6 py-2.5 border-b border-terminal-border bg-terminal-panel">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="text-terminal-muted hover:text-accent text-base leading-none px-1"
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {"\u2630"}
        </button>
        <div className="flex items-baseline gap-2.5">
          <span className="w-2 h-2 rounded-full bg-accent self-center" aria-hidden="true" />
          <span className="font-serif text-lg leading-none tracking-tight text-terminal-text">
            Automated-Investing
          </span>
          <span className="text-terminal-muted text-2xs uppercase tracking-[0.18em]">
            Market Intelligence
          </span>
        </div>
      </div>
      <div className="flex items-center gap-5 text-2xs text-terminal-muted">
        <span className="uppercase tracking-wider">
          {health?.claude_model ?? "Model offline"}
        </span>
        <span className="font-mono tabular-nums text-terminal-text">
          {now.toISOString().slice(11, 19)}
          <span className="text-terminal-dim ml-1">UTC</span>
        </span>
      </div>
    </header>
  );
}

function StatusBar({ health, now }: { health: HealthResponse | null; now: Date }) {
  const fred = health?.fred_configured;
  const claude = health?.anthropic_configured;
  const uw = health?.uw_configured;
  const online = health !== null;
  return (
    <footer className="flex items-center justify-between px-6 py-2 border-t border-terminal-border bg-terminal-panel text-2xs text-terminal-muted">
      <div className="flex items-center gap-5">
        <KeyStatus name="FRED" ok={fred} />
        <KeyStatus name="ANTHROPIC" ok={claude} />
        <KeyStatus name="UW" ok={uw} />
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono tabular-nums">{now.toLocaleDateString()}</span>
        {online ? (
          <span className="flex items-center gap-1.5 text-accent-green">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green" aria-hidden="true" />
            Connected
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-accent-amber">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" aria-hidden="true" />
            Connecting
          </span>
        )}
      </div>
    </footer>
  );
}

function KeyStatus({ name, ok }: { name: string; ok: boolean | undefined }) {
  const color =
    ok === undefined ? "text-terminal-dim"
      : ok           ? "text-accent-green"
      :                "text-accent-red";
  const dot =
    ok === undefined ? "bg-terminal-dim"
      : ok           ? "bg-accent-green"
      :                "bg-accent-red";
  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {name}
    </span>
  );
}
