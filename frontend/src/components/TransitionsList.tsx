import type { RegimeHistoryResponse, RegimeLabel } from "../api/types";

const LABEL_COLORS: Record<RegimeLabel, string> = {
  risk_on:    "text-regime-on",
  risk_off:   "text-regime-off",
  transition: "text-regime-trans",
};

const LABEL_TEXT: Record<RegimeLabel, string> = {
  risk_on:    "risk-on",
  risk_off:   "risk-off",
  transition: "transition",
};

interface Props {
  transitions: RegimeHistoryResponse["recent_transitions"];
}

export function TransitionsList({ transitions }: Props) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Recent Regime Transitions</span>
        <span className="normal-case tracking-normal">{transitions.length}</span>
      </div>
      <div className="panel-body p-0">
        {transitions.length === 0 ? (
          <div className="p-3 text-terminal-dim text-xs">
            No transitions in the window. Add a FRED API key to enable
            yield-curve-driven regime detection across a longer history.
          </div>
        ) : (
          <ul className="divide-y divide-terminal-divider text-xs">
            {transitions.map((t, i) => (
              <li key={`${t.date}-${i}`} className="px-3 py-2 flex items-baseline gap-3">
                <span className="text-terminal-muted tabular-nums w-24 shrink-0">
                  {t.date}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={LABEL_COLORS[t.from]}>{LABEL_TEXT[t.from]}</span>
                  <span className="text-terminal-dim">→</span>
                  <span className={LABEL_COLORS[t.to]}>{LABEL_TEXT[t.to]}</span>
                </span>
                <span className="text-terminal-muted truncate" title={t.reason}>
                  {t.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
