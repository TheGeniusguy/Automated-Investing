import { useCallback, useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";

// ── Types ────────────────────────────────────────────────────────────────────

interface FactorExposure {
  factor: string;
  beta: number;
}

interface RiskResponse {
  var_95_daily_pct: number | null;
  cvar_95_daily_pct: number | null;
  var_99_daily_pct: number | null;
  cvar_99_daily_pct: number | null;
  var_95_annual_pct: number | null;
  portfolio_volatility_pct: number | null;
  position_betas: Record<string, number | null>;
  symbols: string[];
  correlation_matrix: Array<Array<number | null>>;
  factor_exposures: FactorExposure[];
  factor_r2: number | null;
  herfindahl: number | null;
  top3_concentration_pct: number | null;
  largest_position_pct: number | null;
  lookback_days: number;
  data_points: number;
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  portfolioId: number;
}

export function PortfolioRiskTab({ portfolioId }: Props) {
  const [data, setData] = useState<RiskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    (portfolioApi.risk(portfolioId, 252) as unknown as Promise<RiskResponse>)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [portfolioId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-4 text-terminal-dim text-xs text-center">Loading risk data...</div>;
  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!data) return null;

  const herfLabel =
    data.herfindahl == null ? "--"
    : data.herfindahl < 0.1 ? "Diversified"
    : data.herfindahl < 0.25 ? "Moderate"
    : "Concentrated";

  const herfColor =
    data.herfindahl == null ? "text-terminal-fg"
    : data.herfindahl < 0.1 ? "text-green-400"
    : data.herfindahl < 0.25 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="flex flex-col gap-3 p-3">

      {/* VaR / CVaR Stat Cards */}
      <div>
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
          Value at Risk (95% / 99% confidence) — Lookback: {data.lookback_days}d / {data.data_points} pts
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <RiskCard label="VaR 95% (Daily)" value={data.var_95_daily_pct} />
          <RiskCard label="CVaR 95% (Daily)" value={data.cvar_95_daily_pct} />
          <RiskCard label="VaR 99% (Daily)" value={data.var_99_daily_pct} />
          <RiskCard label="CVaR 99% (Daily)" value={data.cvar_99_daily_pct} />
          <RiskCard label="VaR 95% (Annual)" value={data.var_95_annual_pct} />
          <RiskCard label="Portfolio Vol" value={data.portfolio_volatility_pct} neutral />
        </div>
      </div>

      {/* Concentration Metrics */}
      <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Concentration</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="bg-terminal-panel border border-terminal-border/30 rounded p-2">
            <div className="text-2xs text-terminal-dim uppercase">Herfindahl Index</div>
            <div className={`text-sm font-semibold tabular-nums mt-0.5 ${herfColor}`}>
              {data.herfindahl != null ? data.herfindahl.toFixed(4) : "--"}
            </div>
            <div className={`text-2xs mt-0.5 ${herfColor}`}>{herfLabel}</div>
          </div>
          <div className="bg-terminal-panel border border-terminal-border/30 rounded p-2">
            <div className="text-2xs text-terminal-dim uppercase">Top 3 Weight</div>
            <div className="text-sm font-semibold tabular-nums mt-0.5 text-terminal-fg">
              {data.top3_concentration_pct != null ? `${data.top3_concentration_pct.toFixed(1)}%` : "--"}
            </div>
          </div>
          <div className="bg-terminal-panel border border-terminal-border/30 rounded p-2">
            <div className="text-2xs text-terminal-dim uppercase">Largest Position</div>
            <div className="text-sm font-semibold tabular-nums mt-0.5 text-terminal-fg">
              {data.largest_position_pct != null ? `${data.largest_position_pct.toFixed(1)}%` : "--"}
            </div>
          </div>
        </div>

        {/* Per-position beta table */}
        {Object.keys(data.position_betas).length > 0 && (
          <div className="mt-2">
            <div className="text-2xs text-terminal-dim uppercase mb-1">Position Betas (vs SPY)</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-terminal-dim text-2xs uppercase tracking-wide">
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-right py-1 px-2">Beta</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.position_betas).map(([sym, beta]) => (
                  <tr key={sym} className="border-t border-terminal-border/20">
                    <td className="py-1 px-2 font-mono text-terminal-fg">{sym}</td>
                    <td
                      className={`py-1 px-2 text-right tabular-nums ${
                        beta == null ? "text-terminal-dim"
                        : beta > 1.2 ? "text-red-400"
                        : beta < 0.8 ? "text-blue-400"
                        : "text-terminal-fg"
                      }`}
                    >
                      {beta != null ? beta.toFixed(2) : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Correlation Matrix Heatmap */}
      {data.symbols.length > 0 && (
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 overflow-auto">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">Correlation Matrix</div>
          <CorrelationHeatmap symbols={data.symbols} matrix={data.correlation_matrix} />
        </div>
      )}

      {/* Factor Exposure Bar Chart */}
      {data.factor_exposures.length > 0 && (
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
          <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-1">
            Factor Exposures
            {data.factor_r2 != null && (
              <span className="ml-2 text-terminal-dim normal-case">R² = {data.factor_r2.toFixed(3)}</span>
            )}
          </div>
          <FactorBars exposures={data.factor_exposures} />
        </div>
      )}
    </div>
  );
}

// ── VaR Stat Card ────────────────────────────────────────────────────────────

function RiskCard({
  label,
  value,
  neutral,
}: {
  label: string;
  value: number | null;
  neutral?: boolean;
}) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-dim uppercase leading-tight">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${neutral ? "text-terminal-fg" : "text-red-400"}`}>
        {value != null ? `${value.toFixed(2)}%` : "--"}
      </div>
    </div>
  );
}

// ── Correlation Heatmap ──────────────────────────────────────────────────────

function CorrelationHeatmap({
  symbols,
  matrix,
}: {
  symbols: string[];
  matrix: Array<Array<number | null>>;
}) {
  const n = symbols.length;

  return (
    <div className="inline-grid text-2xs" style={{ gridTemplateColumns: `auto repeat(${n}, 2.2rem)` }}>
      {/* Top-left corner */}
      <div />
      {/* Column headers */}
      {symbols.map((s) => (
        <div
          key={`h-${s}`}
          className="h-10 text-terminal-muted text-center pb-1 overflow-hidden"
          title={s}
        >
          <span
            className="inline-block origin-bottom-left translate-x-[4px]"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontSize: "0.6rem" }}
          >
            {s}
          </span>
        </div>
      ))}

      {/* Rows */}
      {symbols.map((row, i) => (
        <div key={`r-${row}`} className="contents">
          <div className="pr-2 text-right text-terminal-muted tabular-nums py-0.5 text-2xs" title={row}>
            {row}
          </div>
          {symbols.map((col, j) => {
            const v = matrix[i]?.[j];
            const isDiag = i === j;
            return (
              <div
                key={`c-${row}-${col}`}
                title={isDiag ? row : `${row} vs ${col}: ${v != null ? v.toFixed(2) : "--"}`}
                className="h-7 border border-terminal-bg flex items-center justify-center text-2xs tabular-nums"
                style={{
                  background: isDiag ? "#262626" : corrCellBg(v),
                  color: isDiag ? "#525252" : corrCellFg(v),
                }}
              >
                {isDiag ? "1" : v != null ? v.toFixed(2) : ""}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function corrCellBg(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  const a = Math.min(1, Math.abs(v));
  const alpha = (0.1 + 0.7 * a).toFixed(2);
  return v >= 0
    ? `rgba(34, 197, 94, ${alpha})`
    : `rgba(239, 68, 68, ${alpha})`;
}

function corrCellFg(v: number | null | undefined): string {
  if (v == null) return "#6b7280";
  const a = Math.min(1, Math.abs(v));
  // High contrast when strongly correlated
  return a > 0.6 ? "#fff" : "#9ca3af";
}

// ── Factor Bar Chart ─────────────────────────────────────────────────────────

function FactorBars({ exposures }: { exposures: FactorExposure[] }) {
  const maxAbs = Math.max(...exposures.map((e) => Math.abs(e.beta)), 0.001);

  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {exposures.map(({ factor, beta }) => {
        const pct = Math.min(100, (Math.abs(beta) / maxAbs) * 100);
        const isPos = beta >= 0;
        return (
          <div key={factor} className="flex items-center gap-2 text-xs">
            <span className="w-12 text-right text-terminal-muted text-2xs uppercase">{factor}</span>
            <div className="flex-1 h-4 bg-terminal-panel rounded overflow-hidden relative">
              <div
                className={`h-full rounded ${isPos ? "bg-green-600/60" : "bg-red-600/60"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              className={`w-14 text-right tabular-nums text-2xs font-semibold ${isPos ? "text-green-400" : "text-red-400"}`}
            >
              {isPos ? "+" : ""}{beta.toFixed(3)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
