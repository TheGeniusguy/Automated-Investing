import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { Filing, FilingsDefaults, FilingsResponse, FormMeta } from "../api/types";

const WINDOWS = [
  { label: "7d",  days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

/**
 * Panel 4 — SEC EDGAR Filings Tape.
 *
 * Pulls recent filings for an equities watchlist (default: large-cap 15),
 * sorts chronologically, filters by form type. Click any row to open the
 * actual filing on sec.gov.
 */
export function FilingsPanel() {
  const [defaults, setDefaults] = useState<FilingsDefaults | null>(null);
  const [tickersRaw, setTickersRaw] = useState<string>("");
  const [windowDays, setWindowDays] = useState<number>(30);
  const [activeForms, setActiveForms] = useState<Set<string>>(new Set());
  const [data, setData] = useState<FilingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial defaults
  useEffect(() => {
    api.filingsDefaults().then((d) => {
      setDefaults(d);
      setTickersRaw(d.default_tickers.join(", "));
    }).catch((e) => setErr(String(e)));
  }, []);

  const tickers = useMemo(
    () => tickersRaw.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean),
    [tickersRaw],
  );

  // Fetch whenever the dependencies change
  useEffect(() => {
    if (!defaults || tickers.length === 0) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api.filings(tickers, windowDays, Array.from(activeForms))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [defaults, tickersRaw, windowDays, activeForms]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleForm = (form: string) => {
    setActiveForms((prev) => {
      const next = new Set(prev);
      next.has(form) ? next.delete(form) : next.add(form);
      return next;
    });
  };

  return (
    <div className="grid grid-cols-4 gap-2 h-full">
      <div className="col-span-1">
        <TickerInputCard
          raw={tickersRaw}
          onChange={setTickersRaw}
          windowDays={windowDays}
          setWindowDays={setWindowDays}
          resolved={data?.resolved ?? []}
          unresolved={data?.unresolved ?? []}
        />
      </div>
      <div className="col-span-3">
        <div className="panel h-full">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <span>SEC Filings Tape</span>
              <span className="normal-case tracking-normal text-terminal-dim">
                {data ? `${data.filings.length} filings` : "—"}
              </span>
            </div>
            <span className="normal-case tracking-normal text-terminal-dim">
              {loading ? "fetching…" : data?.fetched_at?.replace("T", " ").replace("Z", " UTC")}
            </span>
          </div>
          <FormFilters
            formMeta={defaults?.form_meta ?? {}}
            active={activeForms}
            toggle={toggleForm}
          />
          <div className="flex-1 overflow-auto">
            {err ? (
              <div className="p-3 text-accent-red text-xs">⚠ {err}</div>
            ) : !data ? (
              <div className="p-3 text-terminal-dim text-xs">Loading filings…</div>
            ) : data.filings.length === 0 ? (
              <div className="p-3 text-terminal-dim text-xs">
                No filings match the current filters. Widen the time window or remove form-type filters.
              </div>
            ) : (
              <FilingsTable filings={data.filings} formMeta={data.form_meta} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TickerInputCard({
  raw,
  onChange,
  windowDays,
  setWindowDays,
  resolved,
  unresolved,
}: {
  raw: string;
  onChange: (v: string) => void;
  windowDays: number;
  setWindowDays: (n: number) => void;
  resolved: string[];
  unresolved: string[];
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>Equities Watchlist</span></div>
      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider">
          <label className="text-2xs uppercase tracking-wider text-terminal-muted">tickers</label>
          <textarea
            value={raw}
            onChange={(e) => onChange(e.target.value)}
            rows={5}
            spellCheck={false}
            className="mt-1 w-full bg-black/40 border border-terminal-divider
                       text-terminal-text font-mono text-xs p-2 outline-none
                       focus:border-accent-amber/60 resize-none"
            placeholder="AAPL, MSFT, NVDA"
          />
        </div>

        <div className="px-3 py-2 border-b border-terminal-divider">
          <label className="text-2xs uppercase tracking-wider text-terminal-muted">window</label>
          <div className="mt-1 flex gap-1.5">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setWindowDays(w.days)}
                className={
                  "px-2 py-0.5 border text-2xs transition " +
                  (w.days === windowDays
                    ? "border-accent-amber/60 text-accent-amber"
                    : "border-terminal-divider text-terminal-muted hover:border-terminal-muted hover:text-terminal-text")
                }
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-3 py-2 text-2xs space-y-1">
          {resolved.length > 0 && (
            <div className="text-accent-green">
              <span className="text-terminal-muted uppercase tracking-wider">resolved </span>
              {resolved.length}
            </div>
          )}
          {unresolved.length > 0 && (
            <div className="text-accent-red">
              <span className="text-terminal-muted uppercase tracking-wider">unresolved </span>
              {unresolved.join(", ")}
            </div>
          )}
          <div className="text-terminal-dim leading-relaxed mt-2">
            EDGAR filings are pulled live from sec.gov. Non-US issuers, ETFs, and
            futures don't have CIKs and are silently skipped.
          </div>
        </div>
      </div>
    </div>
  );
}

const COLOR_CLASS: Record<string, string> = {
  amber: "bg-accent-amber/15 text-accent-amber border-accent-amber/40",
  blue:  "bg-accent-blue/15 text-accent-blue border-accent-blue/40",
  green: "bg-accent-green/15 text-accent-green border-accent-green/40",
  red:   "bg-accent-red/15 text-accent-red border-accent-red/40",
  muted: "bg-terminal-divider text-terminal-muted border-terminal-divider",
};

function FormFilters({
  formMeta,
  active,
  toggle,
}: {
  formMeta: Record<string, FormMeta>;
  active: Set<string>;
  toggle: (form: string) => void;
}) {
  const forms = Object.keys(formMeta);
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-terminal-divider text-2xs">
      <span className="text-terminal-muted uppercase tracking-wider mr-1 self-center">forms</span>
      {forms.map((f) => {
        const meta = formMeta[f];
        const cls = COLOR_CLASS[meta.color] ?? COLOR_CLASS.muted;
        const isActive = active.has(f);
        return (
          <button
            key={f}
            onClick={() => toggle(f)}
            title={meta.label}
            className={
              "pill border transition " +
              (isActive
                ? `${cls}`
                : "bg-transparent border-terminal-divider text-terminal-dim hover:text-terminal-text")
            }
          >
            {f}
          </button>
        );
      })}
      {active.size > 0 && (
        <span className="text-terminal-dim self-center normal-case ml-auto">
          {active.size} filter{active.size === 1 ? "" : "s"} active · click again to clear
        </span>
      )}
    </div>
  );
}

function FilingsTable({
  filings,
  formMeta,
}: {
  filings: Filing[];
  formMeta: Record<string, FormMeta>;
}) {
  return (
    <table className="w-full text-xs">
      <thead className="text-terminal-muted text-2xs uppercase tracking-wider sticky top-0 bg-terminal-panel">
        <tr className="border-b border-terminal-divider">
          <th className="text-left py-1.5 pl-3 pr-2 w-24">Date</th>
          <th className="text-left pr-2 w-16">Ticker</th>
          <th className="text-left pr-2 w-20">Form</th>
          <th className="text-left pr-3">Description</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-terminal-divider">
        {filings.map((f) => {
          const meta = formMeta[f.form];
          const cls = meta ? (COLOR_CLASS[meta.color] ?? COLOR_CLASS.muted) : COLOR_CLASS.muted;
          return (
            <tr key={`${f.ticker}-${f.accession}`} className="hover:bg-white/[0.02]">
              <td className="py-1.5 pl-3 pr-2 tabular-nums text-terminal-muted whitespace-nowrap">
                {f.filing_date}
              </td>
              <td className="pr-2 text-accent-amber">{f.ticker}</td>
              <td className="pr-2">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`pill border ${cls} hover:opacity-80`}
                  title={meta?.label ?? f.form}
                >
                  {f.form}
                </a>
              </td>
              <td className="pr-3 text-terminal-text">
                <div className="flex items-baseline gap-2">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate hover:text-accent-amber transition"
                  >
                    {(f.description || f.form_label || meta?.label || f.form).trim()}
                  </a>
                  {f.items && (
                    <span className="text-2xs text-terminal-muted whitespace-nowrap">
                      [items {f.items}]
                    </span>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
