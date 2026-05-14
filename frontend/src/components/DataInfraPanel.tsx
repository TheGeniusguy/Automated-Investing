import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { DbStatus, EtlRun } from "../api/types";

const REFRESH_MS = 5000; // poll while an ETL is in-flight

/**
 * Panel 5 — Data Infrastructure dashboard.
 *
 * Surfaces the DuckDB persistence layer: table row counts, instrument
 * universe composition, date coverage, ETL run history, and one-click
 * ingestion triggers.
 */
export function DataInfraPanel() {
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pricesSymbol, setPricesSymbol] = useState<string>("AAPL,MSFT,NVDA,SPY,QQQ");
  const [fundamentalsSymbol, setFundamentalsSymbol] = useState<string>("AAPL,MSFT,NVDA");

  const reload = async () => {
    try {
      setStatus(await api.dbStatus());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const runUniverse = async () => {
    setBusy("universe");
    try { await api.ingestUniverse(); await reload(); }
    catch (e) { setErr(String(e)); }
    finally   { setBusy(null); }
  };

  const runPrices = async () => {
    setBusy("prices");
    try {
      const syms = pricesSymbol.split(/[\s,]+/).filter(Boolean);
      await api.ingestPrices(syms, 3650);
      await reload();
    } catch (e) { setErr(String(e)); }
    finally   { setBusy(null); }
  };

  const runFundamentals = async () => {
    setBusy("fundamentals");
    try {
      const syms = fundamentalsSymbol.split(/[\s,]+/).filter(Boolean);
      await api.ingestFundamentals(syms);
      await reload();
    } catch (e) { setErr(String(e)); }
    finally   { setBusy(null); }
  };

  return (
    <div className="grid grid-cols-3 gap-2 h-full">
      <div className="col-span-1">
        <StatsCard status={status} err={err} />
      </div>
      <div className="col-span-1">
        <IngestCard
          title="Universe"
          body={
            <p className="text-terminal-muted leading-relaxed">
              Pulls all ~13k US filers from EDGAR + local watchlist
              symbols. ~15s cold. Idempotent — re-running upserts only
              changed metadata.
            </p>
          }
          actionLabel="Bootstrap universe"
          actionBusy={busy === "universe"}
          onAction={runUniverse}
        />
      </div>
      <div className="col-span-1">
        <IngestCard
          title="Prices"
          body={
            <div>
              <label className="text-2xs uppercase tracking-wider text-terminal-muted">
                symbols (comma-separated, 10y backfill)
              </label>
              <textarea
                value={pricesSymbol}
                onChange={(e) => setPricesSymbol(e.target.value)}
                rows={2}
                spellCheck={false}
                className="mt-1 w-full bg-black/40 border border-terminal-divider
                           text-terminal-text font-mono text-xs p-2 outline-none
                           focus:border-accent-amber/60 resize-none"
              />
            </div>
          }
          actionLabel="Backfill prices"
          actionBusy={busy === "prices"}
          onAction={runPrices}
        />
      </div>
      <div className="col-span-3 grid grid-cols-3 gap-2">
        <div className="col-span-1">
          <IngestCard
            title="Fundamentals"
            body={
              <div>
                <label className="text-2xs uppercase tracking-wider text-terminal-muted">
                  symbols (quarterly statements)
                </label>
                <textarea
                  value={fundamentalsSymbol}
                  onChange={(e) => setFundamentalsSymbol(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="mt-1 w-full bg-black/40 border border-terminal-divider
                             text-terminal-text font-mono text-xs p-2 outline-none
                             focus:border-accent-amber/60 resize-none"
                />
              </div>
            }
            actionLabel="Refresh fundamentals"
            actionBusy={busy === "fundamentals"}
            onAction={runFundamentals}
          />
        </div>
        <div className="col-span-2">
          <EtlRunsCard runs={status?.recent_runs ?? []} />
        </div>
      </div>
    </div>
  );
}

function StatsCard({ status, err }: { status: DbStatus | null; err: string | null }) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Data Infrastructure</span>
        <span className="normal-case tracking-normal text-terminal-dim">DuckDB</span>
      </div>
      <div className="panel-body text-xs space-y-3">
        {err && <div className="text-accent-red">⚠ {err}</div>}
        {status && (
          <>
            <div>
              <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">Rows by table</div>
              {Object.entries(status.tables).map(([t, n]) => (
                <Row key={t} k={t} v={fmtCount(n)} />
              ))}
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">Universe composition</div>
              {Object.entries(status.instrument_types).map(([t, n]) => (
                <Row key={t} k={t} v={fmtCount(n)} />
              ))}
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">Coverage</div>
              <Row k="prices" v={fmtRange(status.price_range)} />
              <Row k="fundamentals" v={fmtRange(status.fundamentals_range)} />
            </div>
            <div className="text-terminal-dim text-2xs truncate" title={status.db_path}>
              {status.db_path}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IngestCard({
  title,
  body,
  actionLabel,
  actionBusy,
  onAction,
}: {
  title: string;
  body: React.ReactNode;
  actionLabel: string;
  actionBusy: boolean;
  onAction: () => void;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>{title}</span></div>
      <div className="panel-body text-xs flex flex-col gap-3">
        <div>{body}</div>
        <button
          onClick={onAction}
          disabled={actionBusy}
          className={
            "self-start px-3 py-1.5 border text-2xs uppercase tracking-wider transition " +
            (actionBusy
              ? "border-accent-amber/40 text-accent-amber opacity-60 cursor-wait"
              : "border-accent-amber/60 text-accent-amber hover:bg-accent-amber/10")
          }
        >
          {actionBusy ? "running…" : actionLabel}
        </button>
      </div>
    </div>
  );
}

function EtlRunsCard({ runs }: { runs: EtlRun[] }) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Recent ETL Runs</span>
        <span className="normal-case tracking-normal text-terminal-dim">{runs.length}</span>
      </div>
      <div className="panel-body p-0 overflow-auto">
        {runs.length === 0 ? (
          <div className="p-3 text-terminal-dim text-xs">
            No ETL runs yet. Trigger one of the ingest cards.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-terminal-muted text-2xs uppercase tracking-wider sticky top-0 bg-terminal-panel">
              <tr className="border-b border-terminal-divider">
                <th className="text-left py-1.5 pl-3 pr-2">When</th>
                <th className="text-left pr-2">Source</th>
                <th className="text-left pr-2">Target</th>
                <th className="text-right pr-2">Rows</th>
                <th className="text-left pr-2">Status</th>
                <th className="text-left pr-3">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-divider">
              {runs.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.02]">
                  <td className="py-1.5 pl-3 pr-2 text-terminal-muted whitespace-nowrap" title={r.started_at ?? ""}>
                    {shortTime(r.started_at)}
                  </td>
                  <td className="pr-2 text-accent-amber">{r.source}</td>
                  <td className="pr-2 text-terminal-text truncate max-w-[8rem]" title={r.target ?? ""}>
                    {r.target ?? "—"}
                  </td>
                  <td className="pr-2 text-right tabular-nums text-terminal-text">{fmtCount(r.rows_out)}</td>
                  <td className="pr-2">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="pr-3 text-terminal-muted truncate" title={r.note ?? ""}>
                    {r.note ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  if (status === "ok")     return <span className="pill bg-accent-green/15 text-accent-green border border-accent-green/40">ok</span>;
  if (status === "error")  return <span className="pill bg-accent-red/15 text-accent-red border border-accent-red/40">error</span>;
  if (status === "running") return <span className="pill bg-accent-amber/15 text-accent-amber border border-accent-amber/40">running</span>;
  return <span className="pill border border-terminal-divider text-terminal-muted">{status}</span>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-terminal-muted">{k}</span>
      <span className="text-terminal-text tabular-nums">{v}</span>
    </div>
  );
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtRange(r: { first: string | null; last: string | null }): string {
  if (!r.first || !r.last) return "—";
  return `${r.first} → ${r.last}`;
}

function shortTime(ts: string | null): string {
  if (!ts) return "—";
  const t = ts.replace("T", " ");
  // Drop subseconds and timezone for brevity
  return t.replace(/\.\d+/, "").slice(0, 16);
}
