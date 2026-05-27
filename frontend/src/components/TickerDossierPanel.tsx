import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { api } from "../api/client";
import type { DossierResponse, DossierPrice } from "../api/types";

/**
 * Single-ticker dossier — fuses price + fundamentals + news + filings +
 * options + technicals for ONE symbol into one panel.
 *
 * `symbol` is lifted into TerminalShell so the command palette can drive it.
 * When null, shows a hint. Loading / error / empty states mirror ScreenerPanel.
 */
export function TickerDossierPanel({ symbol }: { symbol: string | null }) {
  const [data, setData] = useState<DossierResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setData(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setErr(null);
    setData(null);
    api
      .tickerDossier(symbol)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-accent-amber font-semibold">TICKER DOSSIER</span>
          {symbol && <span className="font-mono text-accent">{symbol}</span>}
        </div>
        {busy && <span className="text-xs text-terminal-dim">Loading…</span>}
      </header>

      <div className="panel-body flex-1 overflow-auto p-3 space-y-4 text-xs">
        {!symbol && (
          <p className="text-terminal-dim italic">
            Press Cmd-K (or Ctrl-K) to search, then pick a symbol to load its dossier.
          </p>
        )}
        {err && <div className="text-accent-red">Error: {err}</div>}

        {symbol && !busy && !err && data && (
          <>
            <ProfileSection data={data} />
            <PriceSection price={data.price} />
            <FundamentalsSection data={data} />
            <TechnicalsSection data={data} />
            <OptionsSection data={data} />
            <NewsSection data={data} />
            <FilingsSection data={data} />
          </>
        )}
      </div>
    </section>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────
function ProfileSection({ data }: { data: DossierResponse }) {
  const p = data.profile;
  if (!p) return <SectionShell title="Profile">No profile data available.</SectionShell>;
  return (
    <SectionShell title="Profile">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-semibold text-terminal-fg">{p.name}</span>
        {p.sector && <Tag>{p.sector}</Tag>}
        {p.industry && <span className="text-terminal-dim">{p.industry}</span>}
        {p.exchange && <span className="text-terminal-dim">{p.exchange}</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 mt-2">
        <Stat label="Price" value={fmtNum(p.current_price, 2)} />
        <Stat
          label="Day change"
          value={p.day_change_pct == null ? "—" : fmtSignedPct(p.day_change_pct)}
          color={plColor(p.day_change_pct)}
        />
        <Stat label="Market cap" value={fmtBigNum(p.market_cap)} />
        <Stat label="P/E (ttm)" value={fmtNum(p.pe_ratio, 2)} />
        <Stat label="Fwd P/E" value={fmtNum(p.forward_pe, 2)} />
        <Stat label="Beta" value={fmtNum(p.beta, 2)} />
        <Stat
          label="Dividend yield"
          value={p.dividend_yield == null ? "—" : `${p.dividend_yield.toFixed(2)}%`}
        />
        <Stat label="Currency" value={p.currency ?? "—"} />
      </div>
      {p.summary && (
        <p className="text-terminal-dim mt-2 leading-relaxed line-clamp-4">{p.summary}</p>
      )}
    </SectionShell>
  );
}

// ── Price + chart ──────────────────────────────────────────────────────────
function PriceSection({ price }: { price: DossierPrice | null }) {
  if (!price) return <SectionShell title="Price">No price history available.</SectionShell>;
  return (
    <SectionShell title="Price (1Y)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 mb-2">
        <Stat label="Last" value={fmtNum(price.last, 2)} />
        <Stat
          label="Change"
          value={fmtSignedPct(price.change_pct)}
          color={plColor(price.change_pct)}
        />
        <Stat label="52w high" value={fmtNum(price.high_52w, 2)} />
        <Stat label="52w low" value={fmtNum(price.low_52w, 2)} />
        <Stat
          label="From high"
          value={price.pct_from_high == null ? "—" : fmtSignedPct(price.pct_from_high)}
          color={plColor(price.pct_from_high)}
        />
        <Stat
          label="From low"
          value={price.pct_from_low == null ? "—" : fmtSignedPct(price.pct_from_low)}
          color={plColor(price.pct_from_low)}
        />
        <Stat label="365d avg" value={fmtNum(price.avg_365d, 2)} />
      </div>
      <PriceChart price={price} />
    </SectionShell>
  );
}

function PriceChart({ price }: { price: DossierPrice }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8b8b8b",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1a1a1a" },
        horzLines: { color: "#1a1a1a" },
      },
      rightPriceScale: { borderColor: "#262626" },
      timeScale: { borderColor: "#262626", timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    const series = chart.addSeries(LineSeries, {
      color: "#ffb800",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const chartData = price.points
      .filter((p) => p.value != null)
      .map((p) => ({
        time: (Date.parse(p.date) / 1000) as UTCTimestamp,
        value: p.value as number,
      }));
    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [price]);

  return <div ref={elRef} style={{ height: 160 }} />;
}

// ── Fundamentals ─────────────────────────────────────────────────────────────
const FUND_FIELDS: { key: string; label: string; pct?: boolean }[] = [
  { key: "pe_ttm", label: "P/E (ttm)" },
  { key: "forward_pe", label: "Fwd P/E" },
  { key: "ps_ttm", label: "P/S (ttm)" },
  { key: "pb", label: "P/B" },
  { key: "ev_ebitda", label: "EV/EBITDA" },
  { key: "revenue_growth_yoy", label: "Rev growth YoY", pct: true },
  { key: "earnings_growth_yoy", label: "EPS growth YoY", pct: true },
  { key: "gross_margin", label: "Gross margin", pct: true },
  { key: "operating_margin", label: "Operating margin", pct: true },
  { key: "net_margin", label: "Net margin", pct: true },
  { key: "fcf_yield", label: "FCF yield", pct: true },
  { key: "return_on_equity", label: "ROE", pct: true },
  { key: "return_on_assets", label: "ROA", pct: true },
  { key: "debt_to_equity", label: "Debt/Equity" },
  { key: "eps_ttm", label: "EPS (ttm)" },
  { key: "peg_ratio", label: "PEG" },
];

function FundamentalsSection({ data }: { data: DossierResponse }) {
  const f = data.fundamentals;
  if (!f) return <SectionShell title="Fundamentals">No fundamentals available.</SectionShell>;
  return (
    <SectionShell title="Fundamentals">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
        {FUND_FIELDS.map((field) => {
          const raw = f[field.key];
          const v = typeof raw === "number" ? raw : null;
          return (
            <Stat
              key={field.key}
              label={field.label}
              value={v == null ? "—" : field.pct ? `${v.toFixed(2)}%` : fmtNum(v, 2)}
              color={field.pct ? plColor(v) : undefined}
            />
          );
        })}
      </div>
    </SectionShell>
  );
}

// ── Technicals ───────────────────────────────────────────────────────────────
function TechnicalsSection({ data }: { data: DossierResponse }) {
  const t = data.technicals;
  if (!t) return <SectionShell title="Technicals">No technical signal available.</SectionShell>;
  const bucketColor =
    t.bucket.includes("buy") ? "text-accent-green"
      : t.bucket.includes("sell") ? "text-accent-red"
      : "text-terminal-dim";
  return (
    <SectionShell title="Technicals">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className={`text-sm font-semibold uppercase ${bucketColor}`}>
          {t.bucket.replace(/_/g, " ")}
        </span>
        <Stat label="Score" value={t.score == null ? "—" : t.score.toFixed(2)} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 mt-2">
        {Object.entries(t.votes).map(([k, v]) => (
          <Stat
            key={k}
            label={k.replace(/_/g, " ")}
            value={v > 0 ? "buy" : v < 0 ? "sell" : "neutral"}
            color={v > 0 ? "text-accent-green" : v < 0 ? "text-accent-red" : undefined}
          />
        ))}
      </div>
    </SectionShell>
  );
}

// ── Options ──────────────────────────────────────────────────────────────────
function OptionsSection({ data }: { data: DossierResponse }) {
  const o = data.options;
  if (!o || o.error) {
    return (
      <SectionShell title="Options">
        {o?.error ?? "No options data available."}
      </SectionShell>
    );
  }
  return (
    <SectionShell title="Options (near-dated)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
        <Stat label="Expiry" value={o.expiry ?? "—"} />
        <Stat label="Days to expiry" value={o.days_to_expiry == null ? "—" : String(o.days_to_expiry)} />
        <Stat label="ATM strike" value={fmtNum(o.atm_strike, 2)} />
        <Stat label="Call IV" value={o.iv_calls == null ? "—" : `${(o.iv_calls * 100).toFixed(1)}%`} />
        <Stat label="Put IV" value={o.iv_puts == null ? "—" : `${(o.iv_puts * 100).toFixed(1)}%`} />
        <Stat label="P/C (OI)" value={fmtNum(o.pc_ratio_oi, 2)} />
        <Stat label="P/C (vol)" value={fmtNum(o.pc_ratio_vol, 2)} />
        <Stat label="±1σ move" value={fmtNum(o.implied_move_1sigma, 2)} />
      </div>
    </SectionShell>
  );
}

// ── News ─────────────────────────────────────────────────────────────────────
function NewsSection({ data }: { data: DossierResponse }) {
  if (!data.news.length) return <SectionShell title="News">No recent news.</SectionShell>;
  return (
    <SectionShell title="News">
      <ul className="space-y-1.5">
        {data.news.map((n) => (
          <li key={n.url} className="leading-snug">
            <a
              href={n.url}
              target="_blank"
              rel="noreferrer"
              className="text-terminal-fg hover:text-accent"
            >
              {n.title}
            </a>
            <span className="text-terminal-dim ml-2 text-2xs">
              {n.publisher}
              {n.published ? ` · ${n.published.slice(0, 10)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

// ── Filings ──────────────────────────────────────────────────────────────────
function FilingsSection({ data }: { data: DossierResponse }) {
  if (!data.filings.length)
    return <SectionShell title="SEC Filings">No recent filings (or non-US issuer).</SectionShell>;
  return (
    <SectionShell title="SEC Filings (90d)">
      <table className="w-full">
        <thead className="text-terminal-dim uppercase tracking-wide text-2xs">
          <tr>
            <th className="text-left py-1 pr-2">Date</th>
            <th className="text-left py-1 pr-2">Form</th>
            <th className="text-left py-1 pr-2">Description</th>
          </tr>
        </thead>
        <tbody>
          {data.filings.map((f) => (
            <tr key={f.accession} className="border-b border-terminal-border/50">
              <td className="py-1 pr-2 tabular-nums">{f.filing_date}</td>
              <td className="py-1 pr-2 font-mono text-accent-amber">{f.form}</td>
              <td className="py-1 pr-2">
                <a href={f.url} target="_blank" rel="noreferrer" className="hover:text-accent">
                  {f.form_label || f.description || f.accession}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionShell>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-accent-amber uppercase tracking-wider text-2xs mb-1.5 border-b border-terminal-border pb-1">
        {title}
      </h3>
      <div className="text-terminal-fg">{children}</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-terminal-dim text-2xs uppercase tracking-wide">{label}</span>
      <span className={`tabular-nums ${color ?? "text-terminal-fg"}`}>{value}</span>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="pill text-2xs">{children}</span>;
}

function plColor(v: number | null | undefined): string | undefined {
  if (v == null) return undefined;
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtNum(v: number | null | undefined, decimals = 0): string {
  if (v == null) return "—";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtSignedPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtBigNum(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
