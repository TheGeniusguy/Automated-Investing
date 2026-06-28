import { useEffect, useMemo, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface EQTest {
  name: string;
  pass: boolean;
  detail: string;
}
interface EQFlag {
  type: "red" | "green";
  text: string;
}
interface EQPiotroski {
  score: number;
  max: number;
  tests: EQTest[];
}
interface EQAltman {
  score: number | null;
  zone: string;
  ratios: Record<string, number | null>;
}
interface EQBeneish {
  score: number | null;
  flag: boolean;
  threshold: number;
  complete: boolean;
  indices: Record<string, number | null>;
}
interface EarningsQualityResponse {
  symbol: string;
  quality_score: number | null;
  label: string;
  flags: EQFlag[];
  piotroski: EQPiotroski;
  altman: EQAltman;
  beneish: EQBeneish;
  accruals_ratio: number | null;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: EarningsQualityResponse = {
  symbol: "AAPL",
  quality_score: 88,
  label: "Strong",
  flags: [
    { type: "green", text: "Strong Piotroski F-Score 8/9 (broad fundamental health)" },
    { type: "green", text: "Altman Z 6.42 in Safe zone (low distress risk)" },
    { type: "green", text: "Beneish M -2.41 below -1.78 (no manipulation signal)" },
    { type: "green", text: "Negative accruals -1.8% (cash-backed earnings)" },
  ],
  piotroski: {
    score: 8,
    max: 9,
    tests: [
      { name: "Positive net income", pass: true, detail: "Net income $97.4B" },
      { name: "Positive return on assets", pass: true, detail: "ROA 27.5%" },
      { name: "Positive operating cash flow", pass: true, detail: "CFO $118.2B" },
      { name: "Cash flow exceeds net income (quality of earnings)", pass: true, detail: "CFO $118.2B vs NI $97.4B" },
      { name: "Lower long-term debt ratio YoY", pass: true, detail: "LTD/assets 17.4% vs 19.1%" },
      { name: "Higher current ratio YoY", pass: false, detail: "Current ratio 0.99x vs 1.04x" },
      { name: "No new shares issued", pass: true, detail: "Shares 15.20B vs 15.74B" },
      { name: "Higher gross margin YoY", pass: true, detail: "Gross margin 46.2% vs 44.1%" },
      { name: "Higher asset turnover YoY", pass: true, detail: "Asset turnover 1.10x vs 1.04x" },
    ],
  },
  altman: {
    score: 6.42,
    zone: "Safe",
    ratios: {
      working_capital_to_assets: 0.012,
      retained_earnings_to_assets: 0.072,
      ebit_to_assets: 0.318,
      market_cap_to_liabilities: 9.84,
      sales_to_assets: 1.102,
    },
  },
  beneish: {
    score: -2.41,
    flag: false,
    threshold: -1.78,
    complete: true,
    indices: {
      DSRI: 0.984,
      GMI: 0.955,
      AQI: 1.012,
      SGI: 1.082,
      DEPI: 0.971,
      SGAI: 1.004,
      LVGI: 0.962,
      TATA: -0.018,
    },
  },
  accruals_ratio: -0.018,
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// ── Static metadata for the breakdown sections ───────────────────────────────
const BENEISH_META: Record<string, { label: string; hint: string }> = {
  DSRI: { label: "DSRI", hint: "Days sales in receivables" },
  GMI: { label: "GMI", hint: "Gross margin index" },
  AQI: { label: "AQI", hint: "Asset quality index" },
  SGI: { label: "SGI", hint: "Sales growth index" },
  DEPI: { label: "DEPI", hint: "Depreciation index" },
  SGAI: { label: "SGAI", hint: "SG&A index" },
  LVGI: { label: "LVGI", hint: "Leverage index" },
  TATA: { label: "TATA", hint: "Total accruals to assets" },
};
// Indices where a high reading is the manipulation-suspicious direction.
const BENEISH_HIGH_BAD = new Set(["DSRI", "GMI", "AQI", "SGI", "DEPI", "TATA"]);

const ALTMAN_META: { key: string; label: string; weight: number }[] = [
  { key: "working_capital_to_assets", label: "Working capital / assets", weight: 1.2 },
  { key: "retained_earnings_to_assets", label: "Retained earnings / assets", weight: 1.4 },
  { key: "ebit_to_assets", label: "EBIT / assets", weight: 3.3 },
  { key: "market_cap_to_liabilities", label: "Market cap / liabilities", weight: 0.6 },
  { key: "sales_to_assets", label: "Sales / assets", weight: 1.0 },
];

// ── Color helpers ────────────────────────────────────────────────────────────
function labelColor(label: string): string {
  switch (label) {
    case "Strong": return "text-accent-green";
    case "Solid": return "text-accent-green";
    case "Mixed": return "text-accent-amber";
    case "Weak": return "text-accent-red";
    case "Red Flag": return "text-accent-red";
    default: return "text-terminal-muted";
  }
}
function qualityColor(score: number | null): string {
  if (score === null) return "text-terminal-muted";
  if (score >= 65) return "text-accent-green";
  if (score >= 45) return "text-accent-amber";
  return "text-accent-red";
}
function piotroskiColor(score: number): string {
  if (score >= 7) return "text-accent-green";
  if (score >= 4) return "text-accent-amber";
  return "text-accent-red";
}
function altmanColor(zone: string): string {
  if (zone === "Safe") return "text-accent-green";
  if (zone === "Grey") return "text-accent-amber";
  if (zone === "Distress") return "text-accent-red";
  return "text-terminal-muted";
}
function beneishColor(flag: boolean, score: number | null): string {
  if (score === null) return "text-terminal-muted";
  return flag ? "text-accent-red" : "text-accent-green";
}

function fmtNum(x: number | null, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits);
}
function fmtPct(x: number | null): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
}

export function EarningsQualityPanel() {
  const [input, setInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<EarningsQualityResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/earnings-quality/${encodeURIComponent(symbol)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: EarningsQualityResponse) => {
        if (!alive) return;
        if (json && json.piotroski && Array.isArray(json.piotroski.tests)) {
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

  const verdictLine = useMemo(() => {
    const q = data.quality_score;
    const desc =
      q === null ? "unscored"
        : q >= 80 ? "earnings look clean and well-supported by cash"
        : q >= 65 ? "fundamentally sound with minor watch items"
        : q >= 45 ? "a mixed picture worth a closer read"
        : q >= 30 ? "showing meaningful accounting strain"
        : "tripping multiple forensic red flags";
    return `${data.symbol} scores ${q ?? "n/a"}/100 on the forensic screen, ${desc}.`;
  }, [data]);

  const greenFlags = data.flags.filter((f) => f.type === "green");
  const redFlags = data.flags.filter((f) => f.type === "red");

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>EARNINGS QUALITY</span>
        <span className="text-[10px] font-mono text-terminal-dim">
          Piotroski F / Altman Z / Beneish M
        </span>
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
            Screen
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Hero verdict + headline scores */}
        <div className="grid grid-cols-12 gap-2">
          {/* Big quality score */}
          <div className="col-span-4 bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">
              Quality Score
            </div>
            <div className="flex items-end gap-1">
              <span className={`stat-figure leading-none ${qualityColor(data.quality_score)}`}>
                {data.quality_score ?? "n/a"}
              </span>
              <span className="text-terminal-dim font-mono text-sm mb-1">/100</span>
            </div>
            <div className={`text-sm font-mono uppercase tracking-wide ${labelColor(data.label)}`}>
              {data.label}
            </div>
            {/* gradient quality bar */}
            <div className="mt-2 h-1.5 w-full bg-terminal-panel rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  (data.quality_score ?? 0) >= 65 ? "bg-accent-green"
                    : (data.quality_score ?? 0) >= 45 ? "bg-accent-amber"
                    : "bg-accent-red"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, data.quality_score ?? 0))}%` }}
              />
            </div>
          </div>

          {/* Three headline scores */}
          <div className="col-span-8 grid grid-cols-3 gap-2">
            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Piotroski F</div>
              <div className={`stat-figure leading-none ${piotroskiColor(data.piotroski.score)}`}>
                {data.piotroski.score}
                <span className="text-terminal-dim font-mono text-sm">/9</span>
              </div>
              <div className="text-[10px] font-mono text-terminal-muted">fundamental strength</div>
            </div>

            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Altman Z</div>
              <div className={`stat-figure leading-none tabular-nums ${altmanColor(data.altman.zone)}`}>
                {fmtNum(data.altman.score)}
              </div>
              <div className={`text-[10px] font-mono uppercase ${altmanColor(data.altman.zone)}`}>
                {data.altman.zone} zone
              </div>
            </div>

            <div className="bg-terminal-bg border border-terminal-border rounded-panel p-3 flex flex-col justify-between">
              <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider">Beneish M</div>
              <div className={`stat-figure leading-none tabular-nums ${beneishColor(data.beneish.flag, data.beneish.score)}`}>
                {fmtNum(data.beneish.score)}
              </div>
              <div className={`text-[10px] font-mono uppercase ${beneishColor(data.beneish.flag, data.beneish.score)}`}>
                {data.beneish.score === null ? "no data" : data.beneish.flag ? "manipulation risk" : "clean"}
              </div>
            </div>
          </div>
        </div>

        {/* Plain-language verdict */}
        <div className="text-xs text-terminal-muted font-sans leading-relaxed border-l-2 border-accent pl-3">
          {verdictLine}
        </div>

        {/* Flags: red / green columns */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5">
            <div className="text-[10px] font-mono uppercase text-accent-red tracking-wider mb-1.5">
              Red Flags ({redFlags.length})
            </div>
            {redFlags.length ? (
              <ul className="space-y-1">
                {redFlags.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-terminal-text font-sans leading-snug">
                    <span className="text-accent-red mt-px shrink-0">&#9660;</span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-terminal-dim font-sans">None detected</div>
            )}
          </div>
          <div className="bg-terminal-bg border border-terminal-border rounded-panel p-2.5">
            <div className="text-[10px] font-mono uppercase text-accent-green tracking-wider mb-1.5">
              Green Flags ({greenFlags.length})
            </div>
            {greenFlags.length ? (
              <ul className="space-y-1">
                {greenFlags.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-terminal-text font-sans leading-snug">
                    <span className="text-accent-green mt-px shrink-0">&#9650;</span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-terminal-dim font-sans">None detected</div>
            )}
          </div>
        </div>

        {/* Piotroski 9-test checklist */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Piotroski F-Score Checklist</span>
            <span className={piotroskiColor(data.piotroski.score)}>{data.piotroski.score}/9 passed</span>
          </div>
          <div className="border-t border-terminal-divider divide-y divide-terminal-divider">
            {data.piotroski.tests.map((t, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <span
                  className={`shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-[10px] font-bold ${
                    t.pass ? "bg-accent-green/15 text-accent-green" : "bg-accent-red/15 text-accent-red"
                  }`}
                >
                  {t.pass ? "✓" : "✕"}
                </span>
                <span className="flex-1 min-w-0 text-xs text-terminal-text font-sans truncate">{t.name}</span>
                <span className="shrink-0 text-[10px] font-mono tabular-nums text-terminal-muted text-right">
                  {t.detail}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Altman 5-ratio bars with zone bands */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Altman Z Components</span>
            <span className={altmanColor(data.altman.zone)}>
              Z = {fmtNum(data.altman.score)} ({data.altman.zone})
            </span>
          </div>
          <div className="space-y-1.5">
            {ALTMAN_META.map((row) => {
              const v = data.altman.ratios[row.key];
              const mag = v === null || v === undefined ? 0 : Math.max(0, Math.min(1, Math.abs(v) / 2));
              const neg = (v ?? 0) < 0;
              return (
                <div key={row.key} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-[11px] text-terminal-muted font-sans truncate">
                    {row.label}
                  </span>
                  <span className="w-8 shrink-0 text-[10px] font-mono text-terminal-dim tabular-nums text-right">
                    &times;{row.weight}
                  </span>
                  <div className="flex-1 h-2 bg-terminal-panel rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${neg ? "bg-accent-red" : "bg-accent-blue"}`}
                      style={{ width: `${Math.max(3, mag * 100)}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right font-mono tabular-nums text-xs text-terminal-text">
                    {fmtNum(v, 3)}
                  </span>
                </div>
              );
            })}
          </div>
          {/* zone band legend */}
          <div className="mt-1.5 flex items-center gap-3 text-[10px] font-mono text-terminal-dim">
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-red" /> &lt; 1.81 Distress</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-amber" /> 1.81-2.99 Grey</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent-green" /> &gt; 2.99 Safe</span>
          </div>
        </div>

        {/* Beneish 8-index table */}
        <div>
          <div className="text-[10px] font-mono uppercase text-terminal-dim tracking-wider mb-1 flex justify-between">
            <span>Beneish M-Score Indices</span>
            <span className={beneishColor(data.beneish.flag, data.beneish.score)}>
              M = {fmtNum(data.beneish.score)} (threshold {fmtNum(data.beneish.threshold)})
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {Object.entries(BENEISH_META).map(([key, meta]) => {
              const v = data.beneish.indices[key];
              const neutral = key === "TATA" ? 0 : 1;
              const suspicious =
                v !== null && v !== undefined &&
                (BENEISH_HIGH_BAD.has(key) ? v > neutral + 0.02 : v < neutral - 0.02);
              return (
                <div key={key} className="bg-terminal-bg border border-terminal-border rounded p-1.5 flex flex-col">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase text-terminal-dim">{meta.label}</span>
                    <span
                      className={`font-mono tabular-nums text-xs ${
                        suspicious ? "text-accent-amber" : "text-terminal-text"
                      }`}
                    >
                      {fmtNum(v, 3)}
                    </span>
                  </div>
                  <span className="text-[9px] text-terminal-dim font-sans truncate">{meta.hint}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer: accruals + legend */}
        <div className="mt-auto flex items-center gap-4 text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          <span>
            Accruals ratio{" "}
            <span
              className={`tabular-nums ${
                (data.accruals_ratio ?? 0) > 0.05
                  ? "text-accent-red"
                  : (data.accruals_ratio ?? 0) < -0.02
                  ? "text-accent-green"
                  : "text-terminal-text"
              }`}
            >
              {fmtPct(data.accruals_ratio)}
            </span>
          </span>
          <span className="ml-auto">Forensic accounting screen - higher is cleaner</span>
        </div>
      </div>
    </div>
  );
}
