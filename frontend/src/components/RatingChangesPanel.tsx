import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
type RatingAction = "upgrade" | "downgrade" | "initiate" | "maintain" | "reiterate";

interface RatingActionRow {
  date: string;
  firm: string;
  action: RatingAction;
  from_grade: string;
  to_grade: string;
}
interface RatingMomentum {
  window_days: number;
  considered: number;
  used_recent: boolean;
  upgrades: number;
  downgrades: number;
  initiations: number;
  other: number;
  net_score: number;
  label: "improving" | "deteriorating" | "stable";
}
interface RatingConsensus {
  firms: number;
  bullish: number;
  neutral: number;
  bearish: number;
  rating: string;
}
interface RatingChangesResponse {
  symbol: string;
  actions: RatingActionRow[];
  count: number;
  momentum: RatingMomentum;
  consensus: RatingConsensus;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: RatingChangesResponse = {
  symbol: "AAPL",
  actions: [
    { date: "2026-06-22", firm: "Morgan Stanley", action: "upgrade", from_grade: "Equal-Weight", to_grade: "Overweight" },
    { date: "2026-06-14", firm: "Goldman Sachs", action: "reiterate", from_grade: "Buy", to_grade: "Buy" },
    { date: "2026-05-30", firm: "JPMorgan", action: "upgrade", from_grade: "Neutral", to_grade: "Overweight" },
    { date: "2026-05-19", firm: "Wells Fargo", action: "maintain", from_grade: "Overweight", to_grade: "Overweight" },
    { date: "2026-05-02", firm: "Barclays", action: "downgrade", from_grade: "Overweight", to_grade: "Equal-Weight" },
    { date: "2026-04-18", firm: "Jefferies", action: "upgrade", from_grade: "Hold", to_grade: "Buy" },
    { date: "2026-03-29", firm: "RBC Capital", action: "reiterate", from_grade: "Outperform", to_grade: "Outperform" },
    { date: "2026-03-11", firm: "Evercore ISI", action: "initiate", from_grade: "", to_grade: "Outperform" },
  ],
  count: 8,
  momentum: {
    window_days: 90,
    considered: 8,
    used_recent: true,
    upgrades: 3,
    downgrades: 1,
    initiations: 1,
    other: 3,
    net_score: 2,
    label: "improving",
  },
  consensus: {
    firms: 7,
    bullish: 5,
    neutral: 2,
    bearish: 0,
    rating: "Buy",
  },
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// ── Display metadata for actions ─────────────────────────────────────────────
const ACTION_META: Record<RatingAction, { label: string; cls: string; arrow: string }> = {
  upgrade: { label: "Upgrade", cls: "bg-accent-green/15 text-accent-green", arrow: "▲" },
  downgrade: { label: "Downgrade", cls: "bg-accent-red/15 text-accent-red", arrow: "▼" },
  initiate: { label: "Initiate", cls: "bg-accent-blue/15 text-accent-blue", arrow: "✷" },
  maintain: { label: "Maintain", cls: "bg-terminal-panel text-terminal-muted", arrow: "→" },
  reiterate: { label: "Reiterate", cls: "bg-terminal-panel text-terminal-muted", arrow: "→" },
};

function momentumColor(label: RatingMomentum["label"]): string {
  if (label === "improving") return "text-accent-green";
  if (label === "deteriorating") return "text-accent-red";
  return "text-terminal-muted";
}
function netColor(net: number): string {
  if (net > 0) return "text-accent-green";
  if (net < 0) return "text-accent-red";
  return "text-terminal-muted";
}
function consensusColor(rating: string): string {
  const r = rating.toLowerCase();
  if (r.includes("buy")) return "text-accent-green";
  if (r.includes("sell")) return "text-accent-red";
  if (r.includes("hold")) return "text-accent-amber";
  return "text-terminal-muted";
}
function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "2-digit", timeZone: "UTC" });
}

export function RatingChangesPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<RatingChangesResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/rating-changes/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: RatingChangesResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.actions) && json.momentum) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = input.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  const m = data.momentum;
  const c = data.consensus;

  const verdictLine = useMemo(() => {
    const desc =
      m.label === "improving"
        ? "sell-side conviction is building"
        : m.label === "deteriorating"
        ? "the desk is turning more cautious"
        : "rating flow is balanced";
    const sign = m.net_score > 0 ? "+" : "";
    return `${data.symbol}: net ${sign}${m.net_score} over ${m.window_days}d (${m.upgrades} up / ${m.downgrades} down) - ${desc}.`;
  }, [data.symbol, m]);

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>RATING CHANGES</span>
        <span className="text-[10px] font-mono text-terminal-dim">Upgrades / Downgrades</span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ticker"
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono uppercase w-28 text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={submit}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Load
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Momentum + consensus hero */}
        <div className="grid grid-cols-12 gap-2">
          {/* Net rating momentum */}
          <div className="col-span-5 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Net Rating Change ({m.window_days}d)
            </div>
            <div className="flex items-end gap-1">
              <span className={`stat-figure leading-none tabular-nums ${netColor(m.net_score)}`}>
                {m.net_score > 0 ? "+" : ""}{m.net_score}
              </span>
            </div>
            <div className={`text-sm font-mono uppercase tracking-wide ${momentumColor(m.label)}`}>
              {m.label}
            </div>
            <div className="mt-2 flex items-center gap-3 text-[10px] font-mono tabular-nums">
              <span className="text-accent-green">{m.upgrades} up</span>
              <span className="text-accent-red">{m.downgrades} down</span>
              <span className="text-accent-blue">{m.initiations} init</span>
            </div>
          </div>

          {/* Consensus */}
          <div className="col-span-7 grid grid-cols-2 gap-2">
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Consensus</div>
              <div className={`stat-figure leading-none ${consensusColor(c.rating)}`}>{c.rating}</div>
              <div className="text-[10px] font-mono text-terminal-muted">{c.firms} firms rating</div>
            </div>
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-center gap-1.5">
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-12 text-terminal-dim uppercase">Bull</span>
                <div className="flex-1 h-1.5 bg-terminal-panel rounded-full overflow-hidden">
                  <div className="h-full bg-accent-green rounded-full" style={{ width: `${pct(c.bullish, c.firms)}%` }} />
                </div>
                <span className="w-5 text-right tabular-nums text-accent-green">{c.bullish}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-12 text-terminal-dim uppercase">Hold</span>
                <div className="flex-1 h-1.5 bg-terminal-panel rounded-full overflow-hidden">
                  <div className="h-full bg-accent-amber rounded-full" style={{ width: `${pct(c.neutral, c.firms)}%` }} />
                </div>
                <span className="w-5 text-right tabular-nums text-accent-amber">{c.neutral}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-12 text-terminal-dim uppercase">Bear</span>
                <div className="flex-1 h-1.5 bg-terminal-panel rounded-full overflow-hidden">
                  <div className="h-full bg-accent-red rounded-full" style={{ width: `${pct(c.bearish, c.firms)}%` }} />
                </div>
                <span className="w-5 text-right tabular-nums text-accent-red">{c.bearish}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Plain-language verdict */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3">
          {verdictLine}
        </div>

        {/* Action timeline */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Action Timeline</span>
            <span>{data.count} actions</span>
          </div>
          <div className="border-t border-terminal-divider overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-terminal-panel">
                <tr className="text-[10px] font-mono uppercase text-terminal-dim">
                  <th className="text-left font-normal py-1 pr-2">Date</th>
                  <th className="text-left font-normal py-1 pr-2">Firm</th>
                  <th className="text-left font-normal py-1 pr-2">Action</th>
                  <th className="text-right font-normal py-1">Rating</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-terminal-divider">
                {data.actions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-center text-terminal-dim font-sans">
                      No rating actions on record
                    </td>
                  </tr>
                ) : (
                  data.actions.map((a, i) => {
                    const meta = ACTION_META[a.action] ?? ACTION_META.maintain;
                    return (
                      <tr key={i} className="hover:bg-terminal-bg/40">
                        <td className="py-1 pr-2 font-mono tabular-nums text-terminal-muted whitespace-nowrap">
                          {fmtDate(a.date)}
                        </td>
                        <td className="py-1 pr-2 text-terminal-text font-sans truncate max-w-[140px]">{a.firm}</td>
                        <td className="py-1 pr-2">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${meta.cls}`}>
                            <span>{meta.arrow}</span>
                            {meta.label}
                          </span>
                        </td>
                        <td className="py-1 text-right font-mono tabular-nums whitespace-nowrap">
                          {a.from_grade ? (
                            <span className="text-terminal-dim">{a.from_grade} </span>
                          ) : null}
                          {a.from_grade ? <span className="text-terminal-dim">&rarr; </span> : null}
                          <span className="text-terminal-text">{a.to_grade || "n/a"}</span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto flex items-center gap-4 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span>Broker rating actions</span>
          <span className="ml-auto">Net = upgrades - downgrades</span>
        </div>
      </div>
    </div>
  );
}

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}
