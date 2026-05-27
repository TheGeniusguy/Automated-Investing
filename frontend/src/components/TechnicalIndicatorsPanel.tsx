import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type LineData,
  type Time,
} from "lightweight-charts";

import { api } from "../api/client";
import type {
  ChartMarker,
  Drawing,
  ExtendedDrawingType,
  MultiIndicatorResponse,
  OHLCVBar,
  SignalStrengthResponse,
  SupportResistanceResponse,
  Timeframe,
} from "../api/types";
import { DrawingsLayer } from "./DrawingsLayer";
import { DrawingPropertiesDialog } from "./DrawingPropertiesDialog";

// ─── Indicator catalog ─────────────────────────────────────────────────────

type Pane = "price" | "sub_volume" | "sub_rsi" | "sub_macd" | "sub_stoch"
          | "sub_adx" | "sub_cci" | "sub_williams" | "sub_mfi" | "sub_roc"
          | "sub_atr" | "sub_obv" | "sub_aroon" | "sub_vortex" | "sub_trix"
          | "sub_ultimate" | "sub_awesome" | "sub_cmf" | "sub_chaikin";

interface IndicatorDef {
  key: string;
  label: string;
  pane: Pane;
  color: string;
  backendName: string;
  defaultParams?: Record<string, number | string>;
  hasPeriod?: boolean;
  minPeriod?: number;
  maxPeriod?: number;
}

const OVERLAY_INDICATORS: IndicatorDef[] = [
  { key: "sma_20",         label: "SMA 20",     pane: "price", color: "#ffb800", backendName: "sma",  defaultParams: { period: 20  }, hasPeriod: true,  minPeriod: 5,  maxPeriod: 200 },
  { key: "sma_50",         label: "SMA 50",     pane: "price", color: "#5fb878", backendName: "sma",  defaultParams: { period: 50  }, hasPeriod: true,  minPeriod: 5,  maxPeriod: 200 },
  { key: "sma_200",        label: "SMA 200",    pane: "price", color: "#ef5350", backendName: "sma",  defaultParams: { period: 200 }, hasPeriod: true,  minPeriod: 5,  maxPeriod: 500 },
  { key: "ema_21",         label: "EMA 21",     pane: "price", color: "#8b5cf6", backendName: "ema",  defaultParams: { period: 21  }, hasPeriod: true,  minPeriod: 5,  maxPeriod: 200 },
  { key: "ema_50",         label: "EMA 50",     pane: "price", color: "#a78bfa", backendName: "ema",  defaultParams: { period: 50  }, hasPeriod: true,  minPeriod: 5,  maxPeriod: 200 },
  { key: "bollinger",      label: "Bollinger",  pane: "price", color: "#26a69a", backendName: "bollinger" },
  { key: "donchian",       label: "Donchian",   pane: "price", color: "#06b6d4", backendName: "donchian" },
  { key: "keltner",        label: "Keltner",    pane: "price", color: "#f59e0b", backendName: "keltner" },
  { key: "vwap",           label: "VWAP",       pane: "price", color: "#a78bfa", backendName: "vwap" },
  { key: "vwma",           label: "VWMA",       pane: "price", color: "#84cc16", backendName: "vwma" },
  { key: "hull_ma",        label: "Hull MA",    pane: "price", color: "#fb7185", backendName: "hull_ma" },
  { key: "kama",           label: "KAMA",       pane: "price", color: "#facc15", backendName: "kama" },
  { key: "supertrend",     label: "SuperTrend", pane: "price", color: "#22d3ee", backendName: "supertrend" },
  { key: "parabolic_sar",  label: "Parabolic SAR", pane: "price", color: "#fb7185", backendName: "parabolic_sar" },
  { key: "ichimoku",       label: "Ichimoku",   pane: "price", color: "#84cc16", backendName: "ichimoku" },
  { key: "support_resistance", label: "Auto S/R", pane: "price", color: "#94a3b8", backendName: "support_resistance" },
];

const SUB_INDICATORS: IndicatorDef[] = [
  { key: "rsi",                  label: "RSI",         pane: "sub_rsi",       color: "#8b5cf6", backendName: "rsi",        hasPeriod: true, minPeriod: 2, maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "macd",                 label: "MACD",        pane: "sub_macd",      color: "#26a69a", backendName: "macd" },
  { key: "stochastic",           label: "Stochastic",  pane: "sub_stoch",     color: "#5fb878", backendName: "stochastic" },
  { key: "adx",                  label: "ADX",         pane: "sub_adx",       color: "#f59e0b", backendName: "adx",        hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "cci",                  label: "CCI",         pane: "sub_cci",       color: "#06b6d4", backendName: "cci",        hasPeriod: true, minPeriod: 5,  maxPeriod: 100, defaultParams: { period: 20 } },
  { key: "williams_r",           label: "Williams %R", pane: "sub_williams",  color: "#fb7185", backendName: "williams_r", hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "mfi",                  label: "MFI",         pane: "sub_mfi",       color: "#a78bfa", backendName: "mfi",        hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "roc",                  label: "ROC",         pane: "sub_roc",       color: "#facc15", backendName: "roc",        hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 12 } },
  { key: "atr",                  label: "ATR",         pane: "sub_atr",       color: "#fbbf24", backendName: "atr",        hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "obv",                  label: "OBV",         pane: "sub_obv",       color: "#84cc16", backendName: "obv" },
  { key: "aroon",                label: "Aroon",       pane: "sub_aroon",     color: "#22d3ee", backendName: "aroon",      hasPeriod: true, minPeriod: 5,  maxPeriod: 100, defaultParams: { period: 25 } },
  { key: "vortex",               label: "Vortex",      pane: "sub_vortex",    color: "#f97316", backendName: "vortex",     hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 14 } },
  { key: "trix",                 label: "TRIX",        pane: "sub_trix",      color: "#c084fc", backendName: "trix" },
  { key: "ultimate_oscillator",  label: "Ultimate",    pane: "sub_ultimate",  color: "#34d399", backendName: "ultimate_oscillator" },
  { key: "awesome_oscillator",   label: "Awesome",     pane: "sub_awesome",   color: "#fde047", backendName: "awesome_oscillator" },
  { key: "cmf",                  label: "CMF",         pane: "sub_cmf",       color: "#60a5fa", backendName: "cmf",        hasPeriod: true, minPeriod: 5,  maxPeriod: 50, defaultParams: { period: 20 } },
  { key: "chaikin_oscillator",   label: "Chaikin Osc", pane: "sub_chaikin",   color: "#fb923c", backendName: "chaikin_oscillator" },
];

const ALL_INDICATORS = [...OVERLAY_INDICATORS, ...SUB_INDICATORS];
const KEY_TO_DEF: Record<string, IndicatorDef> = Object.fromEntries(ALL_INDICATORS.map((d) => [d.key, d]));

const TIMEFRAMES: Timeframe[] = ["1d", "1w", "1mo"];
const TIMEFRAME_LABEL: Record<Timeframe, string> = { "1d": "Daily", "1w": "Weekly", "1mo": "Monthly" };

const CHART_TYPES = ["candle", "heikin_ashi", "line", "area"] as const;
type ChartType = (typeof CHART_TYPES)[number];

const DRAWING_TOOLS: { key: "cursor" | ExtendedDrawingType; label: string; icon: string }[] = [
  { key: "cursor",                label: "Cursor",          icon: "↖" },
  { key: "trend_line",            label: "Trend",           icon: "/" },
  { key: "hline",                 label: "H-line",          icon: "—" },
  { key: "vline",                 label: "V-line",          icon: "|" },
  { key: "fib_retracement",       label: "Fib retr.",       icon: "≣" },
  { key: "fib_extension",         label: "Fib ext.",        icon: "↗" },
  { key: "fib_time_zones",        label: "Fib time",        icon: "⇶" },
  { key: "parallel_channel",      label: "Channel",         icon: "//" },
  { key: "rectangle",             label: "Rect",            icon: "▭" },
  { key: "risk_reward",           label: "R/R",             icon: "$" },
  { key: "arrow",                 label: "Arrow",           icon: "→" },
  { key: "text",                  label: "Text",            icon: "T" },
  { key: "anchored_vwap_anchor",  label: "Anchor VWAP",     icon: "⚓" },
];

// ─── Component ─────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 800;

interface TechnicalIndicatorsPanelProps {
  initialSymbol?: string;
}

export function TechnicalIndicatorsPanel({ initialSymbol }: TechnicalIndicatorsPanelProps = {}) {
  // ── State (most of it persisted via layouts) ──
  const [symbolInput, setSymbolInput] = useState(initialSymbol ?? "SPY");
  const [symbol, setSymbol] = useState(initialSymbol ?? "SPY");
  const [compareInput, setCompareInput] = useState("");
  const [compareSymbol, setCompareSymbol] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [scaleType, setScaleType] = useState<"linear" | "log">("linear");
  const [enabled, setEnabled] = useState<Set<string>>(new Set(["sma_50", "sma_200", "rsi", "macd"]));
  const [params, setParams] = useState<Record<string, Record<string, number>>>({});
  const [days, setDays] = useState<number>(365);
  const [showMarkers, setShowMarkers] = useState(true);
  const [snapToOhlc, setSnapToOhlc] = useState(false);
  const [drawingsLocked, setDrawingsLocked] = useState(false);
  const [showParamPanel, setShowParamPanel] = useState(false);

  // Sync when initialSymbol changes (e.g. clicking a stock in sector detail).
  useEffect(() => {
    if (initialSymbol && initialSymbol !== symbol) {
      setSymbol(initialSymbol);
      setSymbolInput(initialSymbol);
    }
  }, [initialSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loaded data ──
  const [data, setData] = useState<MultiIndicatorResponse | null>(null);
  const [haBars, setHaBars] = useState<OHLCVBar[] | null>(null);
  const [compareBars, setCompareBars] = useState<OHLCVBar[] | null>(null);
  const [signal, setSignal] = useState<SignalStrengthResponse | null>(null);
  const [markers, setMarkers] = useState<ChartMarker[]>([]);
  const [sr, setSr] = useState<SupportResistanceResponse | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [editingDrawing, setEditingDrawing] = useState<Drawing | null>(null);

  // ── UI state ──
  const [tool, setTool] = useState<"cursor" | ExtendedDrawingType>("cursor");
  const [hoverBar, setHoverBar] = useState<OHLCVBar | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── Refs ──
  const priceChartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const subChartRefs = useRef<Record<string, IChartApi>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subSeriesRefs = useRef<Record<string, ISeriesApi<any>>>({});
  const layoutLoadedRef = useRef(false);

  // ── Load layout on (symbol, timeframe) change ──
  useEffect(() => {
    layoutLoadedRef.current = false;
    api.getLayout(symbol, timeframe).then((layout) => {
      const s = layout.state;
      if (s) {
        if (s.enabled) setEnabled(new Set(s.enabled));
        if (s.params) setParams(s.params as Record<string, Record<string, number>>);
        if (s.chartType) setChartType(s.chartType as ChartType);
        if (s.scaleType) setScaleType(s.scaleType);
        if (s.compareSymbol !== undefined) setCompareSymbol(s.compareSymbol ?? null);
        if (s.showMarkers !== undefined) setShowMarkers(s.showMarkers);
        if (s.snapToOhlc !== undefined) setSnapToOhlc(s.snapToOhlc);
        if (s.drawingsLocked !== undefined) setDrawingsLocked(s.drawingsLocked);
        if (s.days) setDays(s.days);
      }
      layoutLoadedRef.current = true;
    }).catch(() => {
      layoutLoadedRef.current = true;
    });
  }, [symbol, timeframe]);

  // ── Debounced layout save ──
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const timer = setTimeout(() => {
      api.saveLayout(symbol, timeframe, {
        enabled:        Array.from(enabled),
        params,
        chartType,
        scaleType,
        compareSymbol,
        showMarkers,
        snapToOhlc,
        drawingsLocked,
        days,
      }).catch(() => { /* silent */ });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [symbol, timeframe, enabled, params, chartType, scaleType, compareSymbol, showMarkers, snapToOhlc, drawingsLocked, days]);

  // ── Fetch indicator data + extras ──
  const fetchData = useCallback(async () => {
    setData(null); setSignal(null); setErr(null); setHaBars(null);
    setSr(null); setCompareBars(null);

    try {
      // Group enabled keys by backend name; pass param overrides via separate fetches
      // (compute_many returns one per backend name).
      const backendNamesSeen = new Set<string>();
      for (const k of enabled) {
        const def = KEY_TO_DEF[k];
        if (def) backendNamesSeen.add(def.backendName);
      }
      // Always include rsi + macd if any divergence sub will be useful — keep simple.
      const base = Array.from(backendNamesSeen).filter((n) => n !== "support_resistance");
      const includeDivergence = enabled.has("rsi") || enabled.has("macd");

      const res = await api.indicatorsMulti({
        symbol, indicators: base, timeframe, days,
      });

      // For indicators with user-overridden params, refetch them individually.
      const extras: Promise<{ key: string; data: unknown }>[] = [];
      for (const k of enabled) {
        const def = KEY_TO_DEF[k];
        if (!def) continue;
        const merged = { ...(def.defaultParams ?? {}), ...(params[k] ?? {}) };
        if (Object.keys(merged).length === 0) continue;
        // SMA/EMA always need their period embedded (default fetches one).
        // Or if user supplied per-key params.
        if (def.backendName === "sma" || def.backendName === "ema" || params[k]) {
          extras.push(
            api.indicator(symbol, def.backendName as "sma", { ...merged, days })
              .then((d) => ({ key: k, data: d })),
          );
        }
      }
      const extraResults = await Promise.all(extras);
      const merged: Record<string, unknown> = { ...res.indicators };
      for (const r of extraResults) merged[r.key] = r.data;

      // Support/resistance if enabled
      if (enabled.has("support_resistance")) {
        try {
          const sres = await fetch(`/api/indicators/${encodeURIComponent(symbol)}?indicator=support_resistance&timeframe=${timeframe}&days=${days}`);
          if (sres.ok) setSr(await sres.json());
        } catch { /* ignore */ }
      }

      // Divergence — only when RSI or MACD enabled.
      if (includeDivergence) {
        try {
          for (const k of ["rsi", "macd"]) {
            if (!enabled.has(k)) continue;
            const dres = await fetch(`/api/indicators/${encodeURIComponent(symbol)}?indicator=divergence&kind=${k}&timeframe=${timeframe}&days=${days}`);
            if (dres.ok) merged[`divergence_${k}`] = await dres.json();
          }
        } catch { /* ignore */ }
      }

      setData({ ...res, indicators: merged });

      // Heikin Ashi bars when chart type is heikin_ashi.
      if (chartType === "heikin_ashi") {
        try {
          const hres = await fetch(`/api/indicators/${encodeURIComponent(symbol)}?indicator=heikin_ashi&timeframe=${timeframe}&days=${days}`);
          if (hres.ok) {
            const j = await hres.json();
            setHaBars(j.bars as OHLCVBar[]);
          }
        } catch { /* ignore */ }
      }

      // Compare overlay symbol bars.
      if (compareSymbol) {
        try {
          const cres = await api.indicatorsMulti({
            symbol: compareSymbol, indicators: [], timeframe, days,
          });
          setCompareBars(cres.bars);
        } catch { /* ignore */ }
      }

      // Signal composite.
      try {
        const sigRes = await fetch(`/api/indicators/${encodeURIComponent(symbol)}?indicator=signal&timeframe=${timeframe}&days=${days}`);
        if (sigRes.ok) setSignal(await sigRes.json());
      } catch { /* ignore */ }
    } catch (e) {
      setErr(String(e));
    }
  }, [symbol, timeframe, days, enabled, params, chartType, compareSymbol]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Fetch drawings ──
  useEffect(() => {
    api.listDrawings(symbol, timeframe)
      .then((r) => setDrawings(r.drawings))
      .catch(() => setDrawings([]));
  }, [symbol, timeframe]);

  // ── Fetch chart event markers ──
  useEffect(() => {
    if (!showMarkers) return;
    api.chartEvents(symbol, days)
      .then((r) => setMarkers(r.markers))
      .catch(() => setMarkers([]));
  }, [symbol, days, showMarkers]);

  // ── Visible sub-panes ──
  const subPanes = useMemo<Pane[]>(() => {
    const panes = new Set<Pane>(["sub_volume"]);
    for (const k of enabled) {
      const def = KEY_TO_DEF[k];
      if (def && def.pane !== "price") panes.add(def.pane);
    }
    return Array.from(panes);
  }, [enabled]);

  const subPaneCount = subPanes.length;
  const priceFrac = subPaneCount === 0 ? 1 : Math.max(0.45, 1 - subPaneCount * 0.10);

  // ── Drawing CRUD handlers ──
  const handleCreateDrawing = useCallback(async (
    drawingType: ExtendedDrawingType,
    points: { time: string; price: number }[],
  ) => {
    try {
      const d = await api.createDrawing({
        symbol, timeframe, drawing_type: drawingType, points,
        style: defaultStyleFor(drawingType),
      });
      setDrawings((prev) => [...prev, d]);
      setTool("cursor");
    } catch (e) {
      setErr(String(e));
    }
  }, [symbol, timeframe]);

  const handleUpdateDrawing = useCallback(async (
    id: number,
    patch: { style?: Record<string, unknown>; label?: string },
  ) => {
    try {
      const d = await api.updateDrawing(id, patch);
      setDrawings((prev) => prev.map((x) => (x.id === id ? d : x)));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const handleDeleteDrawing = useCallback(async (id: number) => {
    try {
      await api.deleteDrawing(id);
      setDrawings((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const handleEditDrawing = useCallback((d: Drawing) => {
    setEditingDrawing(d);
  }, []);

  // ── Hover indicator values (cursor info bar) ──
  const hoverValues = useMemo<{ label: string; value: string; color: string }[]>(() => {
    if (!hoverBar || !data) return [];
    const out: { label: string; value: string; color: string }[] = [];
    for (const k of enabled) {
      const def = KEY_TO_DEF[k];
      if (!def) continue;
      const raw = data.indicators[k] ?? data.indicators[def.backendName];
      if (!raw) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = raw as any;
      let val: string | null = null;
      if (Array.isArray(r.points)) {
        const found = r.points.find((p: { date: string }) => p.date === hoverBar.date);
        if (found) val = found.value.toFixed(2);
      } else if (r.line) {
        const found = r.line.find?.((p: { date: string }) => p.date === hoverBar.date);
        if (found) val = found.value.toFixed(3);
      } else if (r.upper && r.middle && r.lower) {
        const u = r.upper.find?.((p: { date: string }) => p.date === hoverBar.date);
        const m = r.middle.find?.((p: { date: string }) => p.date === hoverBar.date);
        const l = r.lower.find?.((p: { date: string }) => p.date === hoverBar.date);
        if (u && m && l) val = `${l.value.toFixed(2)} / ${m.value.toFixed(2)} / ${u.value.toFixed(2)}`;
      } else if (r.adx) {
        const a = r.adx.find?.((p: { date: string }) => p.date === hoverBar.date);
        if (a) val = a.value.toFixed(2);
      } else if (r.k_line) {
        const k_p = r.k_line.find?.((p: { date: string }) => p.date === hoverBar.date);
        if (k_p) val = k_p.value.toFixed(2);
      }
      if (val !== null) out.push({ label: def.label, value: val, color: def.color });
    }
    return out;
  }, [hoverBar, enabled, data]);

  // ── Crosshair sync between price + sub-panes ──
  useEffect(() => {
    if (!priceChartRef.current) return;
    const price = priceChartRef.current;
    const unsubs: (() => void)[] = [];

    // From price → sub-panes
    const unsubPrice = price.subscribeCrosshairMove((p) => {
      if (!p.time) return;
      for (const id of Object.keys(subChartRefs.current)) {
        const subChart = subChartRefs.current[id];
        const subSeries = subSeriesRefs.current[id];
        if (!subSeries) continue;
        try {
          subChart.setCrosshairPosition(NaN, p.time, subSeries);
        } catch { /* sub-pane may not have data yet */ }
      }
    });
    unsubs.push(() => unsubPrice);

    // From any sub-pane → price + other sub-panes
    for (const id of Object.keys(subChartRefs.current)) {
      const sub = subChartRefs.current[id];
      const off = sub.subscribeCrosshairMove((p) => {
        if (!p.time) return;
        const series = priceSeriesRef.current;
        if (series) {
          try { price.setCrosshairPosition(NaN, p.time, series); } catch { /* ignore */ }
        }
        for (const otherId of Object.keys(subChartRefs.current)) {
          if (otherId === id) continue;
          const o = subChartRefs.current[otherId];
          const oSeries = subSeriesRefs.current[otherId];
          if (oSeries) {
            try { o.setCrosshairPosition(NaN, p.time, oSeries); } catch { /* ignore */ }
          }
        }
      });
      unsubs.push(() => off);
    }

    return () => { unsubs.forEach((u) => u()); };
  }, [data, subPanes.join(",")]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <section className="panel h-full flex flex-col">
      <Toolbar
        symbol={symbol}
        symbolInput={symbolInput}
        compareInput={compareInput}
        compareSymbol={compareSymbol}
        onSymbolInputChange={setSymbolInput}
        onSymbolSubmit={(s) => setSymbol(s.toUpperCase())}
        onCompareInputChange={setCompareInput}
        onCompareSubmit={(s) => setCompareSymbol(s ? s.toUpperCase() : null)}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        chartType={chartType}
        onChartTypeChange={setChartType}
        scaleType={scaleType}
        onScaleTypeChange={setScaleType}
        days={days}
        onDaysChange={setDays}
        enabled={enabled}
        onToggleIndicator={(key) => {
          setEnabled((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          });
        }}
        params={params}
        onParamChange={(key, name, val) => {
          setParams((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [name]: val } }));
        }}
        signal={signal}
        tool={tool}
        onToolChange={setTool}
        showMarkers={showMarkers}
        onShowMarkersChange={setShowMarkers}
        snapToOhlc={snapToOhlc}
        onSnapToOhlcChange={setSnapToOhlc}
        drawingsLocked={drawingsLocked}
        onDrawingsLockedChange={setDrawingsLocked}
        showParamPanel={showParamPanel}
        onShowParamPanelChange={setShowParamPanel}
      />

      <div className="panel-body flex-1 relative flex flex-col">
        {err && <div className="text-rose-400 text-xs p-2">Error: {err}</div>}
        {!data && !err && <div className="text-terminal-dim text-xs p-2">Loading…</div>}

        {data && (
          <>
            {/* Price pane */}
            <div className="relative" style={{ flex: priceFrac, minHeight: 240 }}>
              <PriceChart
                bars={data.bars}
                haBars={haBars}
                compareBars={compareBars}
                indicators={data.indicators}
                supportResistance={sr}
                markers={showMarkers ? markers : []}
                enabled={enabled}
                params={params}
                chartType={chartType}
                scaleType={scaleType}
                onChartReady={(chart, series) => {
                  priceChartRef.current = chart;
                  priceSeriesRef.current = series;
                }}
                onHover={(b) => { setHoverBar(b); }}
              />
              {priceChartRef.current && priceSeriesRef.current && (
                <DrawingsLayer
                  chart={priceChartRef.current}
                  series={priceSeriesRef.current}
                  bars={data.bars}
                  drawings={drawings}
                  activeTool={drawingsLocked ? "cursor" : tool}
                  snapToOhlc={snapToOhlc}
                  onCreate={handleCreateDrawing}
                  onUpdate={handleUpdateDrawing}
                  onDelete={handleDeleteDrawing}
                  onEdit={handleEditDrawing}
                />
              )}
            </div>

            {/* Sub-panes */}
            {subPanes.map((pane) => (
              <SubPaneChart
                key={pane}
                pane={pane}
                bars={data.bars}
                indicators={data.indicators}
                heightFrac={(1 - priceFrac) / subPaneCount}
                onReady={(id, chart, series) => {
                  subChartRefs.current[id] = chart;
                  subSeriesRefs.current[id] = series;
                }}
              />
            ))}

            {/* Cursor info bar */}
            <CursorInfoBar
              hoverBar={hoverBar}
              hoverValues={hoverValues}
              compareSymbol={compareSymbol}
              compareBars={compareBars}
            />
          </>
        )}
      </div>

      {editingDrawing && (
        <DrawingPropertiesDialog
          drawing={editingDrawing}
          onClose={() => setEditingDrawing(null)}
          onSave={handleUpdateDrawing}
          onDelete={handleDeleteDrawing}
        />
      )}
    </section>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────────────────

interface ToolbarProps {
  symbol: string;
  symbolInput: string;
  compareInput: string;
  compareSymbol: string | null;
  onSymbolInputChange: (s: string) => void;
  onSymbolSubmit: (s: string) => void;
  onCompareInputChange: (s: string) => void;
  onCompareSubmit: (s: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (t: Timeframe) => void;
  chartType: ChartType;
  onChartTypeChange: (c: ChartType) => void;
  scaleType: "linear" | "log";
  onScaleTypeChange: (s: "linear" | "log") => void;
  days: number;
  onDaysChange: (d: number) => void;
  enabled: Set<string>;
  onToggleIndicator: (key: string) => void;
  params: Record<string, Record<string, number>>;
  onParamChange: (key: string, name: string, val: number) => void;
  signal: SignalStrengthResponse | null;
  tool: "cursor" | ExtendedDrawingType;
  onToolChange: (t: "cursor" | ExtendedDrawingType) => void;
  showMarkers: boolean;
  onShowMarkersChange: (b: boolean) => void;
  snapToOhlc: boolean;
  onSnapToOhlcChange: (b: boolean) => void;
  drawingsLocked: boolean;
  onDrawingsLockedChange: (b: boolean) => void;
  showParamPanel: boolean;
  onShowParamPanelChange: (b: boolean) => void;
}

function Toolbar(p: ToolbarProps) {
  return (
    <header className="panel-header flex flex-col gap-2">
      {/* Row 1: identity + signal */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-accent font-semibold">TECHNICAL ANALYSIS</span>
          <input
            value={p.symbolInput}
            onChange={(e) => p.onSymbolInputChange(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") p.onSymbolSubmit(p.symbolInput); }}
            className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-24 font-mono text-xs"
            placeholder="ticker"
          />
          <span className="text-terminal-dim text-xs font-mono">{p.symbol}</span>
          <SignalBadge signal={p.signal} />
          <span className="text-terminal-dim text-[10px] ml-2">vs</span>
          <input
            value={p.compareInput}
            onChange={(e) => p.onCompareInputChange(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") p.onCompareSubmit(p.compareInput); }}
            className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-20 font-mono text-xs"
            placeholder="compare"
          />
          {p.compareSymbol && (
            <span className="text-[10px] text-accent">{p.compareSymbol}</span>
          )}
        </div>
      </div>

      {/* Row 2: timeframe / chart type / scale / days / marker toggles */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => p.onTimeframeChange(tf)}
              className={`pill text-[10px] ${p.timeframe === tf ? "bg-accent text-black" : ""}`}
            >
              {TIMEFRAME_LABEL[tf]}
            </button>
          ))}
        </div>
        <span className="text-terminal-dim">·</span>
        <div className="flex items-center gap-1">
          {CHART_TYPES.map((c) => (
            <button
              key={c}
              onClick={() => p.onChartTypeChange(c)}
              className={`pill text-[10px] ${p.chartType === c ? "bg-accent text-black" : ""}`}
            >
              {c.replace("_", " ")}
            </button>
          ))}
        </div>
        <span className="text-terminal-dim">·</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => p.onScaleTypeChange("linear")}
            className={`pill text-[10px] ${p.scaleType === "linear" ? "bg-accent text-black" : ""}`}
          >lin</button>
          <button
            onClick={() => p.onScaleTypeChange("log")}
            className={`pill text-[10px] ${p.scaleType === "log" ? "bg-accent text-black" : ""}`}
          >log</button>
        </div>
        <span className="text-terminal-dim">·</span>
        <label className="flex items-center gap-1 text-terminal-dim">
          days
          <select
            value={p.days}
            onChange={(e) => p.onDaysChange(Number(e.target.value))}
            className="bg-terminal-panel border border-terminal-border rounded px-2 py-1"
          >
            <option value={90}>90</option>
            <option value={180}>180</option>
            <option value={365}>1Y</option>
            <option value={730}>2Y</option>
            <option value={1825}>5Y</option>
            <option value={3650}>10Y</option>
          </select>
        </label>
        <span className="text-terminal-dim">·</span>
        <label className="flex items-center gap-1 text-[10px] text-terminal-dim">
          <input type="checkbox" checked={p.showMarkers} onChange={(e) => p.onShowMarkersChange(e.target.checked)} />
          markers
        </label>
        <label className="flex items-center gap-1 text-[10px] text-terminal-dim">
          <input type="checkbox" checked={p.snapToOhlc} onChange={(e) => p.onSnapToOhlcChange(e.target.checked)} />
          snap-OHLC
        </label>
        <label className="flex items-center gap-1 text-[10px] text-terminal-dim">
          <input type="checkbox" checked={p.drawingsLocked} onChange={(e) => p.onDrawingsLockedChange(e.target.checked)} />
          lock drawings
        </label>
        <button
          onClick={() => p.onShowParamPanelChange(!p.showParamPanel)}
          className={`pill text-[10px] ${p.showParamPanel ? "bg-accent text-black" : ""}`}
        >
          ⚙ params
        </button>
      </div>

      {/* Row 3: drawing tools */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] text-terminal-dim uppercase">Draw:</span>
        {DRAWING_TOOLS.map((d) => (
          <button
            key={d.key}
            onClick={() => p.onToolChange(d.key)}
            title={d.label}
            className={`pill text-[10px] ${p.tool === d.key ? "bg-accent text-black" : ""}`}
          >
            <span className="font-mono">{d.icon}</span> {d.label}
          </button>
        ))}
      </div>

      {/* Row 4-5: indicator chips */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-terminal-dim uppercase w-14">Overlay:</span>
          {OVERLAY_INDICATORS.map((d) => (
            <button
              key={d.key}
              onClick={() => p.onToggleIndicator(d.key)}
              className={`pill text-[10px] ${p.enabled.has(d.key) ? "" : "opacity-40"}`}
              style={{ borderColor: p.enabled.has(d.key) ? d.color : undefined }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-terminal-dim uppercase w-14">Sub:</span>
          {SUB_INDICATORS.map((d) => (
            <button
              key={d.key}
              onClick={() => p.onToggleIndicator(d.key)}
              className={`pill text-[10px] ${p.enabled.has(d.key) ? "" : "opacity-40"}`}
              style={{ borderColor: p.enabled.has(d.key) ? d.color : undefined }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Params panel */}
      {p.showParamPanel && (
        <div className="border-t border-terminal-border pt-2 text-[10px]">
          <div className="text-terminal-dim uppercase mb-1">Indicator parameters</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Array.from(p.enabled).map((k) => {
              const def = KEY_TO_DEF[k];
              if (!def || !def.hasPeriod) return null;
              const cur = (p.params[k]?.period ?? def.defaultParams?.period) as number ?? 14;
              return (
                <div key={k} className="flex items-center gap-1">
                  <span className="text-terminal-dim w-20 truncate">{def.label}</span>
                  <input
                    type="range"
                    min={def.minPeriod ?? 5}
                    max={def.maxPeriod ?? 50}
                    value={Number(cur)}
                    onChange={(e) => p.onParamChange(k, "period", Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="font-mono w-8 text-right">{cur}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}

function SignalBadge({ signal }: { signal: SignalStrengthResponse | null }) {
  if (!signal || signal.score === null) return null;
  const colors: Record<string, string> = {
    strong_buy:  "bg-emerald-600 text-white",
    buy:         "bg-emerald-500/30 text-emerald-300",
    neutral:     "bg-terminal-border text-terminal-dim",
    sell:        "bg-rose-500/30 text-rose-300",
    strong_sell: "bg-rose-600 text-white",
  };
  const label: Record<string, string> = {
    strong_buy:  "STRONG BUY",
    buy:         "BUY",
    neutral:     "NEUTRAL",
    sell:        "SELL",
    strong_sell: "STRONG SELL",
  };
  return (
    <span
      title={`Score ${signal.score} · ${Object.entries(signal.votes).map(([k, v]) => `${k}:${v}`).join(", ")}`}
      className={`text-[10px] font-bold px-2 py-1 rounded ${colors[signal.bucket] ?? ""}`}
    >
      {label[signal.bucket] ?? signal.bucket}
    </span>
  );
}

// ─── Price chart ───────────────────────────────────────────────────────────

interface PriceChartProps {
  bars: OHLCVBar[];
  haBars: OHLCVBar[] | null;
  compareBars: OHLCVBar[] | null;
  indicators: Record<string, unknown>;
  supportResistance: SupportResistanceResponse | null;
  markers: ChartMarker[];
  enabled: Set<string>;
  params: Record<string, Record<string, number>>;
  chartType: ChartType;
  scaleType: "linear" | "log";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChartReady: (chart: IChartApi, series: ISeriesApi<any>) => void;
  onHover: (bar: OHLCVBar | null) => void;
}

function PriceChart(p: PriceChartProps) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid:   { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626", mode: p.scaleType === "log" ? 1 : 0 },
      timeScale:       { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      crosshair:       { mode: CrosshairMode.Normal },
      autoSize:        true,
    });

    // Main series.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mainSeries: ISeriesApi<any>;
    if (p.chartType === "candle" || p.chartType === "heikin_ashi") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: "#26a69a", downColor: "#ef5350",
        borderUpColor: "#26a69a", borderDownColor: "#ef5350",
        wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      });
      const sourceBars = p.chartType === "heikin_ashi" && p.haBars ? p.haBars : p.bars;
      s.setData(sourceBars.map((b) => ({ time: dateToTime(b.date), open: b.open, high: b.high, low: b.low, close: b.close })));
      mainSeries = s;
    } else if (p.chartType === "line") {
      const s = chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 2 });
      s.setData(p.bars.map((b) => ({ time: dateToTime(b.date), value: b.close })));
      mainSeries = s;
    } else {
      const s = chart.addSeries(AreaSeries, { lineColor: "#ffb800", topColor: "rgba(255,184,0,0.4)", bottomColor: "rgba(255,184,0,0.05)" });
      s.setData(p.bars.map((b) => ({ time: dateToTime(b.date), value: b.close })));
      mainSeries = s;
    }

    // Compare overlay (normalized to first bar).
    if (p.compareBars && p.compareBars.length > 0 && p.bars.length > 0) {
      const baseStart = p.bars[0].close;
      const cmpStart = p.compareBars[0].close;
      // Scale comparison series to start at the same price level as the main symbol.
      const ratio = baseStart / cmpStart;
      const s = chart.addSeries(LineSeries, {
        color: "#22d3ee", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      });
      s.setData(p.compareBars.map((b) => ({ time: dateToTime(b.date), value: b.close * ratio })));
    }

    // Overlay indicators.
    for (const def of OVERLAY_INDICATORS) {
      if (!p.enabled.has(def.key)) continue;
      if (def.key === "support_resistance") {
        if (p.supportResistance) renderSupportResistance(mainSeries, p.supportResistance);
        continue;
      }
      const raw = p.indicators[def.key] ?? p.indicators[def.backendName];
      if (!raw) continue;
      renderOverlay(chart, def, raw);
    }

    // Markers on the main series.
    if (p.markers.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mainSeries as any).setMarkers(p.markers.map((m) => ({
          time:     dateToTime(m.date),
          position: m.kind === "earnings" ? "aboveBar" : "belowBar",
          color:    m.color,
          shape:    m.kind === "filing" ? "circle" : (m.kind === "earnings" ? "arrowUp" : "square"),
          text:     m.kind === "filing" ? m.label : (m.kind === "earnings" ? "E" : m.label.slice(0, 6)),
        })));
      } catch { /* setMarkers may not be available on all series types */ }
    }

    chart.timeScale().fitContent();

    // Hover handler.
    const unsub = chart.subscribeCrosshairMove((ev) => {
      if (!ev.time) {
        p.onHover(null);
        return;
      }
      const t = Number(ev.time);
      const bar = p.bars.find((b) => dateToTime(b.date) === t) ?? null;
      p.onHover(bar);
    });

    p.onChartReady(chart, mainSeries);

    return () => { unsub; chart.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.bars, p.haBars, p.compareBars, p.chartType, p.scaleType, Array.from(p.enabled).join(","), JSON.stringify(p.params), p.indicators, p.supportResistance, p.markers]);

  return <div ref={elRef} className="absolute inset-0" />;
}

function renderOverlay(chart: IChartApi, def: IndicatorDef, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const opts = { color: def.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false } as const;

  if (def.backendName === "sma" || def.backendName === "ema" || def.backendName === "vwap" ||
      def.backendName === "vwma" || def.backendName === "hull_ma" || def.backendName === "kama" ||
      def.backendName === "parabolic_sar" || def.backendName === "supertrend") {
    const pts = (data.points as { date: string; value: number }[]) ?? [];
    chart.addSeries(LineSeries, opts).setData(pointsToLine(pts));
  } else if (def.key === "bollinger" || def.key === "donchian" || def.key === "keltner") {
    const upper  = (data.upper  as { date: string; value: number }[]) ?? [];
    const middle = (data.middle as { date: string; value: number }[]) ?? [];
    const lower  = (data.lower  as { date: string; value: number }[]) ?? [];
    chart.addSeries(LineSeries, opts).setData(pointsToLine(upper));
    chart.addSeries(LineSeries, opts).setData(pointsToLine(middle));
    chart.addSeries(LineSeries, opts).setData(pointsToLine(lower));
  } else if (def.key === "ichimoku") {
    const tenkan = (data.tenkan_sen    as { date: string; value: number }[]) ?? [];
    const kijun  = (data.kijun_sen     as { date: string; value: number }[]) ?? [];
    const sa     = (data.senkou_a      as { date: string; value: number }[]) ?? [];
    const sb     = (data.senkou_b_line as { date: string; value: number }[]) ?? [];
    chart.addSeries(LineSeries, { color: "#84cc16", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(pointsToLine(tenkan));
    chart.addSeries(LineSeries, { color: "#fb7185", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(pointsToLine(kijun));
    chart.addSeries(LineSeries, { color: "#26a69a", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(pointsToLine(sa));
    chart.addSeries(LineSeries, { color: "#ef5350", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(pointsToLine(sb));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSupportResistance(series: ISeriesApi<any>, sr: SupportResistanceResponse) {
  for (const level of sr.levels) {
    const isSupport = level.types.includes("support") && !level.types.includes("resistance");
    try {
      series.createPriceLine({
        price: level.price,
        color: isSupport ? "#26a69a" : "#ef5350",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `${isSupport ? "S" : "R"} · ${level.touches}x`,
      });
    } catch { /* ignore */ }
  }
}

// ─── Sub-pane chart ───────────────────────────────────────────────────────

interface SubPaneProps {
  pane: Pane;
  bars: OHLCVBar[];
  indicators: Record<string, unknown>;
  heightFrac: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onReady: (id: string, chart: IChartApi, series: ISeriesApi<any>) => void;
}

function SubPaneChart({ pane, bars, indicators, heightFrac, onReady }: SubPaneProps) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono, monospace", fontSize: 9 },
      grid:   { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale:       { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      crosshair:       { mode: CrosshairMode.Normal },
      autoSize:        true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let firstSeries: ISeriesApi<any> | null = null;

    if (pane === "sub_volume") {
      const s = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" } });
      s.setData(bars.map((b) => ({ time: dateToTime(b.date), value: b.volume, color: b.close >= b.open ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)" })));
      firstSeries = s;
    } else if (pane === "sub_rsi") {
      const r = indicators["rsi"] as { points: { date: string; value: number }[] } | undefined;
      if (r?.points) {
        const s = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: 70, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
        s.createPriceLine({ price: 30, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });
        firstSeries = s;
      }
      const div = indicators["divergence_rsi"] as { events: { type: string; from_date: string; to_date: string; indicator_to: number }[] } | undefined;
      if (div?.events && firstSeries) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (firstSeries as any).setMarkers(div.events.slice(0, 8).map((ev) => ({
            time:     dateToTime(ev.to_date),
            position: ev.type === "bullish" ? "belowBar" : "aboveBar",
            color:    ev.type === "bullish" ? "#26a69a" : "#ef5350",
            shape:    ev.type === "bullish" ? "arrowUp" : "arrowDown",
            text:     "div",
          })));
        } catch { /* ignore */ }
      }
    } else if (pane === "sub_macd") {
      const m = indicators["macd"] as { line: { date: string; value: number }[]; signal_line: { date: string; value: number }[]; histogram: { date: string; value: number }[] } | undefined;
      if (m) {
        const line = chart.addSeries(LineSeries, { color: "#26a69a", lineWidth: 1 });
        line.setData(pointsToLine(m.line));
        chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 1 }).setData(pointsToLine(m.signal_line));
        const hist = chart.addSeries(HistogramSeries, { color: "#5fb878" });
        hist.setData(m.histogram.map((p2) => ({
          time: dateToTime(p2.date), value: p2.value,
          color: p2.value >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
        })));
        firstSeries = line;
      }
    } else if (pane === "sub_stoch") {
      const s = indicators["stochastic"] as { k_line: { date: string; value: number }[]; d_line: { date: string; value: number }[] } | undefined;
      if (s) {
        const k = chart.addSeries(LineSeries, { color: "#5fb878", lineWidth: 1 });
        k.setData(pointsToLine(s.k_line));
        chart.addSeries(LineSeries, { color: "#fb7185", lineWidth: 1 }).setData(pointsToLine(s.d_line));
        k.createPriceLine({ price: 80, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "80" });
        k.createPriceLine({ price: 20, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "20" });
        firstSeries = k;
      }
    } else if (pane === "sub_adx") {
      const a = indicators["adx"] as { adx: { date: string; value: number }[]; plus_di: { date: string; value: number }[]; minus_di: { date: string; value: number }[] } | undefined;
      if (a) {
        const adxS = chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 1 });
        adxS.setData(pointsToLine(a.adx));
        chart.addSeries(LineSeries, { color: "#26a69a", lineWidth: 1 }).setData(pointsToLine(a.plus_di));
        chart.addSeries(LineSeries, { color: "#ef5350", lineWidth: 1 }).setData(pointsToLine(a.minus_di));
        adxS.createPriceLine({ price: 25, color: "#94a3b8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "25" });
        firstSeries = adxS;
      }
    } else if (pane === "sub_cci") {
      const r = indicators["cci"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#06b6d4", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: 100, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "100" });
        s.createPriceLine({ price: -100, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-100" });
        firstSeries = s;
      }
    } else if (pane === "sub_williams") {
      const r = indicators["williams_r"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#fb7185", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: -20, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-20" });
        s.createPriceLine({ price: -80, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-80" });
        firstSeries = s;
      }
    } else if (pane === "sub_mfi") {
      const r = indicators["mfi"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: 80, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "80" });
        s.createPriceLine({ price: 20, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "20" });
        firstSeries = s;
      }
    } else if (pane === "sub_roc") {
      const r = indicators["roc"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#facc15", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        firstSeries = s;
      }
    } else if (pane === "sub_atr") {
      const r = indicators["atr"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#fbbf24", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        firstSeries = s;
      }
    } else if (pane === "sub_obv") {
      const r = indicators["obv"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#84cc16", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        firstSeries = s;
      }
    } else if (pane === "sub_aroon") {
      const r = indicators["aroon"] as { up: { date: string; value: number }[]; down: { date: string; value: number }[] } | undefined;
      if (r) {
        const u = chart.addSeries(LineSeries, { color: "#5fb878", lineWidth: 1 });
        u.setData(pointsToLine(r.up));
        chart.addSeries(LineSeries, { color: "#fb7185", lineWidth: 1 }).setData(pointsToLine(r.down));
        firstSeries = u;
      }
    } else if (pane === "sub_vortex") {
      const r = indicators["vortex"] as { vi_plus: { date: string; value: number }[]; vi_minus: { date: string; value: number }[] } | undefined;
      if (r) {
        const p2 = chart.addSeries(LineSeries, { color: "#26a69a", lineWidth: 1 });
        p2.setData(pointsToLine(r.vi_plus));
        chart.addSeries(LineSeries, { color: "#ef5350", lineWidth: 1 }).setData(pointsToLine(r.vi_minus));
        firstSeries = p2;
      }
    } else if (pane === "sub_trix") {
      const r = indicators["trix"] as { line: { date: string; value: number }[]; signal_line: { date: string; value: number }[] } | undefined;
      if (r) {
        const l = chart.addSeries(LineSeries, { color: "#c084fc", lineWidth: 1 });
        l.setData(pointsToLine(r.line));
        chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 1 }).setData(pointsToLine(r.signal_line));
        firstSeries = l;
      }
    } else if (pane === "sub_ultimate") {
      const r = indicators["ultimate_oscillator"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#34d399", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: 70, color: "#ef5350", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
        s.createPriceLine({ price: 30, color: "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });
        firstSeries = s;
      }
    } else if (pane === "sub_awesome") {
      const r = indicators["awesome_oscillator"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const h = chart.addSeries(HistogramSeries, { color: "#fde047" });
        h.setData(r.points.map((p2) => ({
          time: dateToTime(p2.date), value: p2.value,
          color: p2.value >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
        })));
        firstSeries = h;
      }
    } else if (pane === "sub_cmf") {
      const r = indicators["cmf"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#60a5fa", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        s.createPriceLine({ price: 0, color: "#94a3b8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "0" });
        firstSeries = s;
      }
    } else if (pane === "sub_chaikin") {
      const r = indicators["chaikin_oscillator"] as { points: { date: string; value: number }[] } | undefined;
      if (r) {
        const s = chart.addSeries(LineSeries, { color: "#fb923c", lineWidth: 1 });
        s.setData(pointsToLine(r.points));
        firstSeries = s;
      }
    }

    chart.timeScale().fitContent();
    if (firstSeries) onReady(pane, chart, firstSeries);

    return () => { chart.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, bars, indicators]);

  return (
    <div className="relative border-t border-terminal-border" style={{ flex: heightFrac, minHeight: 70 }}>
      <div ref={elRef} className="absolute inset-0" />
      <div className="absolute top-1 left-2 text-[9px] text-terminal-dim uppercase tracking-wide pointer-events-none">
        {pane.replace("sub_", "").replace("_", " ")}
      </div>
    </div>
  );
}

// ─── Cursor info bar ──────────────────────────────────────────────────────

function CursorInfoBar({
  hoverBar,
  hoverValues,
  compareSymbol,
  compareBars,
}: {
  hoverBar: OHLCVBar | null;
  hoverValues: { label: string; value: string; color: string }[];
  compareSymbol: string | null;
  compareBars: OHLCVBar[] | null;
}) {
  if (!hoverBar) {
    return (
      <div className="border-t border-terminal-border px-2 py-1 text-[10px] text-terminal-dim flex items-center justify-end">
        Hover the chart for OHLCV + indicator values
      </div>
    );
  }
  const cmp = compareSymbol && compareBars ? compareBars.find((b) => b.date === hoverBar.date) : null;
  return (
    <div className="border-t border-terminal-border px-2 py-1 text-[10px] font-mono flex items-center gap-3 flex-wrap">
      <span className="text-terminal-dim">{hoverBar.date}</span>
      <span>O <span className="text-foreground">{hoverBar.open.toFixed(2)}</span></span>
      <span>H <span className="text-foreground">{hoverBar.high.toFixed(2)}</span></span>
      <span>L <span className="text-foreground">{hoverBar.low.toFixed(2)}</span></span>
      <span>C <span className="text-foreground">{hoverBar.close.toFixed(2)}</span></span>
      <span>V <span className="text-foreground">{hoverBar.volume.toLocaleString()}</span></span>
      {cmp && (
        <span style={{ color: "#22d3ee" }}>
          {compareSymbol} {cmp.close.toFixed(2)}
        </span>
      )}
      <span className="text-terminal-dim">·</span>
      {hoverValues.map((v) => (
        <span key={v.label} style={{ color: v.color }}>
          {v.label} {v.value}
        </span>
      ))}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function pointsToLine(pts: { date: string; value: number }[]): LineData<Time>[] {
  return pts.map((p) => ({ time: dateToTime(p.date), value: p.value }));
}

function dateToTime(d: string): UTCTimestamp {
  return (Date.parse(d + "T00:00:00Z") / 1000) as UTCTimestamp;
}

function defaultStyleFor(type: ExtendedDrawingType): Record<string, unknown> {
  const base = { color: "#ffb800", line_width: 1, line_style: "solid" };
  if (type === "rectangle") return { ...base, fill: "rgba(255,184,0,0.1)", opacity: 0.6 };
  if (type === "fib_retracement" || type === "fib_extension" || type === "fib_time_zones") return { ...base, color: "#8b5cf6" };
  if (type === "parallel_channel") return { ...base, color: "#22d3ee", fill: "rgba(34,211,238,0.06)" };
  if (type === "risk_reward") return { ...base, color: "#5fb878" };
  if (type === "arrow") return { ...base, color: "#ffb800", line_width: 2 };
  if (type === "anchored_vwap_anchor") return { ...base, color: "#a78bfa", line_width: 2 };
  return base;
}
