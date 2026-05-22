import type {
  CalendarUpcomingResponse,
  CalendarWeekResponse,
  ChartEventsResponse,
  ChartLayout,
  CorrelationsResponse,
  DbStatus,
  Drawing,
  FilingsDefaults,
  FilingsResponse,
  FundamentalsResponse,
  HealthResponse,
  ChainSummaries,
  DailyBriefingCached,
  EarningsOverview,
  EnergyDashboard,
  EnergySection,
  IndicatorKind,
  IndicatorResponse,
  InstrumentSearchResult,
  MacroCatalog,
  MacroSnapshot,
  MultiIndicatorRequest,
  MultiIndicatorResponse,
  NewsFeed,
  ScreenerFilter,
  ScreenerResponse,
  ScreenerSchema,
  SectorRotationResponse,
  ShippingDashboard,
  VixTerm,
  JournalSpxResponse,
  RegimeHistoryResponse,
  RegimeState,
  SeriesBundle,
  StressTestPosition,
  StressTestResponse,
  Watchlist,
  WatchlistSummary,
} from "./types";

// In dev, Vite proxies /api → backend. In prod, same-origin or VITE_API_BASE.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText} — ${path}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health:        ()                    => getJSON<HealthResponse>("/api/health"),
  allSeries:     (days = 90)           => getJSON<SeriesBundle>(`/api/macro/series?days=${days}`),
  currentRegime: ()                    => getJSON<RegimeState>("/api/regime/current"),
  regimeHistory: (days = 365)          => getJSON<RegimeHistoryResponse>(`/api/regime/history?days=${days}`),
  journalSpx:    (days = 3650)         => getJSON<JournalSpxResponse>(`/api/journal/spx?days=${days}`),
  correlations:  (recent = 30, baseline = 365) =>
    getJSON<CorrelationsResponse>(`/api/correlations?recent_days=${recent}&baseline_days=${baseline}`),
  filingsDefaults: () => getJSON<FilingsDefaults>("/api/filings/defaults"),
  filings: (tickers: string[], days = 30, forms: string[] = []) => {
    const qs = new URLSearchParams({
      tickers: tickers.join(","),
      days:    String(days),
      forms:   forms.join(","),
    });
    return getJSON<FilingsResponse>(`/api/filings?${qs}`);
  },
  stressTest:    (positions: StressTestPosition[], days = 3650) =>
    fetch(`${API_BASE}/api/portfolio/stress-test`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ positions, days }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json() as Promise<StressTestResponse>;
    }),

  // DuckDB
  dbStatus: () => getJSON<DbStatus>("/api/db/status"),
  searchInstruments: (q: string, limit = 15) =>
    getJSON<{ results: InstrumentSearchResult[] }>(
      `/api/db/instruments/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  dbFundamentals: (symbol: string) =>
    getJSON<FundamentalsResponse>(`/api/db/fundamentals?symbol=${encodeURIComponent(symbol)}`),

  // News
  newsFeed: (tickers: string[], perTicker = 8, overall = 60) =>
    getJSON<NewsFeed>(
      `/api/news/feed?tickers=${encodeURIComponent(tickers.join(","))}&per_ticker=${perTicker}&overall=${overall}`,
    ),

  // Options
  vixTerm:        () => getJSON<VixTerm>("/api/options/vix-term"),
  optionChains:   (tickers: string[], targetDays = 30) =>
    getJSON<ChainSummaries>(
      `/api/options/chains?tickers=${encodeURIComponent(tickers.join(","))}&target_days=${targetDays}`,
    ),

  // Earnings
  earningsOverview: (tickers: string[]) =>
    getJSON<EarningsOverview>(`/api/earnings/overview?tickers=${encodeURIComponent(tickers.join(","))}`),

  // Daily briefing
  dailyBriefingCached: () => getJSON<DailyBriefingCached>("/api/briefing/daily/cached"),

  // Macro catalog / snapshots
  macroCatalog:     () => getJSON<MacroCatalog>("/api/macro/catalog"),
  macroSnapshot:    (category: string) => getJSON<MacroSnapshot>(`/api/macro/snapshot/${encodeURIComponent(category)}`),

  // Energy / Shipping
  energyDashboard:  () => getJSON<EnergyDashboard>("/api/energy/dashboard"),
  energySection:    (section: string) => getJSON<EnergySection>(`/api/energy/section/${encodeURIComponent(section)}`),
  shippingDashboard: () => getJSON<ShippingDashboard>("/api/shipping/dashboard"),

  // ETL triggers
  ingestUniverse: () =>
    fetch(`${API_BASE}/api/ingest/universe`, { method: "POST" }).then(_jsonOrThrow),
  ingestPrices: (symbols: string[], days = 3650) =>
    fetch(
      `${API_BASE}/api/ingest/prices?symbols=${encodeURIComponent(symbols.join(","))}&days=${days}`,
      { method: "POST" },
    ).then(_jsonOrThrow),
  ingestFundamentals: (symbols: string[]) =>
    fetch(
      `${API_BASE}/api/ingest/fundamentals?symbols=${encodeURIComponent(symbols.join(","))}`,
      { method: "POST" },
    ).then(_jsonOrThrow),

  // ── Wave 2: Watchlists (DB-backed multi)
  listWatchlists: () =>
    getJSON<{ watchlists: WatchlistSummary[] }>("/api/watchlists"),
  getWatchlist: (id: number) => getJSON<Watchlist>(`/api/watchlists/${id}`),
  createWatchlist: (name: string, description?: string) =>
    fetch(`${API_BASE}/api/watchlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    }).then(_jsonOrThrow) as Promise<Watchlist>,
  updateWatchlist: (
    id: number,
    patch: { name?: string; description?: string; is_default?: boolean },
  ) =>
    fetch(`${API_BASE}/api/watchlists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(_jsonOrThrow) as Promise<Watchlist>,
  deleteWatchlist: (id: number) =>
    fetch(`${API_BASE}/api/watchlists/${id}`, { method: "DELETE" }).then(_jsonOrThrow),
  addWatchlistItem: (
    id: number,
    item: { ticker: string; label?: string; group_name?: string; order_index?: number },
  ) =>
    fetch(`${API_BASE}/api/watchlists/${id}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    }).then(_jsonOrThrow),
  removeWatchlistItem: (id: number, ticker: string) =>
    fetch(`${API_BASE}/api/watchlists/${id}/items/${encodeURIComponent(ticker)}`, {
      method: "DELETE",
    }).then(_jsonOrThrow),
  reorderWatchlistItems: (id: number, tickers: string[]) =>
    fetch(`${API_BASE}/api/watchlists/${id}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers }),
    }).then(_jsonOrThrow),

  // ── Wave 2: Technical Indicators
  indicator: (
    symbol: string,
    indicator: IndicatorKind,
    opts: Partial<{ period: number; fast: number; slow: number; signal: number; std_dev: number; days: number }> = {},
  ) => {
    const qs = new URLSearchParams({ indicator });
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return getJSON<IndicatorResponse>(`/api/indicators/${encodeURIComponent(symbol)}?${qs}`);
  },

  // ── Wave 2: Sector Rotation
  sectorRotation: () => getJSON<SectorRotationResponse>("/api/sector-rotation"),

  // ── Insider Transactions
  insiderSummary: (symbol: string, days = 365) =>
    getJSON<import("./types").InsiderTickerResponse>(
      `/api/insider/${encodeURIComponent(symbol)}?days=${days}`,
    ),
  insiderIngest: (tickers: string[], days = 365) =>
    fetch(`${API_BASE}/api/insider/ingest?tickers=${encodeURIComponent(tickers.join(","))}&days=${days}`, {
      method: "POST",
    }).then(_jsonOrThrow),

  // ── 13F Institutional Holdings
  institutionalFilers: () =>
    getJSON<{ filers: import("./types").InstitutionalFiler[] }>("/api/institutional/filers"),
  institutionalIngest: () =>
    fetch(`${API_BASE}/api/institutional/ingest`, { method: "POST" }).then(_jsonOrThrow),
  institutionalHolders: (symbol: string, limit = 20) =>
    getJSON<{ symbol: string; holders: import("./types").InstitutionalHolder[] }>(
      `/api/institutional/holders/${encodeURIComponent(symbol)}?limit=${limit}`,
    ),
  institutionalPortfolio: (filerCik: string, reportDate?: string) =>
    getJSON<import("./types").InstitutionalPortfolio>(
      `/api/institutional/portfolio/${encodeURIComponent(filerCik)}${reportDate ? `?report_date=${reportDate}` : ""}`,
    ),
  institutionalChanges: (filerCik: string) =>
    getJSON<import("./types").InstitutionalChanges>(
      `/api/institutional/changes/${encodeURIComponent(filerCik)}`,
    ),

  // ── Compare / Portfolio Simulator
  compare: (tickers: string[], days = 365) =>
    getJSON<import("./types").CompareResponse>(
      `/api/compare?tickers=${encodeURIComponent(tickers.join(","))}&days=${days}`,
    ),
  portfolioSimulate: (positions: { ticker: string; weight: number }[], days = 365) =>
    fetch(`${API_BASE}/api/compare/portfolio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions, days }),
    }).then(_jsonOrThrow) as Promise<import("./types").PortfolioSimResponse>,

  // ── Real Estate Deep-Dive
  realEstateOverview: () =>
    getJSON<import("./types").ReOverview>("/api/real-estate/overview"),
  realEstateSubsectors: () =>
    getJSON<{ subsectors: import("./types").ReSubsectorListItem[] }>("/api/real-estate/subsectors"),
  realEstateSubsector: (id: string) =>
    getJSON<import("./types").ReSubsectorDetail>(`/api/real-estate/${encodeURIComponent(id)}`),

  // ── Sector Detail
  sectorsList: () =>
    getJSON<{ sectors: import("./types").SectorListItem[] }>("/api/sectors"),
  sectorsOverview: () =>
    getJSON<import("./types").SectorOverviewResponse>("/api/sectors/overview"),
  sectorDetail: (sectorId: string) =>
    getJSON<import("./types").SectorDetailResponse>(`/api/sectors/${encodeURIComponent(sectorId)}`),
  sectorKpis: (sectorId: string) =>
    getJSON<import("./types").SectorKpisResponse>(`/api/sectors/${encodeURIComponent(sectorId)}/kpis`),
  sectorMacroDrivers: (sectorId: string) =>
    getJSON<import("./types").SectorMacroDriversResponse>(`/api/sectors/${encodeURIComponent(sectorId)}/macro-drivers`),

  // ── Wave 2: Screener
  screenerSchema: () => getJSON<ScreenerSchema>("/api/screener/schema"),
  runScreener: (req: {
    filters: ScreenerFilter[];
    sort?: string;
    sort_dir?: string;
    limit?: number;
    offset?: number;
  }) =>
    fetch(`${API_BASE}/api/screener`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then(_jsonOrThrow) as Promise<ScreenerResponse>,

  // ── Wave 3: Multi-indicator batch
  indicatorsMulti: (req: MultiIndicatorRequest) =>
    fetch(`${API_BASE}/api/indicators/multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then(_jsonOrThrow) as Promise<MultiIndicatorResponse>,

  indicatorMeta: () =>
    getJSON<{ supported: string[]; timeframes: string[] }>("/api/indicators"),

  // ── Wave 3: Calendar
  calendarWeek: (reference_date?: string) =>
    getJSON<CalendarWeekResponse>(
      reference_date
        ? `/api/calendar/week?reference_date=${encodeURIComponent(reference_date)}`
        : "/api/calendar/week",
    ),
  calendarUpcoming: (daysForward = 14) =>
    getJSON<CalendarUpcomingResponse>(`/api/calendar/upcoming?days_forward=${daysForward}`),

  // ── Wave 3: Drawings
  listDrawings: (symbol: string, timeframe = "1d") =>
    getJSON<{ drawings: Drawing[] }>(
      `/api/drawings?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`,
    ),
  createDrawing: (req: {
    symbol: string;
    timeframe?: string;
    drawing_type: string;
    points: { time: string; price: number }[];
    style?: Record<string, unknown>;
    label?: string;
  }) =>
    fetch(`${API_BASE}/api/drawings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then(_jsonOrThrow) as Promise<Drawing>,
  updateDrawing: (
    id: number,
    patch: {
      points?: { time: string; price: number }[];
      style?: Record<string, unknown>;
      label?: string;
    },
  ) =>
    fetch(`${API_BASE}/api/drawings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(_jsonOrThrow) as Promise<Drawing>,
  deleteDrawing: (id: number) =>
    fetch(`${API_BASE}/api/drawings/${id}`, { method: "DELETE" }).then(_jsonOrThrow),
  clearDrawings: (symbol: string, timeframe = "1d") =>
    fetch(
      `${API_BASE}/api/drawings?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`,
      { method: "DELETE" },
    ).then(_jsonOrThrow),

  // ── Wave 4: Chart layouts
  getLayout: (symbol: string, timeframe = "1d") =>
    getJSON<ChartLayout>(`/api/layouts/${encodeURIComponent(symbol)}?timeframe=${timeframe}`),
  saveLayout: (symbol: string, timeframe: string, state: Record<string, unknown>) =>
    fetch(`${API_BASE}/api/layouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, timeframe, state }),
    }).then(_jsonOrThrow) as Promise<ChartLayout>,
  deleteLayout: (symbol: string, timeframe = "1d") =>
    fetch(
      `${API_BASE}/api/layouts/${encodeURIComponent(symbol)}?timeframe=${timeframe}`,
      { method: "DELETE" },
    ).then(_jsonOrThrow),

  // ── Wave 4: Chart event markers (filings + earnings + macro)
  chartEvents: (symbol: string, days = 365) =>
    getJSON<ChartEventsResponse>(
      `/api/chart-events/${encodeURIComponent(symbol)}?days=${days}`,
    ),

  // ── Wave 5: Mile-deep Macro
  yieldCurveDashboard: () =>
    getJSON<import("./types").YieldCurveDashboard>("/api/yield-curve/dashboard"),
  yieldCurveCurrent: (real = false) =>
    getJSON<import("./types").YieldCurve>(`/api/yield-curve/current?real=${real}`),
  yieldCurveHistorical: (date: string, real = false) =>
    getJSON<import("./types").YieldCurve>(
      `/api/yield-curve/historical?date=${date}&real=${real}`,
    ),
  yieldCurveSpread: (id: string, days = 365 * 5) =>
    getJSON<import("./types").SpreadSeries>(`/api/yield-curve/spread/${id}?days=${days}`),
  yieldCurveButterfly: (id: string, days = 365 * 2) =>
    getJSON<import("./types").SpreadSeries>(`/api/yield-curve/butterfly/${id}?days=${days}`),

  inflationDashboard: () =>
    getJSON<import("./types").InflationDashboard>("/api/inflation/dashboard"),

  recessionDashboard: () =>
    getJSON<import("./types").RecessionDashboard>("/api/recession/dashboard"),

  nowcastDashboard: () =>
    getJSON<import("./types").NowcastDashboard>("/api/nowcast/dashboard"),

  macroSeriesDetail: (id: string, transform: import("./types").MacroTransform = "level", years = 20) =>
    getJSON<import("./types").MacroSeriesDetail>(
      `/api/macro/series-detail/${encodeURIComponent(id)}?transform=${transform}&years=${years}`,
    ),

  macroHeatmap: (transform: import("./types").MacroTransform = "z_score") =>
    getJSON<import("./types").MacroHeatmap>(`/api/macro/heatmap?transform=${transform}`),

  regimeV2: () =>
    getJSON<import("./types").RegimeV2State>("/api/regime/v2"),

  listMacroBoards: () =>
    getJSON<{ boards: import("./types").MacroBoard[] }>("/api/macro/boards"),
  getMacroBoard: (id: number) =>
    getJSON<import("./types").MacroBoard>(`/api/macro/boards/${id}`),
  createMacroBoard: (payload: { name: string; description?: string; series_ids?: string[] }) =>
    fetch(`${API_BASE}/api/macro/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(_jsonOrThrow) as Promise<import("./types").MacroBoard>,
  updateMacroBoard: (id: number, payload: { name: string; description?: string; series_ids?: string[] }) =>
    fetch(`${API_BASE}/api/macro/boards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(_jsonOrThrow) as Promise<import("./types").MacroBoard>,
  deleteMacroBoard: (id: number) =>
    fetch(`${API_BASE}/api/macro/boards/${id}`, { method: "DELETE" }).then(_jsonOrThrow),
  macroBoardSnapshot: (id: number) =>
    getJSON<import("./types").MacroBoardSnapshot>(`/api/macro/boards/${id}/snapshot`),
};

async function _jsonOrThrow(r: Response): Promise<unknown> {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}


// Generic SSE consumer (Server-Sent Events over a POST request).
// Calls `onEvent(eventType, parsedData)` per event; resolves when the stream closes.
export async function streamSSE(
  url: string,
  init: RequestInit | undefined,
  signal: AbortSignal,
  onEvent: (eventType: string, data: unknown) => void,
): Promise<void> {
  const r = await fetch(`${API_BASE}${url}`, {
    ...init,
    signal,
    headers: { Accept: "text/event-stream", ...(init?.headers ?? {}) },
  });
  if (!r.ok || !r.body) {
    throw new Error(`${r.status} ${r.statusText}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        // Plain-text token payload — pass through as a string.
        onEvent(event, data);
      }
    }
  }
}

// SSE briefing — uses fetch streaming because EventSource doesn't support POST.
export interface BriefingEvents {
  onRegime?: (state: RegimeState) => void;
  onToken?:  (text: string) => void;
  onError?:  (err: string) => void;
  onDone?:   () => void;
}

export async function streamBriefing(
  signal: AbortSignal,
  positions: { ticker: string; weight: number }[] | null,
  handlers: BriefingEvents,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/briefing/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ positions }),
    signal,
  });
  if (!r.ok || !r.body) {
    handlers.onError?.(`${r.status} ${r.statusText}`);
    handlers.onDone?.();
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Tiny SSE parser — events separated by "\n\n".
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        switch (event) {
          case "regime": handlers.onRegime?.(parsed); break;
          case "token":  handlers.onToken?.(parsed.text ?? ""); break;
          case "error":  handlers.onError?.(parsed.error ?? "unknown error"); break;
          case "done":   handlers.onDone?.(); break;
        }
      } catch {
        // Malformed event — skip silently.
      }
    }
  }
  handlers.onDone?.();
}
