import { useCallback, useEffect, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { api } from "../api/client";
import type { HealthResponse } from "../api/types";
import { ChatPanel } from "./ChatPanel";
import { CommandPalette } from "./CommandPalette";
import { ComparePanel } from "./ComparePanel";
import { CorrelationsPanel } from "./CorrelationsPanel";
import { CryptoPanel } from "./CryptoPanel";
import { FixedIncomePanel } from "./FixedIncomePanel";
import { FXPanel } from "./FXPanel";
import { DailyBriefingPanel } from "./DailyBriefingPanel";
import { DataInfraPanel } from "./DataInfraPanel";
import { EarningsPanel } from "./EarningsPanel";
import { EnergyPanel } from "./EnergyPanel";
import { ETFComparePanel } from "./ETFComparePanel";
import { EventsCalendarPanel } from "./EventsCalendarPanel";
import { FilingsPanel } from "./FilingsPanel";
import { FundamentalsBrowser } from "./FundamentalsBrowser";
import { InflationDashboard } from "./InflationDashboard";
import { InsiderTransactionsPanel } from "./InsiderTransactionsPanel";
import { InstitutionalHoldingsPanel } from "./InstitutionalHoldingsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { MacroExplorer } from "./MacroExplorer";
import { MacroHeatmap } from "./MacroHeatmap";
import { MacroPinboard } from "./MacroPinboard";
import { MacroRegimeTracker } from "./MacroRegimeTracker";
import { NewsPanel } from "./NewsPanel";
import { OptionsPanel } from "./OptionsPanel";
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
import { YieldCurvePanel } from "./YieldCurvePanel";

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
            <SectorDetailPanel
              sectorId={activeSector}
              onBack={() => setActiveSector(null)}
              onSelectSector={setActiveSector}
            />
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
                <DailyBriefingPanel />
              </div>
              <div key="chat" data-panel-key="chat">
                <ChatPanel />
              </div>
              <div key="macro" data-panel-key="macro">
                <MacroRegimeTracker />
              </div>
              <div key="regime-v2" data-panel-key="regime-v2">
                <RegimeV2Panel />
              </div>
              <div key="yield-curve" data-panel-key="yield-curve">
                <YieldCurvePanel />
              </div>
              <div key="inflation" data-panel-key="inflation">
                <InflationDashboard />
              </div>
              <div key="recession" data-panel-key="recession">
                <RecessionDashboard />
              </div>
              <div key="macro-heatmap" data-panel-key="macro-heatmap">
                <MacroHeatmap />
              </div>
              <div key="pinboard" data-panel-key="pinboard">
                <MacroPinboard />
              </div>
              <div key="macro-explorer" data-panel-key="macro-explorer">
                <MacroExplorer />
              </div>
              <div key="energy" data-panel-key="energy">
                <EnergyPanel />
              </div>
              <div key="shipping" data-panel-key="shipping">
                <ShippingPanel />
              </div>
              <div key="journal" data-panel-key="journal">
                <RegimeJournal />
              </div>
              <div key="correlations" data-panel-key="correlations">
                <CorrelationsPanel />
              </div>
              <div key="options" data-panel-key="options">
                <OptionsPanel />
              </div>
              <div key="earnings" data-panel-key="earnings">
                <EarningsPanel />
              </div>
              <div key="news" data-panel-key="news">
                <NewsPanel />
              </div>
              <div key="filings" data-panel-key="filings">
                <FilingsPanel />
              </div>
              <div key="data-infra" data-panel-key="data-infra">
                <DataInfraPanel />
              </div>
              <div key="fundamentals" data-panel-key="fundamentals">
                <FundamentalsBrowser />
              </div>
              <div key="sector-rotation" data-panel-key="sector-rotation">
                <SectorRotationPanel />
              </div>
              <div key="indicators" data-panel-key="indicators">
                <TechnicalIndicatorsPanel />
              </div>
              <div key="calendar" data-panel-key="calendar">
                <EventsCalendarPanel />
              </div>
              <div key="screener" data-panel-key="screener">
                <ScreenerPanel />
              </div>
              <div key="watchlists" data-panel-key="watchlists">
                <WatchlistsPanel />
              </div>
              <div key="compare" data-panel-key="compare">
                <ComparePanel />
              </div>
              <div key="real-estate" data-panel-key="real-estate">
                <RealEstatePanel />
              </div>
              <div key="insider" data-panel-key="insider">
                <InsiderTransactionsPanel />
              </div>
              <div key="institutional" data-panel-key="institutional">
                <InstitutionalHoldingsPanel />
              </div>
              <div key="portfolio" data-panel-key="portfolio">
                <PortfolioPanel />
              </div>
              <div key="etf-compare" data-panel-key="etf-compare">
                <ETFComparePanel />
              </div>
              <div key="crypto" data-panel-key="crypto">
                <CryptoPanel />
              </div>
              <div key="fx" data-panel-key="fx">
                <FXPanel />
              </div>
              <div key="fixed-income" data-panel-key="fixed-income">
                <FixedIncomePanel />
              </div>
              <div key="ticker-dossier" data-panel-key="ticker-dossier">
                <TickerDossierPanel symbol={dossierSymbol} />
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
    <header className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-panel">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="text-terminal-muted hover:text-accent text-sm px-1"
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarOpen ? "\u2630" : "\u2630"}
        </button>
        <span className="text-accent-amber font-semibold tracking-widest text-sm">
          AI &#9656; TERMINAL
        </span>
        <span className="text-terminal-muted text-2xs uppercase tracking-wider">
          Automated-Investing
        </span>
      </div>
      <div className="flex items-center gap-3 text-2xs text-terminal-muted">
        <span>{health?.claude_model ?? "--"}</span>
        <span>{now.toISOString().slice(11, 19)} UTC</span>
      </div>
    </header>
  );
}

function StatusBar({ health, now }: { health: HealthResponse | null; now: Date }) {
  const fred = health?.fred_configured;
  const claude = health?.anthropic_configured;
  return (
    <footer className="flex items-center justify-between px-3 py-1.5 border-t border-terminal-border bg-terminal-panel text-2xs text-terminal-muted">
      <div className="flex items-center gap-4">
        <KeyStatus name="FRED" ok={fred} />
        <KeyStatus name="ANTHROPIC" ok={claude} />
      </div>
      <div className="flex items-center gap-3">
        <span>{now.toLocaleDateString()}</span>
        <span className="text-accent-green">● connected</span>
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
