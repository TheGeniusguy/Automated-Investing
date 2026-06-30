import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface DupontYear {
  year: string;
  // 3-step
  net_margin: number | null;        // %
  asset_turnover: number | null;    // x
  equity_multiplier: number | null; // x
  roe: number | null;               // % (reconstructed 3-step)
  // 5-step
  tax_burden: number | null;        // ratio
  interest_burden: number | null;   // ratio
  operating_margin: number | null;  // %
  roe_5step: number | null;         // %
  // reconciliation
  roe_actual: number | null;        // % NI/Equity
  tie: boolean;
  tie_5step: boolean | null;
}
interface DupontContribution {
  factor: string;
  kind: "margin" | "efficiency" | "leverage" | string;
  contribution_pct: number | null;
}
interface DupontAttribution {
  dominant: string | null;
  verdict: string;
  roe_change_pct: number | null;
  contributions: DupontContribution[];
  direction: "up" | "down" | "flat" | string;
}
interface DupontResponse {
  symbol: string;
  years: DupontYear[];
  attribution: DupontAttribution;
  latest_roe: number | null;
  identity_holds: boolean;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: DupontResponse = {
  symbol: "AAPL",
  years: [
    { year: "2025", net_margin: 26.9, asset_turnover: 1.158, equity_multiplier: 4.87, roe: 151.9, tax_burden: 0.844, interest_burden: 0.998, operating_margin: 32.0, roe_5step: 151.9, roe_actual: 151.9, tie: true, tie_5step: true },
    { year: "2024", net_margin: 24.0, asset_turnover: 1.071, equity_multiplier: 6.41, roe: 164.6, tax_burden: 0.759, interest_burden: 1.002, operating_margin: 31.5, roe_5step: 164.6, roe_actual: 164.6, tie: true, tie_5step: true },
    { year: "2023", net_margin: 25.3, asset_turnover: 1.087, equity_multiplier: 5.67, roe: 156.1, tax_burden: 0.853, interest_burden: 0.995, operating_margin: 31.0, roe_5step: 156.1, roe_actual: 156.1, tie: true, tie_5step: true },
    { year: "2022", net_margin: 25.3, asset_turnover: 1.120, equity_multiplier: 6.18, roe: 175.0, tax_burden: 0.866, interest_burden: 0.993, operating_margin: 30.3, roe_5step: 175.0, roe_actual: 175.0, tie: true, tie_5step: true },
  ],
  attribution: {
    dominant: "Net Margin",
    verdict: "ROE fell 12.7pts YoY - efficiency-driven, dragged by a lower asset turnover.",
    roe_change_pct: -12.7,
    contributions: [
      { factor: "Net Margin", kind: "margin", contribution_pct: 41.2 },
      { factor: "Asset Turnover", kind: "efficiency", contribution_pct: 33.5 },
      { factor: "Equity Multiplier", kind: "leverage", contribution_pct: 25.3 },
    ],
    direction: "down",
  },
  latest_roe: 151.9,
  identity_holds: true,
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// ── Step metadata ────────────────────────────────────────────────────────────
const KIND_COLOR: Record<string, string> = {
  margin: "text-accent-blue",
  efficiency: "text-accent-amber",
  leverage: "text-accent-green",
};
const KIND_BAR: Record<string, string> = {
  margin: "bg-accent-blue",
  efficiency: "bg-accent-amber",
  leverage: "bg-accent-green",
};

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtPct(x: number | null, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits) + "%";
}
function fmtX(x: number | null, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits) + "x";
}
function fmtRatio(x: number | null, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits);
}
function roeColor(x: number | null): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "text-terminal-muted";
  if (x >= 20) return "text-accent-green";
  if (x >= 10) return "text-accent-blue";
  if (x >= 0) return "text-accent-amber";
  return "text-accent-red";
}

export function DupontRoePanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [mode, setMode] = useState<"three" | "five">("three");
  const [data, setData] = useState<DupontResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/dupont-roe/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: DupontResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.years) && json.years.length) {
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

  const years = data.years;
  const dominant = data.attribution.dominant;

  // ROE high-water mark for the trend bar.
  const roeMax = useMemo(() => {
    const vals = years.map((y) => Math.abs(y.roe ?? 0));
    return Math.max(1, ...vals);
  }, [years]);

  const arrow =
    data.attribution.direction === "up" ? "▲"
      : data.attribution.direction === "down" ? "▼"
      : "▬";
  const arrowColor =
    data.attribution.direction === "up" ? "text-accent-green"
      : data.attribution.direction === "down" ? "text-accent-red"
      : "text-terminal-muted";

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>DUPONT ROE</span>
        <span className="text-[10px] font-mono text-terminal-dim">
          Margin x Turnover x Leverage
        </span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
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
            Decompose
          </button>
          {/* 3-step / 5-step toggle */}
          <div className="ml-auto flex items-center border border-terminal-border rounded overflow-hidden">
            <button
              onClick={() => setMode("three")}
              className={`px-2.5 py-1 text-[11px] font-mono uppercase transition-colors ${
                mode === "three" ? "bg-accent/15 text-accent" : "text-terminal-muted hover:text-accent"
              }`}
            >
              3-step
            </button>
            <button
              onClick={() => setMode("five")}
              className={`px-2.5 py-1 text-[11px] font-mono uppercase transition-colors border-l border-terminal-border ${
                mode === "five" ? "bg-accent/15 text-accent" : "text-terminal-muted hover:text-accent"
              }`}
            >
              5-step
            </button>
          </div>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Hero: latest ROE + verdict */}
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-4 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Latest ROE - {years[0]?.year ?? "--"}
            </div>
            <div className="flex items-end gap-1">
              <span className={`stat-figure leading-none tabular-nums ${roeColor(data.latest_roe)}`}>
                {data.latest_roe === null ? "n/a" : data.latest_roe.toFixed(1)}
              </span>
              <span className="text-terminal-dim font-mono text-sm mb-1">%</span>
            </div>
            <div className={`text-xs font-mono uppercase tracking-wide flex items-center gap-1 ${arrowColor}`}>
              <span>{arrow}</span>
              <span>
                {data.attribution.roe_change_pct === null
                  ? "no YoY"
                  : `${data.attribution.roe_change_pct >= 0 ? "+" : ""}${data.attribution.roe_change_pct.toFixed(1)}pts YoY`}
              </span>
            </div>
          </div>

          <div className="col-span-8 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-center">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
              Driver Read
            </div>
            <div className="text-xs text-terminal-text font-sans leading-relaxed border-l-2 border-accent pl-3">
              {data.attribution.verdict}
            </div>
            {data.attribution.dominant && (
              <div className="mt-2 text-[10px] font-mono uppercase text-terminal-dim">
                Dominant factor:{" "}
                <span className={KIND_COLOR[data.attribution.contributions.find((c) => c.factor === dominant)?.kind ?? ""] ?? "text-accent"}>
                  {data.attribution.dominant}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Driver attribution bars (latest vs prior) */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            YoY Contribution to ROE Change
          </div>
          <div className="space-y-1.5">
            {data.attribution.contributions.map((c) => {
              const isDom = c.factor === dominant;
              const pct = c.contribution_pct ?? 0;
              return (
                <div key={c.factor} className="flex items-center gap-2">
                  <span className={`w-36 shrink-0 text-[11px] font-sans truncate ${isDom ? "text-terminal-text font-semibold" : "text-terminal-muted"}`}>
                    {c.factor}
                    {isDom && <span className="ml-1 text-[9px] uppercase text-accent">lead</span>}
                  </span>
                  <div className="flex-1 h-2 bg-terminal-panel rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${KIND_BAR[c.kind] ?? "bg-accent"} ${isDom ? "" : "opacity-50"}`}
                      style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right font-mono tabular-nums text-xs text-terminal-text">
                    {c.contribution_pct === null ? "n/a" : `${pct.toFixed(0)}%`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Year-by-year decomposition table */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>{mode === "three" ? "3-Step Decomposition" : "5-Step Decomposition"}</span>
            <span className="text-terminal-dim">= ROE</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono tabular-nums border-collapse">
              <thead>
                <tr className="text-[10px] uppercase text-terminal-dim border-b border-terminal-divider">
                  <th className="text-left font-normal py-1 pr-2">FY</th>
                  {mode === "three" ? (
                    <>
                      <th className="text-right font-normal py-1 px-2">Net Margin</th>
                      <th className="text-center font-normal py-1 px-1">×</th>
                      <th className="text-right font-normal py-1 px-2">Asset Turn</th>
                      <th className="text-center font-normal py-1 px-1">×</th>
                      <th className="text-right font-normal py-1 px-2">Equity Mult</th>
                    </>
                  ) : (
                    <>
                      <th className="text-right font-normal py-1 px-2">Tax Brd</th>
                      <th className="text-right font-normal py-1 px-2">Int Brd</th>
                      <th className="text-right font-normal py-1 px-2">Op Margin</th>
                      <th className="text-right font-normal py-1 px-2">Asset Turn</th>
                      <th className="text-right font-normal py-1 px-2">Equity Mult</th>
                    </>
                  )}
                  <th className="text-center font-normal py-1 px-1">=</th>
                  <th className="text-right font-normal py-1 pl-2">ROE</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => {
                  const shownRoe = mode === "three" ? y.roe : y.roe_5step;
                  const tied = mode === "three" ? y.tie : (y.tie_5step ?? false);
                  const domCol = (kind: string) =>
                    dominant &&
                    data.attribution.contributions.find((c) => c.factor === dominant)?.kind === kind;
                  return (
                    <tr key={y.year} className="border-b border-terminal-divider/60">
                      <td className="text-left py-1 pr-2 text-terminal-muted">{y.year}</td>
                      {mode === "three" ? (
                        <>
                          <td className={`text-right py-1 px-2 ${domCol("margin") ? "text-accent-blue font-semibold" : "text-terminal-text"}`}>{fmtPct(y.net_margin)}</td>
                          <td className="text-center py-1 px-1 text-terminal-dim">×</td>
                          <td className={`text-right py-1 px-2 ${domCol("efficiency") ? "text-accent-amber font-semibold" : "text-terminal-text"}`}>{fmtX(y.asset_turnover)}</td>
                          <td className="text-center py-1 px-1 text-terminal-dim">×</td>
                          <td className={`text-right py-1 px-2 ${domCol("leverage") ? "text-accent-green font-semibold" : "text-terminal-text"}`}>{fmtX(y.equity_multiplier)}</td>
                        </>
                      ) : (
                        <>
                          <td className="text-right py-1 px-2 text-terminal-text">{fmtRatio(y.tax_burden)}</td>
                          <td className="text-right py-1 px-2 text-terminal-text">{fmtRatio(y.interest_burden)}</td>
                          <td className="text-right py-1 px-2 text-terminal-text">{fmtPct(y.operating_margin)}</td>
                          <td className="text-right py-1 px-2 text-terminal-text">{fmtX(y.asset_turnover)}</td>
                          <td className="text-right py-1 px-2 text-terminal-text">{fmtX(y.equity_multiplier)}</td>
                        </>
                      )}
                      <td className="text-center py-1 px-1 text-terminal-dim">=</td>
                      <td className={`text-right py-1 pl-2 font-semibold ${roeColor(shownRoe)}`}>
                        {fmtPct(shownRoe)}
                        {!tied && <span className="ml-1 text-accent-red text-[9px]" title="identity off">!</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ROE trend sparkbars (oldest -> latest) */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1">
            ROE Trend (oldest to latest)
          </div>
          <div className="flex items-end gap-2 h-16">
            {[...years].reverse().map((y) => {
              const h = Math.max(4, (Math.abs(y.roe ?? 0) / roeMax) * 100);
              return (
                <div key={y.year} className="flex-1 flex flex-col items-center justify-end gap-1">
                  <span className={`text-[9px] font-mono tabular-nums ${roeColor(y.roe)}`}>
                    {y.roe === null ? "n/a" : y.roe.toFixed(0)}
                  </span>
                  <div className="w-full bg-terminal-panel rounded-sm overflow-hidden flex items-end" style={{ height: "100%" }}>
                    <div
                      className={`w-full rounded-sm ${(y.roe ?? 0) < 0 ? "bg-accent-red" : "bg-accent-blue"}`}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-terminal-dim">{y.year}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer: identity status + legend */}
        <div className="mt-auto flex items-center gap-3 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span className={data.identity_holds ? "text-accent-green" : "text-accent-amber"}>
            {data.identity_holds ? "✓ identity ties" : "! partial"}
          </span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-blue" /> margin</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-amber" /> efficiency</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-green" /> leverage</span>
          <span className="ml-auto">ROE = NM × AT × EM</span>
        </div>
      </div>
    </div>
  );
}
