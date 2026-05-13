import { useState } from "react";

import { api } from "../api/client";
import type {
  RegimeLabel,
  StressTestPosition,
  StressTestResponse,
} from "../api/types";

const REGIME_TEXT: Record<RegimeLabel, string> = {
  risk_on:    "risk-on",
  risk_off:   "risk-off",
  transition: "transition",
};

const REGIME_COLOR: Record<RegimeLabel, string> = {
  risk_on:    "text-regime-on",
  risk_off:   "text-regime-off",
  transition: "text-regime-trans",
};

const SAMPLE_CSV = `AAPL,0.20
MSFT,0.20
GOOGL,0.15
SPY,0.30
TLT,0.15`;

interface Props {
  /** Days of history to test against — matches what RegimeJournal renders. */
  days: number;
}

export function PortfolioStressTest({ days }: Props) {
  const [raw, setRaw] = useState(SAMPLE_CSV);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StressTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const positions = parseCsv(raw);
      if (!positions.length) throw new Error("No valid positions parsed from CSV.");
      const data = await api.stressTest(positions, days);
      setResult(data);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Portfolio Stress Test</span>
        <button
          onClick={run}
          disabled={running}
          className="text-terminal-muted hover:text-accent-amber disabled:opacity-40 transition normal-case tracking-normal"
        >
          {running ? "running…" : "run test"}
        </button>
      </div>

      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider">
          <label className="text-2xs uppercase tracking-wider text-terminal-muted">
            positions (ticker,weight per line)
          </label>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={4}
            spellCheck={false}
            className="mt-1 w-full bg-black/40 border border-terminal-divider
                       text-terminal-text font-mono text-xs p-2 outline-none
                       focus:border-accent-amber/60 resize-none"
            placeholder="AAPL,0.2"
          />
        </div>

        <div className="flex-1 overflow-auto p-3 text-xs">
          {error && <div className="text-accent-red mb-2">⚠ {error}</div>}
          {!result && !error && (
            <div className="text-terminal-dim">
              Enter positions, click run test. Returns are computed within each
              regime period over the last {Math.round(days / 365)} years.
            </div>
          )}
          {result && <ResultsTable result={result} />}
        </div>
      </div>
    </div>
  );
}

function ResultsTable({ result }: { result: StressTestResponse }) {
  const regimes: RegimeLabel[] = ["risk_on", "transition", "risk_off"];

  return (
    <div className="space-y-3">
      <table className="w-full tabular-nums">
        <thead className="text-terminal-muted text-2xs uppercase tracking-wider">
          <tr>
            <th className="text-left py-1.5 pr-3">Ticker</th>
            <th className="text-right pr-3">Weight</th>
            {regimes.map((r) => (
              <th key={r} className={`text-right pr-3 ${REGIME_COLOR[r]}`}>
                {REGIME_TEXT[r]}
              </th>
            ))}
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-terminal-divider">
          {result.positions.map((p) => (
            <tr key={p.ticker} className="text-terminal-text">
              <td className="py-1.5 pr-3 text-accent-amber">{p.ticker}</td>
              <td className="text-right pr-3 text-terminal-muted">
                {(p.weight * 100).toFixed(0)}%
              </td>
              {regimes.map((r) => (
                <td key={r} className="text-right pr-3">
                  <ReturnCell value={p.regime_returns[r]} />
                </td>
              ))}
              <td className="text-right">
                <ReturnCell value={p.total_return} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-2xs uppercase tracking-wider">
          <tr className="border-t-2 border-terminal-divider">
            <td className="pt-2 pr-3 text-terminal-muted">Weighted</td>
            <td />
            {regimes.map((r) => (
              <td key={r} className="text-right pr-3 pt-2">
                <ReturnCell value={result.aggregate_by_regime[r]} dim />
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>

      <div className="text-2xs text-terminal-muted">
        {result.segments.length} regime segment{result.segments.length === 1 ? "" : "s"} over the window.
        {result.segments.length === 1 && (
          <span className="text-regime-trans"> Configure FRED to surface yield-curve regime changes.</span>
        )}
      </div>
    </div>
  );
}

function ReturnCell({ value, dim = false }: { value: number | null; dim?: boolean }) {
  if (value === null) return <span className="text-terminal-dim">—</span>;
  const pct = value * 100;
  const cls =
    pct > 0 ? "text-accent-green"
      : pct < 0 ? "text-accent-red"
      : "text-terminal-muted";
  return (
    <span className={`${cls} ${dim ? "opacity-80" : ""}`}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function parseCsv(raw: string): StressTestPosition[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("ticker,"))
    .map((line) => {
      const [ticker, weight] = line.split(",").map((s) => s.trim());
      const w = Number(weight);
      if (!ticker || Number.isNaN(w)) return null;
      return { ticker: ticker.toUpperCase(), weight: w };
    })
    .filter((p): p is StressTestPosition => p !== null);
}
