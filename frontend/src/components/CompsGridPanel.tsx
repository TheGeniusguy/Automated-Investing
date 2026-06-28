import { useEffect, useMemo, useState } from "react";

// Local types (decoupled from api/types.ts on purpose).

interface CompRow {
  symbol: string;
  name: string;
  market_cap: number | null;
  pe: number | null;
  fwd_pe: number | null;
  ev_ebitda: number | null;
  ev_rev: number | null;
  pb: number | null;
  ps: number | null;
  profit_margin: number | null;
  rev_growth: number | null;
  is_target: boolean;
}

type Medians = Record<string, number | null>;
type PremiumDiscount = Record<string, Record<string, number | null>>;

interface CompsResponse {
  symbol: string;
  peers: string[];
  peer_source: string;
  rows: CompRow[];
  medians: Medians;
  premium_discount: PremiumDiscount;
  metrics: string[];
  data_mode: string;
  as_of: string;
  source: string;
}

// Metric -> column header + whether a higher value is "cheap" (lower multiple =
// cheaper = green for the target). Margin and growth are quality metrics where
// higher is better, so they invert the cheap/rich color logic.
const COLUMNS: { key: keyof CompRow; label: string; kind: "mult" | "pct" | "quality" }[] = [
  { key: "pe", label: "P/E", kind: "mult" },
  { key: "fwd_pe", label: "Fwd P/E", kind: "mult" },
  { key: "ev_ebitda", label: "EV/EBITDA", kind: "mult" },
  { key: "ev_rev", label: "EV/Rev", kind: "mult" },
  { key: "pb", label: "P/B", kind: "mult" },
  { key: "ps", label: "P/S", kind: "mult" },
  { key: "profit_margin", label: "Margin", kind: "quality" },
  { key: "rev_growth", label: "Rev Growth", kind: "quality" },
];

// Local fallback so the panel renders fully populated even before/without the
// backend. Mirrors the AAPL comp set from comps_grid.py.
const FALLBACK: CompsResponse = {
  symbol: "AAPL",
  peers: ["MSFT", "GOOGL", "AMZN", "META"],
  peer_source: "curated",
  rows: [
    { symbol: "AAPL", name: "Apple Inc.", market_cap: 3_350_000_000_000, pe: 33.1, fwd_pe: 29.4, ev_ebitda: 25.2, ev_rev: 8.7, pb: 52.6, ps: 8.9, profit_margin: 26.3, rev_growth: 6.1, is_target: true },
    { symbol: "MSFT", name: "Microsoft Corp.", market_cap: 3_180_000_000_000, pe: 36.4, fwd_pe: 31.2, ev_ebitda: 24.1, ev_rev: 12.8, pb: 11.3, ps: 13.2, profit_margin: 36.1, rev_growth: 15.7, is_target: false },
    { symbol: "GOOGL", name: "Alphabet Inc.", market_cap: 2_180_000_000_000, pe: 24.8, fwd_pe: 21.3, ev_ebitda: 16.4, ev_rev: 6.3, pb: 6.8, ps: 6.6, profit_margin: 28.6, rev_growth: 13.4, is_target: false },
    { symbol: "AMZN", name: "Amazon.com Inc.", market_cap: 2_010_000_000_000, pe: 41.7, fwd_pe: 32.8, ev_ebitda: 18.9, ev_rev: 3.2, pb: 7.4, ps: 3.3, profit_margin: 8.1, rev_growth: 11.9, is_target: false },
    { symbol: "META", name: "Meta Platforms Inc.", market_cap: 1_480_000_000_000, pe: 27.3, fwd_pe: 23.1, ev_ebitda: 17.2, ev_rev: 9.1, pb: 8.9, ps: 9.4, profit_margin: 35.2, rev_growth: 21.6, is_target: false },
  ],
  medians: { pe: 31.85, fwd_pe: 27.15, ev_ebitda: 18.05, ev_rev: 7.7, pb: 8.15, ps: 8.0, profit_margin: 32.35, rev_growth: 14.55 },
  premium_discount: {
    AAPL: { pe_pct: 3.9, fwd_pe_pct: 8.3, ev_ebitda_pct: 39.6, ev_rev_pct: 13.0, pb_pct: 545.4, ps_pct: 11.3, profit_margin_pct: -18.7, rev_growth_pct: -58.1 },
    MSFT: { pe_pct: 14.3, fwd_pe_pct: 14.9, ev_ebitda_pct: 33.5, ev_rev_pct: 66.2, pb_pct: 38.7, ps_pct: 65.0, profit_margin_pct: 11.6, rev_growth_pct: 7.9 },
    GOOGL: { pe_pct: -22.1, fwd_pe_pct: -21.5, ev_ebitda_pct: -9.1, ev_rev_pct: -18.2, pb_pct: -16.6, ps_pct: -17.5, profit_margin_pct: -11.6, rev_growth_pct: -7.9 },
    AMZN: { pe_pct: 30.9, fwd_pe_pct: 20.8, ev_ebitda_pct: 4.7, ev_rev_pct: -58.4, pb_pct: -9.2, ps_pct: -58.8, profit_margin_pct: -74.9, rev_growth_pct: -18.2 },
    META: { pe_pct: -14.3, fwd_pe_pct: -14.9, ev_ebitda_pct: -4.7, ev_rev_pct: 18.2, pb_pct: 9.2, ps_pct: 17.5, profit_margin_pct: 8.8, rev_growth_pct: 48.5 },
  },
  metrics: ["pe", "fwd_pe", "ev_ebitda", "ev_rev", "pb", "ps", "profit_margin", "rev_growth"],
  data_mode: "sample",
  as_of: "",
  source: "sample",
};

// Formatters.

function fmtMcap(v: number | null): string {
  if (v == null) return "--";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(0)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

function fmtMult(v: number | null): string {
  if (v == null) return "n/m";
  return `${v.toFixed(1)}x`;
}

function fmtPct(v: number | null): string {
  if (v == null) return "--";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}

// Premium/discount color for a TARGET cell.
// For multiples: target trades cheap (below peer median, pct < 0) -> green.
// For quality (margin/growth): target above peer median (pct > 0) -> green.
function targetCellColor(pct: number | null, kind: "mult" | "pct" | "quality"): string {
  if (pct == null) return "text-terminal-text";
  const cheapGood = kind !== "quality";
  const favorable = cheapGood ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 1) return "text-terminal-text";
  return favorable ? "text-accent-green" : "text-accent-red";
}

export function CompsGridPanel() {
  const [symbol, setSymbol] = useState("AAPL");
  const [input, setInput] = useState("AAPL");
  const [data, setData] = useState<CompsResponse>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/comps/${encodeURIComponent(symbol)}`)
      .then((res) => res.json())
      .then((json: CompsResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.rows) && json.rows.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const { rows, medians, premium_discount } = data;

  const target = useMemo(() => rows.find((r) => r.is_target) ?? rows[0], [rows]);
  const peerRows = useMemo(() => rows.filter((r) => !r.is_target), [rows]);

  // KPI: count of metrics where target is cheap vs peer median (favorable).
  const valuationScore = useMemo(() => {
    if (!target) return { cheap: 0, rich: 0 };
    const pd = premium_discount[target.symbol] ?? {};
    let cheap = 0;
    let rich = 0;
    for (const col of COLUMNS) {
      const pct = pd[`${String(col.key)}_pct`];
      if (pct == null || Math.abs(pct) < 1) continue;
      const favorable = col.kind !== "quality" ? pct < 0 : pct > 0;
      if (favorable) cheap += 1;
      else rich += 1;
    }
    return { cheap, rich };
  }, [target, premium_discount]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const s = input.trim().toUpperCase();
    if (s) setSymbol(s);
  }

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between gap-2">
        <span>RELATIVE VALUATION (COMPS)</span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>}
          <form onSubmit={submit} className="flex items-center gap-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              className="w-20 bg-terminal-bg border border-terminal-border rounded px-2 py-0.5 text-xs font-mono uppercase text-terminal-text outline-none focus:border-accent normal-case tracking-normal"
              placeholder="Ticker"
            />
            <button
              type="submit"
              className="pill bg-accent text-terminal-bg normal-case tracking-normal"
            >
              Go
            </button>
          </form>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Kpi label="Target" value={target?.symbol ?? "--"} sub={target?.name} accent="text-accent" />
          <Kpi label="Peers" value={String(peerRows.length)} sub={data.peers.join(" ")} accent="text-terminal-text" />
          <Kpi
            label="Cheap vs Peers"
            value={`${valuationScore.cheap}/${COLUMNS.length}`}
            sub="metrics below peer median"
            accent="text-accent-green"
          />
          <Kpi
            label="Rich vs Peers"
            value={`${valuationScore.rich}/${COLUMNS.length}`}
            sub="metrics above peer median"
            accent="text-accent-red"
          />
        </div>

        {/* Comps grid */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-divider">
                <th className="text-left py-1.5 px-2 font-medium sticky left-0 bg-terminal-bg z-10">Company</th>
                <th className="text-right py-1.5 px-2 font-medium">Mkt Cap</th>
                {COLUMNS.map((c) => (
                  <th key={String(c.key)} className="text-right py-1.5 px-2 font-medium whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pd = premium_discount[r.symbol] ?? {};
                return (
                  <tr
                    key={r.symbol}
                    className={
                      r.is_target
                        ? "border-l-2 border-accent bg-accent/[0.06]"
                        : "border-t border-terminal-border/20 hover:bg-white/[0.02]"
                    }
                  >
                    <td
                      className={`py-1.5 px-2 sticky left-0 z-10 ${
                        r.is_target ? "bg-[#2a2622]" : "bg-terminal-bg"
                      }`}
                    >
                      <div className={`flex items-center gap-1.5 leading-tight ${r.is_target ? "font-semibold text-terminal-text" : "text-terminal-text"}`}>
                        <span className="font-mono">{r.symbol}</span>
                        {r.is_target && <span className="pill bg-accent/20 text-accent">RV</span>}
                      </div>
                      <div className="text-2xs text-terminal-dim truncate max-w-[150px]" title={r.name}>
                        {r.name}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted whitespace-nowrap">
                      {fmtMcap(r.market_cap)}
                    </td>
                    {COLUMNS.map((c) => {
                      const val = r[c.key] as number | null;
                      const pct = pd[`${String(c.key)}_pct`] ?? null;
                      const isPct = c.kind === "quality" || c.kind === "pct";
                      const display = isPct ? fmtPct(val) : fmtMult(val);
                      const color = r.is_target
                        ? targetCellColor(pct, c.kind)
                        : "text-terminal-muted";
                      return (
                        <td key={String(c.key)} className="py-1.5 px-2 text-right whitespace-nowrap">
                          <div className={`font-mono tabular-nums ${color} ${r.is_target ? "font-semibold" : ""}`}>
                            {display}
                          </div>
                          {r.is_target && pct != null && Math.abs(pct) >= 1 && (
                            <div className="text-[9px] leading-none font-mono tabular-nums text-terminal-dim">
                              {fmtPct(pct)}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {/* Peer median summary row */}
              <tr className="border-t-2 border-terminal-divider bg-terminal-panel/40">
                <td className="py-1.5 px-2 sticky left-0 bg-terminal-panel z-10">
                  <div className="text-terminal-muted uppercase text-2xs tracking-wider font-medium">
                    Peer Median
                  </div>
                </td>
                <td className="py-1.5 px-2 text-right text-terminal-dim font-mono">--</td>
                {COLUMNS.map((c) => {
                  const med = medians[String(c.key)] ?? null;
                  const isPct = c.kind === "quality" || c.kind === "pct";
                  return (
                    <td
                      key={String(c.key)}
                      className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text whitespace-nowrap"
                    >
                      {isPct ? fmtPct(med) : fmtMult(med)}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Footer / legend */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-2xs text-terminal-dim pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm inline-block bg-accent-green" />
              Cheap vs peer median
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm inline-block bg-accent-red" />
              Rich vs peer median
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-0.5 inline-block bg-accent" />
              Target row
            </span>
          </div>
          <span className="text-terminal-dim">
            Multiples vs auto-selected peer set. Color and % shown for the target row only. n/m = not meaningful.
          </span>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-0.5">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      <div className={`stat-figure text-xl tabular-nums ${accent}`}>{value}</div>
      {sub && (
        <div className="text-2xs text-terminal-dim truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}
