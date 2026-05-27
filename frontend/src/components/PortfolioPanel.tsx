import { useEffect, useState } from "react";

import { portfolioApi } from "../api/client";
import type { Portfolio } from "../api/types";
import { PortfolioCompareTab } from "./portfolio/PortfolioCompareTab";
import { PortfolioDividendsTab } from "./portfolio/PortfolioDividendsTab";
import { PortfolioFundamentalsTab } from "./portfolio/PortfolioFundamentalsTab";
import { PortfolioHeader } from "./portfolio/PortfolioHeader";
import { PortfolioOverviewTab } from "./portfolio/PortfolioOverviewTab";
import { PortfolioPerformanceTab } from "./portfolio/PortfolioPerformanceTab";
import { PortfolioPositionsTab } from "./portfolio/PortfolioPositionsTab";
import { PortfolioRiskTab } from "./portfolio/PortfolioRiskTab";
import { PortfolioTransactionsTab } from "./portfolio/PortfolioTransactionsTab";

type Tab = "Overview" | "Positions" | "Performance" | "Risk" | "Fundamentals" | "Dividends" | "Compare" | "Transactions";

const TABS: Tab[] = ["Overview", "Positions", "Performance", "Risk", "Fundamentals", "Dividends", "Compare", "Transactions"];

export function PortfolioPanel() {
  const [portfolios, setPortfolios]   = useState<Portfolio[]>([]);
  const [selectedId, setSelectedId]   = useState<number | null>(null);
  const [activeTab, setActiveTab]     = useState<Tab>("Overview");
  const [initialSymbol, setInitialSymbol] = useState<string | undefined>(undefined);
  const [loading, setLoading]         = useState(true);

  const loadPortfolios = () => {
    setLoading(true);
    portfolioApi
      .list()
      .then((list) => {
        setPortfolios(list);
        if (list.length > 0 && selectedId == null) {
          setSelectedId(list[0].id);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadPortfolios(); }, []);

  const handleCreated = () => {
    loadPortfolios();
    // Select the newly created portfolio (will be last in list)
    portfolioApi.list().then((list) => {
      if (list.length > 0) {
        setPortfolios(list);
        setSelectedId(list[list.length - 1].id);
        setActiveTab("Overview");
      }
    });
  };

  const handleDeleted = () => {
    setSelectedId(null);
    loadPortfolios();
  };

  const handleAddTrade = (symbol: string) => {
    setInitialSymbol(symbol);
    setActiveTab("Transactions");
  };

  const handleTransactionAdded = () => {
    // Refresh overview / positions when something changes
    setInitialSymbol(undefined);
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">Portfolio Tracker</span>
      </div>

      {/* Portfolio selector */}
      {loading ? (
        <div className="px-3 py-2 text-xs text-terminal-dim animate-pulse">Loading portfolios...</div>
      ) : (
        <PortfolioHeader
          portfolios={portfolios}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setActiveTab("Overview"); }}
          onCreated={handleCreated}
          onDeleted={handleDeleted}
        />
      )}

      {/* Tab bar */}
      <div className="flex border-b border-terminal-border overflow-x-auto flex-shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
              activeTab === tab
                ? "text-accent border-b-2 border-accent -mb-px"
                : "text-terminal-dim hover:text-terminal-fg"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === "Compare" && portfolios.length > 0 ? (
          <PortfolioCompareTab allPortfolios={portfolios} currentPortfolioId={selectedId} />
        ) : selectedId == null ? (
          <div className="flex-1 flex items-center justify-center text-xs text-terminal-dim">
            {portfolios.length === 0
              ? "Create a portfolio using the \"+ New\" button above to get started."
              : "Select a portfolio to view analytics."}
          </div>
        ) : (
          <>
            {activeTab === "Overview"      && <PortfolioOverviewTab      portfolioId={selectedId} />}
            {activeTab === "Positions"     && <PortfolioPositionsTab     portfolioId={selectedId} onAddTrade={handleAddTrade} />}
            {activeTab === "Performance"   && <PortfolioPerformanceTab   portfolioId={selectedId} />}
            {activeTab === "Risk"          && <PortfolioRiskTab          portfolioId={selectedId} />}
            {activeTab === "Fundamentals"  && <PortfolioFundamentalsTab  portfolioId={selectedId} />}
            {activeTab === "Dividends"     && <PortfolioDividendsTab     portfolioId={selectedId} />}
            {activeTab === "Compare"       && <PortfolioCompareTab       allPortfolios={portfolios} currentPortfolioId={selectedId} />}
            {activeTab === "Transactions"  && (
              <PortfolioTransactionsTab
                portfolioId={selectedId}
                initialSymbol={initialSymbol}
                onTransactionAdded={handleTransactionAdded}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
