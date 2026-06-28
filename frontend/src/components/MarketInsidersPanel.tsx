import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { MarketInsiderTransaction, MarketInsidersResponse } from "../api/types";

type Direction = "all" | "buy" | "sell";
type SortKey = "txn_date" | "ticker" | "shares" | "price" | "value";
type SortDir = "asc" | "desc";

/**
 * Market Insiders - market-wide insider-trading firehose.
 *
 * Shows every insider buying or selling their own company's stock across the
 * entire market, powered by the Unusual Whales feed via api.marketInsiders.
 * Green is an insider buying, red is selling. Degrades calmly to a needs-config
 * card when no UNUSUAL_WHALES_API_KEY is present.
 */
export function MarketInsidersPanel() {
  const [direction, setDirection] = useState<Direction>("all");
  const [minValueRaw, setMinValueRaw] = useState<string>("");
  const [tickerRaw, setTickerRaw] = useState<string>("");

  const [data, setData] = useState<MarketInsidersResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Fetch on filter change. Debounced via setTimeout so typing the min-value or
  // ticker filter does not fire a request per keystroke. `alive` guard copied
  // from NewsPanel so a stale response never overwrites a newer one.
  useEffect(() => {
    let alive = true;
    const handle = setTimeout(() => {
      setLoading(true);
      setErr(null);
      const minValue = Number(minValueRaw);
      api
        .marketInsiders({
          direction,
          minValue: Number.isFinite(minValue) && minValue > 0 ? minValue : 0,
          ticker: tickerRaw.trim() || undefined,
        })
        .then((d) => alive && setData(d))
        .catch((e) => alive && setErr(String(e)))
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [direction, minValueRaw, tickerRaw]);

  const sorted = useMemo(() => {
    const txns = data?.transactions ?? [];
    const arr = [...txns];
    const mul = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (sortKey === "txn_date" || sortKey === "ticker") {
        const av = (a[sortKey] ?? "") as string;
        const bv = (b[sortKey] ?? "") as string;
        if (av < bv) return -1 * mul;
        if (av > bv) return 1 * mul;
        return 0;
      }
      const av = (a[sortKey] ?? 0) as number;
      const bv = (b[sortKey] ?? 0) as number;
      return (av - bv) * mul;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" ? "asc" : "desc");
    }
  };

  const summary = data?.summary;
  const needsConfig = !!data && data.configured === false;

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header">
        <span>Market Insiders</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : data ? `${data.count} txns` : ""}
        </span>
      </header>

      <div className="panel-body p-0 flex flex-col">
        {/* Grandpa-test one-liner */}
        <div className="px-4 py-2 border-b border-terminal-divider text-2xs text-terminal-muted">
          Who is buying and selling their own company's stock, across the entire
          market - green is an insider buying, red is selling.
        </div>

        {/* Real fetch error (not the unconfigured case) */}
        {err && (
          <div className="px-4 py-2 text-accent-red text-xs border-b border-terminal-divider">
            ⚠ {err}
          </div>
        )}

        {needsConfig ? (
          <NeedsConfig />
        ) : (
          <>
            {/* Summary band - flush metric cells separated by hairlines, no dead
                whitespace. Dollar figures are large serif hero numbers. */}
            {summary && (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-terminal-divider border-b border-terminal-divider">
                <StatCard
                  label="Buy value"
                  value={fmtUsd(summary.buy_value)}
                  sub={`${summary.buy_count} buys`}
                  color="text-accent-green"
                  hero
                />
                <StatCard
                  label="Sell value"
                  value={fmtUsd(summary.sell_value)}
                  sub={`${summary.sell_count} sells`}
                  color="text-accent-red"
                  hero
                />
                <StatCard
                  label="Net value"
                  value={fmtUsd(summary.net_value)}
                  sub={summary.net_value >= 0 ? "net buying" : "net selling"}
                  color={summary.net_value >= 0 ? "text-accent-green" : "text-accent-red"}
                  hero
                />
                <StatCard
                  label="Buy/Sell"
                  value={fmtRatio(summary.buy_sell_ratio)}
                  sub="value ratio"
                  color={summary.buy_sell_ratio >= 1 ? "text-accent-green" : "text-accent-red"}
                />
                <StatCard
                  label="Tickers"
                  value={String(summary.unique_tickers)}
                  sub="unique"
                  color="text-terminal-text"
                />
                <StatCard
                  label="Insiders"
                  value={String(summary.unique_insiders)}
                  sub="unique"
                  color="text-terminal-text"
                />
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-terminal-divider text-2xs">
              <div className="flex items-center gap-1">
                {(["all", "buy", "sell"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={
                      "px-2 py-0.5 border uppercase tracking-wider transition " +
                      (direction === d
                        ? d === "buy"
                          ? "border-accent-green/60 text-accent-green"
                          : d === "sell"
                            ? "border-accent-red/60 text-accent-red"
                            : "border-accent-amber/60 text-accent-amber"
                        : "border-terminal-divider text-terminal-muted hover:text-terminal-text")
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-terminal-muted">
                <span className="uppercase tracking-wider">min $</span>
                <input
                  value={minValueRaw}
                  onChange={(e) => setMinValueRaw(e.target.value.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                  placeholder="0"
                  className="w-24 bg-black/40 border border-terminal-divider text-terminal-text
                             font-mono px-2 py-0.5 outline-none focus:border-accent-amber/60"
                />
              </label>
              <label className="flex items-center gap-1 text-terminal-muted">
                <span className="uppercase tracking-wider">ticker</span>
                <input
                  value={tickerRaw}
                  onChange={(e) => setTickerRaw(e.target.value.toUpperCase())}
                  spellCheck={false}
                  placeholder="any"
                  className="w-20 bg-black/40 border border-terminal-divider text-terminal-text
                             font-mono px-2 py-0.5 outline-none focus:border-accent-amber/60"
                />
              </label>
            </div>

            {/* Transactions table */}
            <div className="flex-1 overflow-auto">
              {loading && !data && (
                <div className="p-3 text-terminal-dim text-xs">Loading…</div>
              )}
              {!loading && data && sorted.length === 0 && !err && (
                <div className="p-3 text-terminal-dim text-xs">No insider transactions.</div>
              )}
              {sorted.length > 0 && (
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-terminal-panel text-terminal-muted uppercase tracking-wider">
                    <tr className="border-b border-terminal-divider">
                      <Th label="Ticker" onClick={() => toggleSort("ticker")} active={sortKey === "ticker"} dir={sortDir} />
                      <th className="text-left font-normal py-1 px-2">Insider</th>
                      <th className="text-left font-normal py-1 px-2">Title</th>
                      <th className="text-left font-normal py-1 px-2">Role</th>
                      <Th label="Date" onClick={() => toggleSort("txn_date")} active={sortKey === "txn_date"} dir={sortDir} />
                      <th className="text-center font-normal py-1 px-2">Code</th>
                      <th className="text-left font-normal py-1 px-2">Dir</th>
                      <Th label="Shares" align="right" onClick={() => toggleSort("shares")} active={sortKey === "shares"} dir={sortDir} />
                      <Th label="Price" align="right" onClick={() => toggleSort("price")} active={sortKey === "price"} dir={sortDir} />
                      <Th label="Value" align="right" onClick={() => toggleSort("value")} active={sortKey === "value"} dir={sortDir} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-terminal-divider">
                    {sorted.map((t, i) => (
                      <InsiderRow key={`${t.ticker}-${t.insider_name}-${t.txn_date}-${i}`} t={t} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function InsiderRow({ t }: { t: MarketInsiderTransaction }) {
  const dirCls =
    t.direction === "buy"
      ? "text-accent-green"
      : t.direction === "sell"
        ? "text-accent-red"
        : "text-terminal-dim";
  const dirLabel =
    t.direction === "buy" ? "BUY" : t.direction === "sell" ? "SELL" : "OTHER";

  return (
    <tr className="hover:bg-white/[0.02] leading-tight">
      <td className="py-1 px-2 font-semibold">
        {t.source_url ? (
          <a
            href={t.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-terminal-text hover:text-accent-amber transition"
            title={t.company ?? t.ticker}
          >
            {t.ticker}
          </a>
        ) : (
          <span className="text-terminal-text" title={t.company ?? undefined}>
            {t.ticker}
          </span>
        )}
      </td>
      <td className="py-1 px-2 text-terminal-text truncate max-w-[140px]" title={t.insider_name}>
        {t.insider_name}
      </td>
      <td className="py-1 px-2 text-terminal-dim truncate max-w-[120px]" title={t.insider_title ?? undefined}>
        {t.insider_title || "-"}
      </td>
      <td className="py-1 px-2">
        <RoleBadges t={t} />
      </td>
      <td className="py-1 px-2 tabular-nums text-terminal-muted">{t.txn_date ?? "-"}</td>
      <td className="py-1 px-2 text-center text-terminal-muted">{t.txn_code || "-"}</td>
      <td className={`py-1 px-2 font-semibold uppercase tracking-wider ${dirCls}`}>{dirLabel}</td>
      <td className="py-1 px-2 text-right tabular-nums">{fmtNum(t.shares)}</td>
      <td className="py-1 px-2 text-right tabular-nums">{fmtPrice(t.price)}</td>
      <td className={`py-1 px-2 text-right tabular-nums font-semibold ${dirCls}`}>{fmtUsd(t.value)}</td>
    </tr>
  );
}

function RoleBadges({ t }: { t: MarketInsiderTransaction }) {
  const badges: string[] = [];
  if (t.is_director) badges.push("Dir");
  if (t.is_officer) badges.push("Off");
  if (t.is_ten_pct) badges.push("10%");
  if (badges.length === 0) return <span className="text-terminal-dim">-</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b}
          className="px-1.5 py-0.5 rounded border border-accent-amber/20 bg-accent-amber/5
                     text-accent-amber/90 uppercase tracking-wider text-2xs leading-none"
        >
          {b}
        </span>
      ))}
    </span>
  );
}

function Th({
  label,
  onClick,
  active,
  dir,
  align = "left",
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
  align?: "left" | "right";
}) {
  return (
    <th className={`font-normal py-1 px-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={onClick}
        className={
          "uppercase tracking-wider transition hover:text-terminal-text " +
          (active ? "text-accent-amber" : "text-terminal-muted")
        }
      >
        {label}
        {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
  hero = false,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  hero?: boolean;
}) {
  return (
    <div className="bg-terminal-panel px-3 py-2.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-[0.12em]">{label}</div>
      <div
        className={
          `stat-figure leading-none mt-1.5 ${hero ? "text-xl" : "text-base"} ` +
          (color ?? "text-terminal-text")
        }
      >
        {value}
      </div>
      {sub && <div className="text-2xs text-terminal-dim tabular-nums mt-1.5">{sub}</div>}
    </div>
  );
}

function NeedsConfig() {
  return (
    <div className="p-4">
      <div className="border border-terminal-divider rounded-sm bg-black/20 p-4">
        <div className="text-terminal-text text-xs font-semibold mb-1">
          Market Insiders needs configuration
        </div>
        <div className="text-terminal-muted text-2xs leading-relaxed">
          Add an UNUSUAL_WHALES_API_KEY to your .env to enable the live Unusual
          Whales feed, then restart the backend.
        </div>
      </div>
    </div>
  );
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "-";
  const neg = v < 0;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e9) s = `$${(a / 1e9).toFixed(1)}B`;
  else if (a >= 1e6) s = `$${(a / 1e6).toFixed(1)}M`;
  else if (a >= 1e3) s = `$${(a / 1e3).toFixed(0)}K`;
  else s = `$${a.toFixed(0)}`;
  return neg ? `-${s}` : s;
}

function fmtRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}x`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "-";
  return `$${v.toFixed(2)}`;
}
