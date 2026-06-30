import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// Local types (decoupled from api/types.ts on purpose)

interface CorrToDxy {
  symbol: string;
  corr: number | null;
  cluster: string; // "with_usd" | "against_usd" | "neutral"
}

interface PairExtreme {
  a: string;
  b: string;
  corr: number;
}

interface FxCorrelationResponse {
  symbols: string[];
  matrix: (number | null)[][];
  corr_to_dxy: CorrToDxy[];
  clusters: { with_usd: string[]; against_usd: string[] };
  most_correlated: PairExtreme | null;
  most_anticorrelated: PairExtreme | null;
  regime: string;
  regime_read: string;
  window: number;
  anchor: string;
  data_mode: string;
  as_of: string;
  source: string;
}

const WINDOWS = [30, 60, 90];
const ANCHOR = "DXY";

// Diverging heatmap fill: green for positive correlation, red for negative,
// alpha scaled by magnitude. Diagonal (corr===1 on its own cell) reads muted.
function cellStyle(c: number | null, isDiagonal: boolean): CSSProperties {
  if (isDiagonal) {
    return { backgroundColor: "rgba(138,129,117,0.18)", color: "#a59c8e" };
  }
  if (c === null || Number.isNaN(c)) {
    return { backgroundColor: "transparent", color: "#6f675b" };
  }
  const t = Math.max(0, Math.min(1, Math.abs(c)));
  const alpha = (0.08 + t * 0.62).toFixed(3);
  const rgb = c >= 0 ? "95,148,96" : "194,96,63"; // ink-green / clay-red
  return {
    backgroundColor: `rgba(${rgb},${alpha})`,
    color: t > 0.45 ? "#ece6da" : "#a59c8e",
  };
}

function corrColor(c: number | null): string {
  if (c === null || Number.isNaN(c)) return "#6f675b";
  if (c >= 0.15) return "#5f9460";
  if (c <= -0.15) return "#c2603f";
  return "#a59c8e";
}

function fmtCorr(c: number | null): string {
  if (c === null || Number.isNaN(c)) return "--";
  return c.toFixed(2);
}

// Short header label — strip USD from the majors so the grid stays narrow.
function shortLabel(sym: string): string {
  return sym;
}

// Local fallback so the panel renders fully populated, even offline. Mirrors the
// backend single-factor sample structure (DXY ~ -EUR, EUR/GBP high positive, the
// USDxxx block positive together, the risk pairs negative against the dollar).
const FALLBACK: FxCorrelationResponse = (() => {
  const symbols = [
    "DXY", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
    "USDCHF", "NZDUSD", "EURJPY", "EURGBP", "USDMXN", "USDCNH",
  ];
  const load: Record<string, number> = {
    DXY: 1.0, EURUSD: -0.95, GBPUSD: -0.88, USDJPY: 0.7, AUDUSD: -0.82,
    USDCAD: 0.74, USDCHF: 0.86, NZDUSD: -0.8, EURJPY: -0.22, EURGBP: -0.12,
    USDMXN: 0.62, USDCNH: 0.58,
  };
  const n = symbols.length;
  const matrix: (number | null)[][] = symbols.map((_, i) =>
    symbols.map((_, j) =>
      i === j ? 1.0 : Math.round(Math.max(-0.99, Math.min(0.99, load[symbols[i]] * load[symbols[j]])) * 1000) / 1000
    )
  );
  const di = 0; // DXY row
  const corr_to_dxy: CorrToDxy[] = symbols
    .filter((s) => s !== "DXY")
    .map((s) => {
      const c = matrix[di][symbols.indexOf(s)];
      return {
        symbol: s,
        corr: c,
        cluster: c! >= 0.15 ? "with_usd" : c! <= -0.15 ? "against_usd" : "neutral",
      };
    })
    .sort((a, b) => (b.corr ?? 0) - (a.corr ?? 0));

  let mc: PairExtreme | null = null;
  let ma: PairExtreme | null = null;
  for (let i = 0; i < n; i++) {
    if (symbols[i] === "DXY") continue;
    for (let j = i + 1; j < n; j++) {
      if (symbols[j] === "DXY") continue;
      const c = matrix[i][j]!;
      if (!mc || c > mc.corr) mc = { a: symbols[i], b: symbols[j], corr: c };
      if (!ma || c < ma.corr) ma = { a: symbols[i], b: symbols[j], corr: c };
    }
  }

  return {
    symbols,
    matrix,
    corr_to_dxy,
    clusters: {
      with_usd: corr_to_dxy.filter((r) => r.cluster === "with_usd").map((r) => r.symbol),
      against_usd: corr_to_dxy.filter((r) => r.cluster === "against_usd").map((r) => r.symbol),
    },
    most_correlated: mc,
    most_anticorrelated: ma,
    regime: "risk-on (USD soft)",
    regime_read:
      "Tight single-factor tape with the risk bloc strongly short the dollar — pro-risk, USD on the back foot.",
    window: 60,
    anchor: "DXY",
    data_mode: "sample",
    as_of: "",
    source: "single-factor FX correlation sample",
  };
})();

export function FxCorrelationPanel() {
  const [data, setData] = useState<FxCorrelationResponse>(FALLBACK);
  const [window, setWindow] = useState(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetch(`/api/fx-correlation?window=${window}`)
      .then((res) => res.json())
      .then((json: FxCorrelationResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.symbols) && json.symbols.length > 0) {
          setData(json);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [window]);

  const { symbols, matrix, corr_to_dxy, most_correlated, most_anticorrelated } = data;

  const gridCols = useMemo(
    () => `64px repeat(${symbols.length}, minmax(0, 1fr))`,
    [symbols.length]
  );

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>FX CORRELATION MATRIX</span>
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-terminal-dim normal-case tracking-normal">Loading...</span>
          )}
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-1.5 py-0.5 rounded text-2xs font-mono tabular-nums border ${
                  window === w
                    ? "border-accent-clay text-terminal-text bg-terminal-bg"
                    : "border-terminal-border/50 text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {error && (
          <div className="bg-terminal-bg border border-accent-red/40 rounded p-2 text-2xs text-accent-red">
            Live feed unavailable — showing the most recent populated matrix.
          </div>
        )}

        {/* Regime read */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-2xs text-terminal-dim uppercase tracking-wider">Regime</span>
            <span className="font-mono text-xs font-semibold" style={{ color: regimeColor(data.regime) }}>
              {data.regime}
            </span>
            <span className="text-2xs text-terminal-dim normal-case">
              · {window}d window · anchor {data.anchor || ANCHOR}
            </span>
          </div>
          <p className="text-sm text-terminal-text font-serif leading-snug">{data.regime_read}</p>
        </div>

        {/* Callouts */}
        <div className="grid grid-cols-2 gap-2">
          <Callout
            label="Most correlated"
            pair={most_correlated}
            tone="#5f9460"
          />
          <Callout
            label="Most anti-correlated"
            pair={most_anticorrelated}
            tone="#c2603f"
          />
        </div>

        {/* HERO: correlation heatmap */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="overflow-x-auto">
            <div style={{ minWidth: 520 }}>
              {/* Column header */}
              <div className="grid gap-0.5 mb-0.5" style={{ gridTemplateColumns: gridCols }}>
                <div />
                {symbols.map((s) => (
                  <div
                    key={s}
                    className="text-2xs text-terminal-muted uppercase tracking-tight text-center truncate"
                    title={s}
                  >
                    {shortLabel(s)}
                  </div>
                ))}
              </div>

              {symbols.map((rowSym, i) => (
                <div key={rowSym} className="grid gap-0.5 mb-0.5" style={{ gridTemplateColumns: gridCols }}>
                  <div className="text-2xs font-mono text-terminal-text font-semibold flex items-center pr-1 truncate" title={rowSym}>
                    {rowSym}
                  </div>
                  {symbols.map((colSym, j) => {
                    const c = matrix[i]?.[j] ?? null;
                    return (
                      <div
                        key={colSym}
                        className="flex items-center justify-center rounded-sm font-mono tabular-nums text-2xs py-1"
                        style={cellStyle(c, i === j)}
                        title={`${rowSym} / ${colSym}: ${fmtCorr(c)}`}
                      >
                        {i === j ? "" : fmtCorr(c)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 mt-2 text-2xs text-terminal-dim">
            <LegendSwatch color="rgba(95,148,96,0.65)" label="Positive" />
            <LegendSwatch color="rgba(138,129,117,0.2)" label="Diagonal" />
            <LegendSwatch color="rgba(194,96,63,0.65)" label="Negative" />
          </div>
        </div>

        {/* Correlation-to-DXY list */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2.5">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1.5">
            Correlation to {data.anchor || ANCHOR} (USD beta)
          </div>
          <div className="flex flex-col gap-0.5">
            {corr_to_dxy.map((r) => (
              <div
                key={r.symbol}
                className="grid items-center gap-2 py-0.5"
                style={{ gridTemplateColumns: "72px 1fr 44px 64px" }}
              >
                <span className="font-mono text-xs text-terminal-text">{r.symbol}</span>
                <CorrBar corr={r.corr} />
                <span
                  className="font-mono tabular-nums text-xs text-right"
                  style={{ color: corrColor(r.corr) }}
                >
                  {fmtCorr(r.corr)}
                </span>
                <span className="text-2xs text-terminal-dim text-right normal-case">
                  {clusterLabel(r.cluster)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function CorrBar({ corr }: { corr: number | null }) {
  if (corr === null || Number.isNaN(corr)) {
    return <div className="h-1.5 rounded-full bg-terminal-border/30" />;
  }
  const t = Math.max(0, Math.min(1, Math.abs(corr)));
  const pct = (t * 50).toFixed(1); // half-width bar from the centre
  const positive = corr >= 0;
  return (
    <div className="relative h-1.5 rounded-full bg-terminal-border/25">
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-terminal-divider" />
      <div
        className="absolute top-0 bottom-0 rounded-full"
        style={{
          width: `${pct}%`,
          left: positive ? "50%" : undefined,
          right: positive ? undefined : "50%",
          backgroundColor: positive ? "rgba(95,148,96,0.75)" : "rgba(194,96,63,0.75)",
        }}
      />
    </div>
  );
}

function Callout({ label, pair, tone }: { label: string; pair: PairExtreme | null; tone: string }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <div className="text-2xs text-terminal-dim uppercase tracking-wider">{label}</div>
      {pair ? (
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="font-mono text-sm text-terminal-text truncate">
            {pair.a} / {pair.b}
          </span>
          <span className="font-mono tabular-nums text-base font-semibold shrink-0" style={{ color: tone }}>
            {pair.corr.toFixed(2)}
          </span>
        </div>
      ) : (
        <span className="font-mono text-sm text-terminal-dim">--</span>
      )}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-terminal-dim">
      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function regimeColor(regime: string): string {
  const r = regime.toLowerCase();
  if (r.includes("risk-on")) return "#5f9460";
  if (r.includes("risk-off")) return "#c2603f";
  if (r.includes("idiosyncratic")) return "#c9a24a";
  return "#84934f";
}

function clusterLabel(cluster: string): string {
  if (cluster === "with_usd") return "with USD";
  if (cluster === "against_usd") return "vs USD";
  return "neutral";
}
