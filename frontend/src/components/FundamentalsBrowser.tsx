import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { FundamentalsQuarter, FundamentalsResponse, InstrumentSearchResult } from "../api/types";

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "GOOGL", "TSLA"];

/**
 * Panel 6 — Fundamentals Browser.
 *
 * Pull quarterly statements from DuckDB. Two trend charts (revenue + EPS),
 * a margins panel, and a quarter-by-quarter grid. If no data is in the DB
 * yet for a ticker, surface a one-click "ingest now" action.
 */
export function FundamentalsBrowser() {
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [query, setQuery] = useState<string>("");
  const [suggestions, setSuggestions] = useState<InstrumentSearchResult[]>([]);
  const [data, setData] = useState<FundamentalsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState<boolean>(false);

  const load = async (sym: string) => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.dbFundamentals(sym);
      setData(d);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(symbol); }, [symbol]);

  useEffect(() => {
    if (!query.trim()) { setSuggestions([]); return; }
    let alive = true;
    api.searchInstruments(query, 8).then((r) => alive && setSuggestions(r.results))
       .catch(() => {});
    return () => { alive = false; };
  }, [query]);

  const ingestNow = async () => {
    setIngesting(true);
    try {
      await api.ingestFundamentals([symbol]);
      await load(symbol);
    } catch (e) { setErr(String(e)); }
    finally   { setIngesting(false); }
  };

  return (
    <div className="grid grid-cols-4 gap-2 h-full">
      <div className="col-span-1">
        <TickerSidebar
          symbol={symbol}
          setSymbol={(s) => { setSymbol(s); setQuery(""); setSuggestions([]); }}
          query={query}
          setQuery={setQuery}
          suggestions={suggestions}
        />
      </div>

      <div className="col-span-3 grid grid-cols-2 grid-rows-2 gap-2">
        <FundChart
          title={`${symbol} · Revenue (quarterly)`}
          quarters={data?.quarters ?? []}
          field="revenue"
          unit="$B"
          divisor={1e9}
          color="#ffb800"
        />
        <FundChart
          title={`${symbol} · Diluted EPS`}
          quarters={data?.quarters ?? []}
          field="eps_diluted"
          unit="$"
          divisor={1}
          color="#22c55e"
        />
        <MarginsCard quarters={data?.quarters ?? []} />
        <QuarterlyGrid
          quarters={data?.quarters ?? []}
          loading={loading}
          err={err}
          symbol={symbol}
          ingesting={ingesting}
          onIngest={ingestNow}
        />
      </div>
    </div>
  );
}

function TickerSidebar({
  symbol,
  setSymbol,
  query,
  setQuery,
  suggestions,
}: {
  symbol: string;
  setSymbol: (s: string) => void;
  query: string;
  setQuery: (q: string) => void;
  suggestions: InstrumentSearchResult[];
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Fundamentals Browser</span>
        <span className="normal-case tracking-normal text-accent-amber">{symbol}</span>
      </div>
      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider">
          <label className="text-2xs uppercase tracking-wider text-terminal-muted">search</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ticker or company name"
            spellCheck={false}
            className="mt-1 w-full bg-black/40 border border-terminal-divider
                       text-terminal-text font-mono text-xs p-2 outline-none
                       focus:border-accent-amber/60"
          />
          {suggestions.length > 0 && (
            <ul className="mt-2 divide-y divide-terminal-divider border border-terminal-divider max-h-48 overflow-auto">
              {suggestions.map((s) => (
                <li key={s.symbol}>
                  <button
                    onClick={() => setSymbol(s.symbol)}
                    className="w-full text-left px-2 py-1 hover:bg-white/5 text-xs"
                  >
                    <span className="text-accent-amber font-semibold">{s.symbol}</span>
                    <span className="text-terminal-muted ml-2">{s.name}</span>
                    <span className="text-terminal-dim ml-2 text-2xs">{s.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-3 py-2">
          <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">quick picks</div>
          <div className="flex flex-wrap gap-1">
            {DEFAULT_SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={
                  "px-2 py-0.5 border text-2xs transition " +
                  (s === symbol
                    ? "border-accent-amber/60 text-accent-amber"
                    : "border-terminal-divider text-terminal-muted hover:border-terminal-muted hover:text-terminal-text")
                }
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="px-3 py-2 text-2xs text-terminal-dim leading-relaxed">
          Data reads from DuckDB. If a ticker shows "no data", click "ingest now"
          on the quarterly grid to pull fresh statements via yfinance.
        </div>
      </div>
    </div>
  );
}

function FundChart({
  title, quarters, field, unit, divisor, color,
}: {
  title: string;
  quarters: FundamentalsQuarter[];
  field: keyof FundamentalsQuarter;
  unit: string;
  divisor: number;
  color: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout:    { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid:      { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      autoSize:  true,
    });
    const series = chart.addSeries(LineSeries, {
      color, lineWidth: 2, pointMarkersVisible: true,
      priceLineVisible: false, lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [color]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = quarters
      .map((q) => ({ t: Date.parse(q.period_end) / 1000, v: q[field] as number | null }))
      .filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v))
      .map((p) => ({ time: p.t as UTCTimestamp, value: (p.v as number) / divisor }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [quarters, field, divisor]);

  const latest = [...quarters].reverse().find((q) => q[field] !== null && q[field] !== undefined);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>{title}</span>
        <span className="normal-case tracking-normal text-terminal-text">
          {latest && latest[field] !== null && latest[field] !== undefined
            ? `${((latest[field] as number) / divisor).toFixed(2)} ${unit}`
            : "—"}
        </span>
      </div>
      <div ref={elRef} className="flex-1 min-h-0" />
    </div>
  );
}

function MarginsCard({ quarters }: { quarters: FundamentalsQuarter[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const gmRef = useRef<ISeriesApi<"Line"> | null>(null);
  const omRef = useRef<ISeriesApi<"Line"> | null>(null);
  const nmRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout:    { background: { color: "transparent" }, textColor: "#8b8b8b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid:      { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false },
      autoSize:  true,
    });
    gmRef.current = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 2, lastValueVisible: true });
    omRef.current = chart.addSeries(LineSeries, { color: "#ffb800", lineWidth: 2, lastValueVisible: true });
    nmRef.current = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, lastValueVisible: true });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; gmRef.current = omRef.current = nmRef.current = null; };
  }, []);

  useEffect(() => {
    const series: [ISeriesApi<"Line"> | null, keyof FundamentalsQuarter][] = [
      [gmRef.current, "gross_margin"],
      [omRef.current, "operating_margin"],
      [nmRef.current, "net_margin"],
    ];
    series.forEach(([s, field]) => {
      if (!s) return;
      const data = quarters
        .map((q) => ({ t: Date.parse(q.period_end) / 1000, v: q[field] as number | null }))
        .filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v))
        .map((p) => ({ time: p.t as UTCTimestamp, value: (p.v as number) * 100 }));
      s.setData(data);
    });
    chartRef.current?.timeScale().fitContent();
  }, [quarters]);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Margins (%)</span>
        <span className="flex items-center gap-2 normal-case tracking-normal text-terminal-muted">
          <Swatch color="#22c55e" label="gross" />
          <Swatch color="#ffb800" label="op" />
          <Swatch color="#3b82f6" label="net" />
        </span>
      </div>
      <div ref={elRef} className="flex-1 min-h-0" />
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2 h-2" style={{ background: color }} />
      {label}
    </span>
  );
}

function QuarterlyGrid({
  quarters, loading, err, symbol, ingesting, onIngest,
}: {
  quarters: FundamentalsQuarter[];
  loading: boolean;
  err: string | null;
  symbol: string;
  ingesting: boolean;
  onIngest: () => void;
}) {
  const reversed = useMemo(() => [...quarters].reverse(), [quarters]);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Quarterly statements</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {quarters.length} quarters
        </span>
      </div>
      <div className="panel-body p-0 overflow-auto">
        {err && <div className="p-3 text-accent-red text-xs">⚠ {err}</div>}
        {!err && loading && quarters.length === 0 && (
          <div className="p-3 text-terminal-dim text-xs">Loading…</div>
        )}
        {!err && !loading && quarters.length === 0 && (
          <div className="p-3 text-xs text-terminal-muted leading-relaxed">
            No quarterly data in DuckDB for <span className="text-accent-amber">{symbol}</span>.
            <div className="mt-2">
              <button
                onClick={onIngest}
                disabled={ingesting}
                className={
                  "px-2 py-1 border text-2xs uppercase tracking-wider transition " +
                  (ingesting
                    ? "border-accent-amber/40 text-accent-amber opacity-60 cursor-wait"
                    : "border-accent-amber/60 text-accent-amber hover:bg-accent-amber/10")
                }
              >
                {ingesting ? "ingesting…" : "ingest now"}
              </button>
            </div>
          </div>
        )}
        {quarters.length > 0 && (
          <table className="w-full text-xs tabular-nums">
            <thead className="text-terminal-muted text-2xs uppercase tracking-wider sticky top-0 bg-terminal-panel">
              <tr className="border-b border-terminal-divider">
                <th className="text-left py-1.5 pl-3 pr-2">Period</th>
                <th className="text-right pr-2">Revenue</th>
                <th className="text-right pr-2">Net Income</th>
                <th className="text-right pr-2">Gross M.</th>
                <th className="text-right pr-2">Op M.</th>
                <th className="text-right pr-2">EPS</th>
                <th className="text-right pr-3">FCF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-divider">
              {reversed.map((q) => (
                <tr key={q.period_end} className="hover:bg-white/[0.02]">
                  <td className="py-1.5 pl-3 pr-2 text-terminal-muted">{q.period_label}</td>
                  <td className="pr-2 text-right text-terminal-text">{fmtMoney(q.revenue, 1e9, "B")}</td>
                  <td className="pr-2 text-right text-terminal-text">{fmtMoney(q.net_income, 1e9, "B")}</td>
                  <td className="pr-2 text-right text-accent-green">{fmtPct(q.gross_margin)}</td>
                  <td className="pr-2 text-right text-accent-amber">{fmtPct(q.operating_margin)}</td>
                  <td className="pr-2 text-right text-terminal-text">{q.eps_diluted !== null ? `$${q.eps_diluted!.toFixed(2)}` : "—"}</td>
                  <td className="pr-3 text-right text-terminal-text">{fmtMoney(q.free_cash_flow, 1e9, "B")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function fmtMoney(v: number | null, divisor: number, unit: string): string {
  if (v === null || v === undefined) return "—";
  const x = v / divisor;
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(2)}${unit}`;
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return (v * 100).toFixed(1) + "%";
}
