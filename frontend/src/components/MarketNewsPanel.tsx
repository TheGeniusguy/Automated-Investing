import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { MarketNewsItem, MarketNewsResponse } from "../api/types";

const LIMIT_OPTIONS = [30, 60, 120];

/**
 * Market News Panel - Unusual Whales market-wide news firehose.
 *
 * A live, market-wide headline feed (NOT per-ticker). Pulls from
 * `api.marketNews(limit, sources?)` and renders a chronological feed with a
 * "major only" toggle and a source filter derived from the loaded items.
 *
 * Degrades calmly: when the backend reports `configured === false` we show a
 * muted needs-config card instead of a red error banner. The red banner is
 * reserved for actual fetch failures.
 */
export function MarketNewsPanel() {
  const [data, setData] = useState<MarketNewsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const [limit, setLimit] = useState<number>(60);
  const [majorOnly, setMajorOnly] = useState<boolean>(false);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.marketNews(limit)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [limit]);

  const items: MarketNewsItem[] = data?.items ?? [];

  // Distinct source list, derived from the loaded items.
  const sources = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items) {
      if (it.source) seen.add(it.source);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [items]);

  // If the active source disappears after a re-fetch, reset it.
  useEffect(() => {
    if (activeSource && !sources.includes(activeSource)) {
      setActiveSource(null);
    }
  }, [sources, activeSource]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (majorOnly && !it.is_major) return false;
      if (activeSource && it.source !== activeSource) return false;
      return true;
    });
  }, [items, majorOnly, activeSource]);

  const configured = data ? data.configured : true;

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span>Market News</span>
          <span className="normal-case tracking-normal text-terminal-dim">
            {filtered.length}{activeSource ? ` · ${activeSource}` : ""}
          </span>
        </div>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching..." : data ? shortTs(data.fetched_at) : ""}
        </span>
      </div>

      <div className="panel-body p-0 flex flex-col">
        <div className="px-4 py-2 border-b border-terminal-divider text-2xs text-terminal-dim">
          Live market-moving headlines as they break, across the whole market.
        </div>

        {/* Controls */}
        <div className="px-4 py-2 border-b border-terminal-divider flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1">
            <span className="text-2xs uppercase tracking-wider text-terminal-muted mr-1">show</span>
            <button
              onClick={() => setMajorOnly((v) => !v)}
              className={
                "px-2 py-0.5 border text-2xs transition " +
                (majorOnly
                  ? "border-accent-amber/60 text-accent-amber"
                  : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
              }
            >
              major only
            </button>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-2xs uppercase tracking-wider text-terminal-muted mr-1">limit</span>
            {LIMIT_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setLimit(n)}
                className={
                  "px-2 py-0.5 border text-2xs transition tabular-nums " +
                  (n === limit
                    ? "border-accent-amber/60 text-accent-amber"
                    : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
                }
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* Source filter strip (derived from loaded items) */}
        {sources.length > 0 && (
          <div className="px-4 py-2 border-b border-terminal-divider text-2xs">
            <div className="uppercase tracking-wider text-terminal-muted mb-1">source</div>
            <button
              onClick={() => setActiveSource(null)}
              className={
                "px-2 py-0.5 mr-1 mb-1 border transition " +
                (activeSource === null
                  ? "border-accent-amber/60 text-accent-amber"
                  : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
              }
            >
              all
            </button>
            {sources.map((s) => (
              <button
                key={s}
                onClick={() => setActiveSource(s === activeSource ? null : s)}
                className={
                  "px-2 py-0.5 mr-1 mb-1 border transition " +
                  (s === activeSource
                    ? "border-accent-amber/60 text-accent-amber"
                    : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
                }
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Feed / states */}
        <div className="flex-1 overflow-auto">
          {/* Real fetch error -> red banner */}
          {err && <div className="px-4 py-3 text-accent-red text-xs">⚠ {err}</div>}

          {/* Degraded / needs-config -> calm muted card (NOT red) */}
          {!err && !configured && (
            <div className="p-4">
              <div className="border border-terminal-divider bg-black/20 p-4">
                <div className="text-terminal-text text-sm mb-1">
                  Market News needs configuration
                </div>
                <div className="text-terminal-muted text-xs leading-relaxed">
                  Add an UNUSUAL_WHALES_API_KEY to your .env to enable the live
                  Unusual Whales feed, then restart the backend.
                </div>
              </div>
            </div>
          )}

          {/* Empty */}
          {!err && configured && filtered.length === 0 && !loading && (
            <div className="px-4 py-3 text-terminal-dim text-xs">No headlines.</div>
          )}

          {!err && configured && (
            <ul className="divide-y divide-terminal-divider">
              {filtered.map((n) => (
                <NewsRow key={n.id} item={n} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function NewsRow({ item }: { item: MarketNewsItem }) {
  return (
    <li className="px-4 py-3 hover:bg-white/[0.02]">
      {/* Meta line: time leads, source second, chips trail. Tight, no dead gaps. */}
      <div className="flex items-center gap-2 mb-1.5 min-w-0">
        <span className="text-2xs text-terminal-muted tabular-nums shrink-0">
          {shortTs(item.published)}
        </span>
        <span className="text-terminal-dim shrink-0">·</span>
        <span
          className="text-2xs text-terminal-dim uppercase tracking-wider truncate min-w-0"
          title={item.source}
        >
          {item.source}
        </span>
        <span className="flex items-center gap-1 ml-auto shrink-0">
          {item.sentiment && <SentimentChip sentiment={item.sentiment} />}
          {item.is_major && (
            <span className="pill border border-accent-amber/50 bg-accent-amber/5 text-accent-amber">
              MAJOR
            </span>
          )}
        </span>
      </div>

      {/* Editorial headline: readable serif, wraps instead of truncating. */}
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="block font-serif text-[15px] leading-snug text-terminal-text
                   hover:text-accent-amber transition"
      >
        {item.title}
      </a>

      {item.tickers.length > 0 && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {item.tickers.slice(0, 8).map((t) => (
            <span
              key={t}
              className="pill border border-terminal-divider text-terminal-muted"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function SentimentChip({ sentiment }: { sentiment: string }) {
  const s = sentiment.toLowerCase();
  let cls = "border-terminal-divider text-terminal-muted";
  if (s.includes("pos") || s.includes("bull")) {
    cls = "border-accent-green/40 bg-accent-green/5 text-accent-green";
  } else if (s.includes("neg") || s.includes("bear")) {
    cls = "border-accent-red/40 bg-accent-red/5 text-accent-red";
  }
  return (
    <span className={"pill border shrink-0 " + cls} title={sentiment}>
      {sentiment}
    </span>
  );
}

function shortTs(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hhmm = d.toTimeString().slice(0, 5);
  if (sameDay) return hhmm;
  return d.toISOString().slice(0, 10) + " " + hhmm;
}
