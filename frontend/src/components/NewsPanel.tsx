import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { NewsFeed, NewsItem } from "../api/types";

const DEFAULT_TICKERS = "AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, JPM, XOM, UNH";

/**
 * Panel 7 — News & Sentiment Aggregator.
 *
 * Pulls per-ticker news via yfinance, merges across the watchlist, and renders
 * a chronological feed. URLs deep-link to the publisher.
 */
export function NewsPanel() {
  const [tickersRaw, setTickersRaw] = useState<string>(DEFAULT_TICKERS);
  const [data, setData] = useState<NewsFeed | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeTicker, setActiveTicker] = useState<string | null>(null);

  const tickers = useMemo(
    () => tickersRaw.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean),
    [tickersRaw],
  );

  useEffect(() => {
    if (tickers.length === 0) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api.newsFeed(tickers, 8, 80)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [tickersRaw]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!activeTicker) return data.items;
    return data.items.filter((n) => n.tickers.includes(activeTicker));
  }, [data, activeTicker]);

  return (
    <div className="grid grid-cols-4 gap-2 h-full">
      <div className="col-span-1">
        <div className="panel h-full">
          <div className="panel-header"><span>News Watchlist</span></div>
          <div className="panel-body p-0 flex flex-col">
            <div className="px-3 py-2 border-b border-terminal-divider">
              <label className="text-2xs uppercase tracking-wider text-terminal-muted">tickers</label>
              <textarea
                value={tickersRaw}
                onChange={(e) => setTickersRaw(e.target.value)}
                rows={5}
                spellCheck={false}
                className="mt-1 w-full bg-black/40 border border-terminal-divider
                           text-terminal-text font-mono text-xs p-2 outline-none
                           focus:border-accent-amber/60 resize-none"
                placeholder="AAPL, NVDA, ..."
              />
            </div>
            <div className="px-3 py-2 flex-1 overflow-auto text-2xs">
              <div className="uppercase tracking-wider text-terminal-muted mb-1">filter</div>
              <button
                onClick={() => setActiveTicker(null)}
                className={
                  "px-2 py-0.5 mr-1 mb-1 border transition " +
                  (activeTicker === null
                    ? "border-accent-amber/60 text-accent-amber"
                    : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
                }
              >
                all
              </button>
              {tickers.map((t) => (
                <button
                  key={t}
                  onClick={() => setActiveTicker(t === activeTicker ? null : t)}
                  className={
                    "px-2 py-0.5 mr-1 mb-1 border transition " +
                    (t === activeTicker
                      ? "border-accent-amber/60 text-accent-amber"
                      : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="col-span-3">
        <div className="panel h-full">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <span>News Feed</span>
              <span className="normal-case tracking-normal text-terminal-dim">
                {filtered.length}{activeTicker ? ` · ${activeTicker}` : ""}
              </span>
            </div>
            <span className="normal-case tracking-normal text-terminal-dim">
              {loading ? "fetching…" : data ? `${data.elapsed_s}s` : ""}
            </span>
          </div>
          <div className="flex-1 overflow-auto">
            {err && <div className="p-3 text-accent-red text-xs">⚠ {err}</div>}
            {!err && filtered.length === 0 && !loading && (
              <div className="p-3 text-terminal-dim text-xs">No items.</div>
            )}
            <ul className="divide-y divide-terminal-divider">
              {filtered.map((n) => (
                <NewsRow key={n.url} item={n} onTickerClick={setActiveTicker} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewsRow({
  item,
  onTickerClick,
}: {
  item: NewsItem;
  onTickerClick: (t: string) => void;
}) {
  return (
    <li className="px-3 py-2 hover:bg-white/[0.02] text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-terminal-muted tabular-nums w-32 shrink-0">
          {shortTs(item.published)}
        </span>
        <span className="text-terminal-dim w-24 shrink-0 truncate" title={item.publisher}>
          {item.publisher}
        </span>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="text-terminal-text hover:text-accent-amber transition truncate"
        >
          {item.title}
        </a>
      </div>
      {item.tickers.length > 0 && (
        <div className="mt-1 pl-32 flex items-center gap-1 flex-wrap">
          {item.tickers.slice(0, 6).map((t) => (
            <button
              key={t}
              onClick={(e) => { e.preventDefault(); onTickerClick(t); }}
              className="pill border border-terminal-divider text-terminal-muted hover:text-accent-amber hover:border-accent-amber/40"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function shortTs(iso: string | null): string {
  if (!iso) return "—";
  // Show local date + time
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
