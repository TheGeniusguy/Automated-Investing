import type { CorrelationMatrix as MatrixData, CorrelationGroup } from "../api/types";

type Mode = "recent" | "baseline" | "delta";

interface Props {
  tickers: string[];
  groups: CorrelationGroup[];
  matrix: MatrixData;
  mode: Mode;
}

/** Pure-CSS heatmap. NxN grid of color cells; tooltip shows the numeric value. */
export function CorrelationMatrix({ tickers, groups, matrix, mode }: Props) {
  const data = matrix[mode];

  // Build group-boundary lookup so we can draw thin dividers between asset
  // classes (Equity | Macro | Sectors), which makes regime-driven clusters
  // easier to read at a glance.
  const groupOfTicker = new Map(groups.map((g) => [g.ticker, g.name]));

  return (
    <div className="overflow-auto">
      <div
        className="inline-grid text-2xs"
        style={{
          gridTemplateColumns: `auto repeat(${tickers.length}, 1.4rem)`,
        }}
      >
        {/* Top-left corner */}
        <div />
        {/* Column headers */}
        {tickers.map((t, j) => {
          const showDivider = j > 0 && groupOfTicker.get(t) !== groupOfTicker.get(tickers[j - 1]);
          return (
            <div
              key={`h-${t}`}
              className={
                "h-12 text-terminal-muted text-center align-bottom pb-1 " +
                (showDivider ? "border-l border-terminal-divider" : "")
              }
              title={t}
            >
              <span className="inline-block origin-bottom-left rotate-[-60deg] translate-x-[2px] whitespace-nowrap">
                {short(t)}
              </span>
            </div>
          );
        })}

        {/* Rows */}
        {tickers.map((row, i) => {
          const rowGroup = groupOfTicker.get(row);
          const showRowDivider = i > 0 && rowGroup !== groupOfTicker.get(tickers[i - 1]);
          return (
            <div key={`r-${row}`} className="contents">
              <div
                className={
                  "pr-2 text-right text-terminal-muted tabular-nums " +
                  (showRowDivider ? "border-t border-terminal-divider" : "")
                }
                title={row}
              >
                {short(row)}
              </div>
              {tickers.map((col, j) => {
                const v = data[i]?.[j];
                const showColDivider = j > 0 && groupOfTicker.get(col) !== groupOfTicker.get(tickers[j - 1]);
                const isDiag = i === j;
                return (
                  <div
                    key={`c-${row}-${col}`}
                    title={
                      isDiag
                        ? row
                        : `${row} ↔ ${col}\n${mode}: ${v === null || v === undefined ? "—" : v.toFixed(2)}`
                    }
                    className={
                      "h-5 border border-terminal-bg " +
                      (showColDivider ? "border-l-terminal-divider " : "") +
                      (showRowDivider ? "border-t-terminal-divider " : "") +
                      (isDiag ? "bg-terminal-divider" : "")
                    }
                    style={isDiag ? undefined : { background: cellColor(v, mode) }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function short(t: string): string {
  // Trim leading ^ and DX-Y.NYB style suffix for readable headers.
  return t.replace(/^\^/, "").replace(/-USD$/, "").replace(/\.NYB$/, "");
}

/**
 * Color rules:
 *  - recent / baseline (range -1..1):
 *      negative → red, positive → green, magnitude drives saturation
 *  - delta (range -2..2 in theory; usually -1..1):
 *      positive → amber (got more correlated), negative → blue (decorrelated)
 */
function cellColor(v: number | null | undefined, mode: Mode): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "#1a1a1a";
  if (mode === "delta") {
    const a = Math.min(1, Math.abs(v) / 0.8);
    const alpha = (0.15 + 0.7 * a).toFixed(2);
    return v >= 0
      ? `rgba(255, 184, 0, ${alpha})`    // amber for coupling-up
      : `rgba(59, 130, 246, ${alpha})`;  // blue for decoupling
  }
  const a = Math.min(1, Math.abs(v));
  const alpha = (0.1 + 0.7 * a).toFixed(2);
  return v >= 0
    ? `rgba(34, 197, 94, ${alpha})`     // green for positive correlation
    : `rgba(239, 68, 68, ${alpha})`;    // red for negative correlation
}
