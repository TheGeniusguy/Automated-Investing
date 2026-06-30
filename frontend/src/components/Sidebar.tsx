import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { SectorListItem } from "../api/types";

interface SidebarProps {
  activeSector: string | null;
  onSelectSector: (sectorId: string | null) => void;
  onScrollTo: (panelKey: string) => void;
}

export const NAV_SECTIONS = [
  {
    label: "Overview",
    items: [
      { key: "briefing", label: "Daily Briefing" },
      { key: "chat", label: "Ask the Terminal" },
    ],
  },
  {
    label: "Macro",
    items: [
      { key: "macro", label: "Regime Tracker" },
      { key: "regime-v2", label: "Regime V2" },
      { key: "yield-curve", label: "Yield Curve" },
      { key: "inflation", label: "Inflation" },
      { key: "recession", label: "Recession" },
      { key: "econ-surprise", label: "Econ Surprise" },
      { key: "financial-conditions", label: "Financial Conditions" },
      { key: "pmi-diffusion", label: "PMI Diffusion" },
      { key: "macro-heatmap", label: "Heatmap" },
      { key: "pinboard", label: "Pinboard" },
      { key: "macro-explorer", label: "Explorer" },
      { key: "deep-economy", label: "Deep Economy" },
      { key: "rate-path", label: "Fed Rate Path" },
      { key: "central-bank-rates", label: "Central-Bank Rates" },
      { key: "net-liquidity", label: "Fed Net Liquidity" },
      { key: "taylor-rule", label: "Taylor Rule" },
      { key: "breakevens", label: "Breakevens & Real Yields" },
      { key: "macro-scorecard", label: "Global Macro Scorecard" },
      { key: "repo-funding", label: "Repo & Funding" },
      { key: "money-supply", label: "Money & Credit" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { key: "advanced-analytics", label: "Advanced Analytics" },
      { key: "proforma", label: "Pro Forma Modeling" },
      { key: "weighted-portfolio", label: "Weighted Portfolio" },
      { key: "paper-trading", label: "Paper Trading" },
      { key: "etf-tracking", label: "ETF Tracking" },
      { key: "montecarlo", label: "Monte Carlo" },
      { key: "allocation-optimizer", label: "Allocation Optimizer" },
      { key: "portfolio-risk", label: "Portfolio Risk / VaR" },
      { key: "portfolio-attribution", label: "Performance Attribution" },
      { key: "portfolio-whatif", label: "Pre-Trade What-If" },
      { key: "portfolio-component-var", label: "Component VaR" },
      { key: "portfolio-hedging", label: "Hedging & Overlay" },
      { key: "capture-ratios", label: "Capture Ratios" },
    ],
  },
  {
    label: "Markets",
    items: [
      { key: "sector-rotation", label: "Sector Rotation" },
      { key: "rrg", label: "Rotation Graph (RRG)" },
      { key: "world-indices", label: "World Indices" },
      { key: "real-estate", label: "Real Estate" },
      { key: "commodities-curve", label: "Commodities Curve" },
      { key: "crack-spreads", label: "Crack Spreads" },
      { key: "commodity-spreads", label: "Commodity Spreads" },
      { key: "energy", label: "Energy" },
      { key: "natgas-storage", label: "Nat-Gas Storage" },
      { key: "degree-days", label: "Degree Days (HDD/CDD)" },
      { key: "shipping", label: "Shipping" },
      { key: "carbon-markets", label: "Carbon & Emissions" },
    ],
  },
  {
    label: "Stocks",
    items: [
      { key: "ticker-dossier", label: "Ticker Dossier" },
      { key: "compare", label: "Compare / Portfolio" },
      { key: "etf-compare", label: "ETF Comparison" },
      { key: "investment-compare", label: "Investment Compare" },
      { key: "indicators", label: "Technical Analysis" },
      { key: "screener", label: "Screener" },
      { key: "watchlists", label: "Watchlists" },
      { key: "fundamentals", label: "Fundamentals" },
      { key: "comps", label: "Comps (RV)" },
      { key: "earnings-quality", label: "Earnings Quality" },
      { key: "insider", label: "Insider Transactions" },
      { key: "market-insiders", label: "Market Insiders" },
      { key: "institutional", label: "13F Holdings" },
      { key: "portfolio", label: "Portfolio Tracker" },
      { key: "estimates", label: "Analyst Estimates" },
      { key: "seasonality", label: "Seasonality" },
      { key: "factor-analysis", label: "Factor Analysis" },
      { key: "short-interest", label: "Short Interest" },
      { key: "dark-pool", label: "Dark-Pool Short Vol" },
      { key: "etf-flows", label: "ETF Net-Flow" },
      { key: "pairs", label: "Pairs / Rel Value" },
      { key: "dividend-tracker", label: "Dividends & Buybacks" },
      { key: "rating-changes", label: "Rating Changes" },
      { key: "dupont-roe", label: "DuPont ROE" },
      { key: "candlestick", label: "Candlestick Patterns" },
      { key: "esg", label: "ESG & Controversy" },
      { key: "insider-clusters", label: "Insider Clusters" },
      { key: "renko-kagi", label: "Renko & Kagi" },
    ],
  },
  {
    label: "Cross-Asset",
    items: [
      { key: "crypto", label: "Crypto" },
      { key: "fx", label: "FX / Currencies" },
      { key: "fixed-income", label: "Fixed Income" },
      { key: "treasury-auctions", label: "Treasury Auctions" },
      { key: "bond-analytics", label: "Bond Analytics" },
      { key: "forward-rates", label: "Forward-Rate Matrix" },
      { key: "carry-rolldown", label: "Carry & Rolldown" },
      { key: "sovereign-bonds", label: "Global Sovereign Bonds" },
      { key: "swap-curve", label: "Swap Curve & Pricer" },
      { key: "em-sovereign", label: "EM Sovereign Risk" },
      { key: "fx-analytics", label: "FX Analytics" },
      { key: "reer", label: "REER Fair Value" },
      { key: "credit-curves", label: "Credit & CDS" },
      { key: "oas-curves", label: "Credit Spreads (OAS)" },
      { key: "cds-pricer", label: "CDS Pricer" },
      { key: "fx-seasonality", label: "FX Seasonality" },
      { key: "fx-correlation", label: "FX Correlation" },
    ],
  },
  {
    label: "Trading",
    items: [
      { key: "journal", label: "Regime Journal" },
      { key: "correlations", label: "Correlations" },
      { key: "options", label: "Options" },
      { key: "vol-dashboard", label: "Volatility Dashboard" },
      { key: "earnings", label: "Earnings" },
      { key: "news", label: "News" },
      { key: "news-sentiment", label: "News Sentiment" },
      { key: "fear-greed", label: "Fear & Greed" },
      { key: "news-heat", label: "News Heat" },
      { key: "social-sentiment", label: "Social Sentiment" },
      { key: "market-news", label: "Market News" },
      { key: "filings", label: "SEC Filings" },
      { key: "superinvestors", label: "Superinvestors (13F)" },
      { key: "holdings-changes", label: "13F Changes & Crowding" },
      { key: "volume-profile", label: "Volume Profile" },
      { key: "options-analytics", label: "Options Analytics" },
      { key: "options-strategy", label: "Strategy Builder" },
      { key: "unusual-options", label: "Unusual Options" },
      { key: "backtest", label: "Backtester" },
      { key: "cot", label: "Positioning (COT)" },
      { key: "deals", label: "M&A / Deals" },
    ],
  },
  {
    label: "Data",
    items: [
      { key: "data-infra", label: "DB Status" },
      { key: "calendar", label: "Calendar" },
      { key: "econ-calendar", label: "Economic Calendar" },
      { key: "alerts", label: "Alerts" },
      { key: "edgar-search", label: "EDGAR Search" },
    ],
  },
];

// Flat list of every panel nav target — consumed by the command palette.
export const PANEL_NAV: { key: string; label: string; section: string }[] =
  NAV_SECTIONS.flatMap((s) =>
    s.items.map((item) => ({ ...item, section: s.label })),
  );

export function Sidebar({ activeSector, onSelectSector, onScrollTo }: SidebarProps) {
  const [sectors, setSectors] = useState<SectorListItem[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.sectorsList().then((r) => setSectors(r.sectors)).catch(() => {});
  }, []);

  const toggle = (section: string) =>
    setCollapsed((prev) => ({ ...prev, [section]: !prev[section] }));

  return (
    <aside className="w-56 flex-shrink-0 bg-terminal-panel border-r border-terminal-border overflow-y-auto flex flex-col pb-2">
      <div className="px-5 py-4 border-b border-terminal-divider">
        <span className="font-serif text-base leading-none tracking-tight text-terminal-text">
          Navigation
        </span>
      </div>

      {/* Panel navigation */}
      {NAV_SECTIONS.map((section) => (
        <div key={section.label} className="pt-1">
          <button
            type="button"
            onClick={() => toggle(section.label)}
            className="w-full flex items-center justify-between px-5 py-1.5 text-2xs text-terminal-muted uppercase tracking-[0.16em] font-semibold hover:text-terminal-text transition-colors"
          >
            <span>{section.label}</span>
            <span className="text-terminal-dim">
              {collapsed[section.label] ? "+" : "-"}
            </span>
          </button>
          {!collapsed[section.label] && (
            <div className="flex flex-col">
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    onSelectSector(null);
                    onScrollTo(item.key);
                  }}
                  className="text-left px-5 py-2 text-xs text-terminal-muted hover:bg-accent/10 hover:text-accent transition-colors"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Sectors */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => toggle("Sectors")}
          className="w-full flex items-center justify-between px-5 py-1.5 text-2xs text-terminal-muted uppercase tracking-[0.16em] font-semibold hover:text-terminal-text transition-colors"
        >
          <span>Sectors ({sectors.length})</span>
          <span className="text-terminal-dim">
            {collapsed["Sectors"] ? "+" : "-"}
          </span>
        </button>
        {!collapsed["Sectors"] && (
          <div className="flex flex-col">
            {sectors.map((sec) => (
              <button
                key={sec.id}
                type="button"
                onClick={() => onSelectSector(sec.id)}
                className={`text-left px-5 py-2 text-xs transition-colors flex items-center gap-2 ${
                  activeSector === sec.id
                    ? "bg-accent/15 text-accent border-l-2 border-accent"
                    : "text-terminal-muted hover:bg-accent/10 hover:text-accent"
                }`}
              >
                <span className="truncate">{sec.name}</span>
                <span className="text-terminal-dim text-2xs ml-auto">{sec.etf}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />
    </aside>
  );
}
