import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { RegimeState, SeriesBundle } from "../api/types";
import { BriefingPane } from "./BriefingPane";
import { MacroChart } from "./MacroChart";

const CHART_GRID = ["DGS2", "DGS10", "BAMLH0A0HYM2", "^VIX", "DX-Y.NYB"] as const;

/**
 * Panel 1 — Macro Regime Tracker.
 *
 * Layout: a 2x3 grid of macro charts on the left, with the Claude briefing
 * pane occupying the right column. The regime badge lives inside the briefing
 * header so the call-to-action and the diagnosis sit side by side.
 */
export function MacroRegimeTracker() {
  const [bundle, setBundle] = useState<SeriesBundle | null>(null);
  const [regime, setRegime] = useState<RegimeState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.allSeries(90), api.currentRegime()])
      .then(([b, r]) => {
        if (!alive) return;
        setBundle(b);
        setRegime(r);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Macro Regime Tracker</span></div>
        <div className="panel-body text-accent-red">⚠ {err}</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2 h-full">
      <div className="col-span-2 grid grid-cols-2 grid-rows-3 gap-2">
        {CHART_GRID.map((s) => {
          const meta = bundle?.meta[s];
          const pts = bundle?.series[s] ?? [];
          return (
            <MacroChart
              key={s}
              points={pts}
              label={meta?.label ?? s}
              unit={meta?.unit ?? ""}
            />
          );
        })}
        {/* Final cell: tiny status summary so the 3-row layout balances. */}
        <RegimeStatusCard regime={regime} />
      </div>
      <div className="col-span-1">
        <BriefingPane externalRegime={regime} />
      </div>
    </div>
  );
}

function RegimeStatusCard({ regime }: { regime: RegimeState | null }) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>Regime Diagnosis</span></div>
      <div className="panel-body text-xs space-y-2">
        {regime ? (
          <>
            <div className="text-terminal-muted uppercase tracking-wider text-2xs">
              Inputs
            </div>
            <Row label="VIX"    val={regime.inputs.vix}  unit="idx" />
            <Row label="2Y"     val={regime.inputs.y2}   unit="%" />
            <Row label="10Y"    val={regime.inputs.y10}  unit="%" />
            <Row
              label="2s10s"
              val={
                regime.inputs.y2 !== null && regime.inputs.y10 !== null
                  ? regime.inputs.y10 - regime.inputs.y2
                  : null
              }
              unit="%"
              signed
            />
            <div className="pt-2 mt-2 border-t border-terminal-divider text-terminal-muted leading-relaxed">
              {regime.reason}
            </div>
          </>
        ) : (
          <div className="text-terminal-dim">loading…</div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  val,
  unit,
  signed = false,
}: {
  label: string;
  val: number | null;
  unit: string;
  signed?: boolean;
}) {
  const display =
    val === null
      ? "—"
      : `${signed && val > 0 ? "+" : ""}${val.toFixed(2)} ${unit}`;
  return (
    <div className="flex justify-between">
      <span className="text-terminal-muted">{label}</span>
      <span className="text-terminal-text">{display}</span>
    </div>
  );
}
