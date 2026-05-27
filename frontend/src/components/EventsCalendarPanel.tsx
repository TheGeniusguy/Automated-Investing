import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  CalendarEvent,
  CalendarWeekResponse,
  EventCategory,
  EventImpact,
} from "../api/types";

const IMPACT_COLORS: Record<EventImpact, string> = {
  high:   "#ef5350",
  medium: "#ffb800",
  low:    "#5fb878",
};

const CATEGORY_LABELS: Record<EventCategory, string> = {
  inflation:       "Inflation",
  employment:      "Employment",
  growth:          "Growth",
  monetary_policy: "Monetary Policy",
  housing:         "Housing",
  sentiment:       "Sentiment",
  trade:           "Trade",
  earnings:        "Earnings",
};

const CATEGORY_COLORS: Record<EventCategory, string> = {
  inflation:       "#fb7185",
  employment:      "#26a69a",
  growth:          "#84cc16",
  monetary_policy: "#a78bfa",
  housing:         "#f59e0b",
  sentiment:       "#06b6d4",
  trade:           "#8b5cf6",
  earnings:        "#ffb800",
};

/**
 * Events Calendar — weekly grid of economic releases + FOMC meetings.
 *
 * Each event carries impact tier + category + market-impact note. Filterable
 * by impact and category. Click an event to expand and see the full note.
 */
export function EventsCalendarPanel() {
  const [data, setData] = useState<CalendarWeekResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [impactFilter, setImpactFilter] = useState<Set<EventImpact>>(new Set(["high", "medium", "low"]));
  const [catFilter, setCatFilter] = useState<Set<EventCategory>>(new Set(Object.keys(CATEGORY_LABELS) as EventCategory[]));
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = (date?: string) => {
    api.calendarWeek(date)
      .then(setData)
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    load();
  }, []);

  const navigate = (deltaDays: number) => {
    if (!data) return;
    const monday = new Date(data.start + "T00:00:00Z");
    monday.setUTCDate(monday.getUTCDate() + deltaDays);
    const next = monday.toISOString().slice(0, 10);
    load(next);
  };

  const passesFilter = (e: CalendarEvent) =>
    impactFilter.has(e.impact) && catFilter.has(e.category);

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-accent font-semibold">EVENTS CALENDAR</span>
            {data && (
              <span className="text-xs text-terminal-dim">
                {data.start} → {data.end}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => navigate(-7)} className="pill text-[10px]">◀ Prev</button>
            <button onClick={() => load()} className="pill text-[10px]">Today</button>
            <button onClick={() => navigate(7)} className="pill text-[10px]">Next ▶</button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          <span className="text-terminal-dim uppercase">Impact:</span>
          {(["high", "medium", "low"] as EventImpact[]).map((imp) => (
            <button
              key={imp}
              onClick={() => setImpactFilter((s) => toggleSet(s, imp))}
              className={`pill ${impactFilter.has(imp) ? "" : "opacity-30"}`}
              style={{ borderColor: IMPACT_COLORS[imp] }}
            >
              {imp}
            </button>
          ))}
          <span className="text-terminal-dim uppercase ml-2">Category:</span>
          {(Object.keys(CATEGORY_LABELS) as EventCategory[]).map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter((s) => toggleSet(s, c))}
              className={`pill ${catFilter.has(c) ? "" : "opacity-30"}`}
              style={{ borderColor: CATEGORY_COLORS[c] }}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>

        {/* Summary */}
        {data && (
          <div className="text-[10px] text-terminal-dim">
            {data.summary.total} events this week ·{" "}
            <span style={{ color: IMPACT_COLORS.high }}>{data.summary.high} high</span> ·{" "}
            <span style={{ color: IMPACT_COLORS.medium }}>{data.summary.medium} medium</span> ·{" "}
            <span style={{ color: IMPACT_COLORS.low }}>{data.summary.low} low</span>
          </div>
        )}
      </header>

      <div className="panel-body flex-1 overflow-auto p-2">
        {err && <div className="text-rose-400 text-xs">Error: {err}</div>}
        {!data && !err && <div className="text-terminal-dim text-xs">Loading…</div>}
        {data && (
          <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
            {data.days.map((day) => {
              const events = day.events.filter(passesFilter);
              const isWeekend = day.weekday === "Saturday" || day.weekday === "Sunday";
              return (
                <div
                  key={day.date}
                  className={`border border-terminal-border rounded p-1 ${isWeekend ? "opacity-50" : ""}`}
                >
                  <div className="text-[10px] uppercase tracking-wide text-terminal-dim flex justify-between">
                    <span>{day.weekday.slice(0, 3)}</span>
                    <span className="font-mono">{day.date.slice(5)}</span>
                  </div>
                  {events.length === 0 ? (
                    <div className="text-[10px] text-terminal-dim/60 italic py-2 text-center">—</div>
                  ) : (
                    <ul className="space-y-1 mt-1">
                      {events.map((e, i) => {
                        const id = `${day.date}-${i}`;
                        const isOpen = expanded === id;
                        return (
                          <li
                            key={id}
                            onClick={() => setExpanded(isOpen ? null : id)}
                            className="cursor-pointer text-[10px] bg-terminal-panel/60 rounded p-1 hover:bg-terminal-panel"
                          >
                            <div className="flex items-start gap-1">
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full mt-1 shrink-0"
                                style={{ background: IMPACT_COLORS[e.impact] }}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-terminal-dim">{e.time ?? "—"}</div>
                                <div className="font-medium truncate" title={e.name}>{e.name}</div>
                                <div
                                  className="text-[9px] uppercase"
                                  style={{ color: CATEGORY_COLORS[e.category] }}
                                >
                                  {e.category.replace("_", " ")}
                                </div>
                                {isOpen && (
                                  <div className="mt-1 text-[10px] text-terminal-dim space-y-1">
                                    <div><span className="uppercase text-[9px]">Source:</span> {e.source}</div>
                                    <div><span className="uppercase text-[9px]">What:</span> {e.description}</div>
                                    <div><span className="uppercase text-[9px]">Markets:</span> {e.market_impact}</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function toggleSet<T>(s: Set<T>, v: T): Set<T> {
  const next = new Set(s);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
}
