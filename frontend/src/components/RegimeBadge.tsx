import type { RegimeState } from "../api/types";

const LABELS: Record<RegimeState["label"], { text: string; cls: string; dot: string }> = {
  risk_on:    { text: "RISK-ON",    cls: "bg-regime-on/15 text-regime-on border-regime-on/40",       dot: "bg-regime-on" },
  risk_off:   { text: "RISK-OFF",   cls: "bg-regime-off/15 text-regime-off border-regime-off/40",    dot: "bg-regime-off" },
  transition: { text: "TRANSITION", cls: "bg-regime-trans/15 text-regime-trans border-regime-trans/40", dot: "bg-regime-trans" },
};

export function RegimeBadge({ state }: { state: RegimeState | null }) {
  if (!state) {
    return (
      <span className="pill border border-terminal-divider text-terminal-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-terminal-muted" />
        loading…
      </span>
    );
  }
  const cfg = LABELS[state.label];
  return (
    <span className={`pill border ${cfg.cls}`} title={state.reason}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.text}
      <span className="ml-1 opacity-60 normal-case tracking-normal">
        · {Math.round(state.confidence * 100)}%
      </span>
    </span>
  );
}
