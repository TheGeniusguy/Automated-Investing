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
      { key: "macro-heatmap", label: "Heatmap" },
      { key: "pinboard", label: "Pinboard" },
      { key: "macro-explorer", label: "Explorer" },
      { key: "deep-economy", label: "Deep Economy" },
      { key: "rate-path", label: "Fed Rate Path" },
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
    ],
  },
  {
    label: "Markets",
    items: [
      { key: "sector-rotation", label: "Sector Rotation" },
      { key: "real-estate", label: "Real Estate" },
      { key: "commodities-curve", label: "Commodities Curve" },
      { key: "energy", label: "Energy" },
      { key: "shipping", label: "Shipping" },
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
      { key: "insider", label: "Insider Transactions" },
      { key: "market-insiders", label: "Market Insiders" },
      { key: "institutional", label: "13F Holdings" },
      { key: "portfolio", label: "Portfolio Tracker" },
      { key: "estimates", label: "Analyst Estimates" },
      { key: "seasonality", label: "Seasonality" },
      { key: "factor-analysis", label: "Factor Analysis" },
      { key: "short-interest", label: "Short Interest" },
    ],
  },
  {
    label: "Cross-Asset",
    items: [
      { key: "crypto", label: "Crypto" },
      { key: "fx", label: "FX / Currencies" },
      { key: "fixed-income", label: "Fixed Income" },
      { key: "bond-analytics", label: "Bond Analytics" },
      { key: "fx-analytics", label: "FX Analytics" },
      { key: "credit-curves", label: "Credit & CDS" },
    ],
  },
  {
    label: "Trading",
    items: [
      { key: "journal", label: "Regime Journal" },
      { key: "correlations", label: "Correlations" },
      { key: "options", label: "Options" },
      { key: "earnings", label: "Earnings" },
      { key: "news", label: "News" },
      { key: "market-news", label: "Market News" },
      { key: "filings", label: "SEC Filings" },
      { key: "options-analytics", label: "Options Analytics" },
      { key: "backtest", label: "Backtester" },
      { key: "cot", label: "Positioning (COT)" },
    ],
  },
  {
    label: "Data",
    items: [
      { key: "data-infra", label: "DB Status" },
      { key: "calendar", label: "Calendar" },
      { key: "alerts", label: "Alerts" },
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
