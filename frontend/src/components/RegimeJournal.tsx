import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { JournalSpxResponse, RegimeHistoryResponse } from "../api/types";
import { PortfolioStressTest } from "./PortfolioStressTest";
import { RegimeTimelineChart } from "./RegimeTimelineChart";
import { TransitionsList } from "./TransitionsList";

const YEAR_OPTIONS = [2, 5, 10, 20] as const;
const DEFAULT_YEARS = 10;

/**
 * Panel 2 — Regime Journal.
 *
 * Backward-looking pattern archaeology: SPX with regime-color ribbon below,
 * recent transitions on the left, portfolio stress-test on the right.
 */
export function RegimeJournal() {
  const [years, setYears] = useState<number>(DEFAULT_YEARS);
  const [journal, setJournal] = useState<JournalSpxResponse | null>(null);
  const [history, setHistory] = useState<RegimeHistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const days = useMemo(() => years * 365, [years]);

  useEffect(() => {
    let alive = true;
    setErr(null);
    setJournal(null);
    setHistory(null);
    Promise.all([api.journalSpx(days), api.regimeHistory(days)])
      .then(([j, h]) => {
        if (!alive) return;
        setJournal(j);
        setHistory(h);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [days]);

  return (
    <div className="grid grid-cols-3 grid-rows-2 gap-2 h-full">
      <div className="col-span-3 row-span-1 relative">
        {err ? (
          <div className="panel h-full">
            <div className="panel-header"><span>Regime Journal</span></div>
            <div className="panel-body text-accent-red">⚠ {err}</div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <RangeBar years={years} setYears={setYears} />
            <div className="flex-1 min-h-0">
              <RegimeTimelineChart
                spx={journal?.spx ?? []}
                segments={journal?.segments ?? []}
              />
            </div>
          </div>
        )}
      </div>

      <div className="col-span-1 row-span-1">
        <TransitionsList transitions={history?.recent_transitions ?? []} />
      </div>
      <div className="col-span-2 row-span-1">
        <PortfolioStressTest days={days} />
      </div>
    </div>
  );
}

function RangeBar({ years, setYears }: { years: number; setYears: (y: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 pb-1 text-2xs uppercase tracking-wider text-terminal-muted">
      <span>range</span>
      {YEAR_OPTIONS.map((y) => (
        <button
          key={y}
          onClick={() => setYears(y)}
          className={
            "px-2 py-0.5 border transition " +
            (y === years
              ? "border-accent-amber/60 text-accent-amber"
              : "border-terminal-divider hover:border-terminal-muted hover:text-terminal-text")
          }
        >
          {y}y
        </button>
      ))}
    </div>
  );
}
