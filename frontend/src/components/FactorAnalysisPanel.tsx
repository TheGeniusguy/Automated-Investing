import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";

// ── Types (LOCAL mirror of the backend factor-analysis payload) ───────────────
// Mirrored here so this panel is self-contained. The wiring agent adds the
// matching interface to api/types.ts and the api.factors() client method.

interface FactorBeta {
  factor: string;
  name: string;
  beta: number;
}

interface FactorPerf {
  factor: string;
  name: string;
  return_pct: number;
}

interface StyleBox {
  // x: value (-1) .. growth (+1); y: small (-1) .. large (+1)
  x: number;
  y: number;
}

interface FactorAnalysisResponse {
  symbol: string;
  betas: FactorBeta[];
  r2: number | null;
  alpha_pct: number | null;
  factor_perf: FactorPerf[];
  style_box: StyleBox;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// The wiring agent owns api/client.ts and adds `api.factors`. Access it through
// a narrow typed view so this panel type-checks on its own.
const factorsApi = api as unknown as {
  factors: (symbol: string) => Promise<FactorAnalysisResponse>;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function FactorAnalysisPanel() {
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");

  const [data, setData] = useState<FactorAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    factorsApi
      .factors(symbol)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = symbolInput.trim().toUpperCase();
    if (!s) {
      setErr("Enter a symbol.");
      return;
    }
    setSymbol(s);
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Factor Analysis</span>
        {data && (
          <span className="text-terminal-dim normal-case tracking-normal">{data.symbol}</span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5">
            <span className="text-2xs text-terminal-dim uppercase">Symbol</span>
            <input
              type="text"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="AAPL"
              className="w-24 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-black disabled:opacity-40"
          >
            {loading ? "Loading..." : "Run"}
          </button>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">Running factor regression...</div>
        )}

        {data && (
          <>
            {/* Alpha + R2 hero */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3">
                <div className="text-2xs text-terminal-dim uppercase tracking-wider">
                  Annualized Alpha
                </div>
                <div className={`stat-figure text-3xl mt-0.5 ${colorBySign(data.alpha_pct)}`}>
                  {fmtSignedPct(data.alpha_pct)}
                </div>
                <div className="text-2xs text-terminal-dim mt-0.5">vs factor model</div>
              </div>
              <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3">
                <div className="text-2xs text-terminal-dim uppercase tracking-wider">
                  Model Fit (R2)
                </div>
                <div className="stat-figure text-3xl mt-0.5 text-accent-blue">
                  {data.r2 != null && !Number.isNaN(data.r2) ? data.r2.toFixed(3) : "--"}
                </div>
                <div className="text-2xs text-terminal-dim mt-0.5">variance explained</div>
              </div>
            </div>

            {/* Factor betas (diverging bars around zero) */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Factor Beta
              </div>
              {data.betas.length === 0 ? (
                <div className="text-2xs text-terminal-dim py-2">No factor exposures.</div>
              ) : (
                <FactorBetaBars betas={data.betas} />
              )}
            </div>

            {/* Style box */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Style Box
              </div>
              <StyleBoxGrid box={data.style_box} symbol={data.symbol} />
            </div>

            {/* Factor performance */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Factor Performance
              </div>
              {data.factor_perf.length === 0 ? (
                <div className="text-2xs text-terminal-dim py-2">No factor performance data.</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {data.factor_perf.map((p) => (
                    <div
                      key={p.factor}
                      className="flex items-center justify-between border-t border-terminal-border/20 py-1 first:border-t-0"
                    >
                      <span className="text-xs text-terminal-text">{p.name}</span>
                      <span
                        className={`text-xs font-mono tabular-nums font-semibold ${colorBySign(
                          p.return_pct,
                        )}`}
                      >
                        {fmtSignedPct(p.return_pct)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Factor beta diverging bars ────────────────────────────────────────────────
// Zero sits at the horizontal center. Positive betas extend right (green),
// negative extend left (red).

function FactorBetaBars({ betas }: { betas: FactorBeta[] }) {
  const maxAbs = useMemo(
    () => Math.max(...betas.map((b) => Math.abs(b.beta)), 0.001),
    [betas],
  );

  return (
    <div className="flex flex-col gap-1.5">
      {betas.map((b) => {
        const pct = Math.min(100, (Math.abs(b.beta) / maxAbs) * 100);
        const isPos = b.beta >= 0;
        return (
          <div key={b.factor} className="flex items-center gap-2 text-xs">
            <span className="w-28 text-right text-terminal-muted text-2xs uppercase truncate" title={b.name}>
              {b.name}
            </span>
            {/* Two half-tracks meeting at a center axis */}
            <div className="flex-1 flex items-center h-4">
              <div className="flex-1 h-4 flex justify-end overflow-hidden">
                {!isPos && (
                  <div
                    className="h-full rounded-l bg-accent-red/60"
                    style={{ width: `${pct}%` }}
                  />
                )}
              </div>
              <div className="w-px h-4 bg-terminal-border" />
              <div className="flex-1 h-4 flex justify-start overflow-hidden">
                {isPos && (
                  <div
                    className="h-full rounded-r bg-accent-green/60"
                    style={{ width: `${pct}%` }}
                  />
                )}
              </div>
            </div>
            <span
              className={`w-14 text-right tabular-nums text-2xs font-semibold ${
                isPos ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {isPos ? "+" : ""}
              {b.beta.toFixed(3)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Style box (value-growth x small-large quadrant grid) ──────────────────────

const STYLE_COLS = ["Value", "Blend", "Growth"];
const STYLE_ROWS = ["Large", "Mid", "Small"]; // top to bottom

function StyleBoxGrid({ box, symbol }: { box: StyleBox; symbol: string }) {
  // x: value(-1) .. growth(+1)  -> 0%..100% left-to-right
  // y: small(-1) .. large(+1)   -> large at top, small at bottom
  const cx = ((clamp(box.x, -1, 1) + 1) / 2) * 100;
  const cy = ((1 - clamp(box.y, -1, 1)) / 2) * 100; // invert: +1 (large) -> top

  const colLabel = STYLE_COLS[Math.min(2, Math.max(0, Math.floor(((clamp(box.x, -1, 1) + 1) / 2) * 3 - 1e-9)))];
  const rowLabel = STYLE_ROWS[Math.min(2, Math.max(0, Math.floor(((1 - clamp(box.y, -1, 1)) / 2) * 3 - 1e-9)))];

  return (
    <div className="flex flex-col gap-2 items-center">
      <div className="relative w-48 h-48">
        {/* 3x3 quadrant grid */}
        <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
          {STYLE_ROWS.map((row) =>
            STYLE_COLS.map((col) => {
              const active = row === rowLabel && col === colLabel;
              return (
                <div
                  key={`${row}-${col}`}
                  className={`border border-terminal-border/40 flex items-center justify-center ${
                    active ? "bg-accent/15" : "bg-terminal-panel/30"
                  }`}
                >
                  <span className="text-[0.55rem] text-terminal-dim uppercase tracking-wide text-center leading-none">
                    {row}
                    <br />
                    {col}
                  </span>
                </div>
              );
            }),
          )}
        </div>

        {/* Symbol marker */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${cx}%`, top: `${cy}%` }}
          title={`${symbol}: x ${box.x.toFixed(2)}, y ${box.y.toFixed(2)}`}
        >
          <div className="w-3 h-3 rounded-full bg-accent ring-2 ring-terminal-bg shadow-panel" />
          <div className="absolute left-1/2 top-3.5 -translate-x-1/2 text-[0.6rem] font-mono text-terminal-text whitespace-nowrap">
            {symbol}
          </div>
        </div>
      </div>

      {/* Axis labels */}
      <div className="flex justify-between w-48 text-2xs text-terminal-dim uppercase">
        <span>Value</span>
        <span>Growth</span>
      </div>
      <div className="text-2xs text-terminal-muted">
        Size: small to large (vertical) / Style: value to growth (horizontal)
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  if (v == null || Number.isNaN(v)) return 0;
  return Math.min(hi, Math.max(lo, v));
}

function colorBySign(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtSignedPct(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
