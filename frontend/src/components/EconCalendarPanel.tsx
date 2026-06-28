import { useEffect, useState } from "react";

// ── Local mirror of the backend economic_calendar.py payload ──────────────────
interface EconEvent {
  date: string;
  time_et: string;
  event: string;
  period: string;
  importance: "High" | "Medium" | "Low" | string;
  consensus: string | null;
  prior: string | null;
  actual: string | null;
  unit: string;
}

interface EconDay {
  date: string;
  weekday: string;
  events: EconEvent[];
}

interface NextHigh {
  event: string;
  date: string;
  time_et: string;
}

interface EconCalendar {
  events: EconEvent[];
  by_day: EconDay[];
  next_high_impact: NextHigh | null;
  data_mode: string;
  as_of: string;
  source: string;
}

// ── Local fallback so the panel is never an empty box ─────────────────────────
const FALLBACK: EconCalendar = {
  events: [],
  by_day: [
    {
      date: "2026-07-02",
      weekday: "Thu",
      events: [
        { date: "2026-07-02", time_et: "08:30", event: "Initial Jobless Claims", period: "Week of Jun 27", importance: "Medium", consensus: "224K", prior: "219K", actual: null, unit: "K" },
      ],
    },
    {
      date: "2026-07-03",
      weekday: "Fri",
      events: [
        { date: "2026-07-03", time_et: "08:30", event: "Nonfarm Payrolls", period: "Jun", importance: "High", consensus: "180K", prior: "206K", actual: null, unit: "K" },
        { date: "2026-07-03", time_et: "08:30", event: "Unemployment Rate", period: "Jun", importance: "Medium", consensus: "4.1%", prior: "4.2%", actual: null, unit: "%" },
        { date: "2026-07-03", time_et: "08:30", event: "Avg Hourly Earnings MoM", period: "Jun", importance: "Medium", consensus: "0.3%", prior: "0.4%", actual: null, unit: "%" },
      ],
    },
    {
      date: "2026-07-14",
      weekday: "Tue",
      events: [
        { date: "2026-07-14", time_et: "08:30", event: "CPI MoM", period: "Jun", importance: "High", consensus: "0.2%", prior: "0.3%", actual: null, unit: "%" },
        { date: "2026-07-14", time_et: "08:30", event: "Core CPI MoM", period: "Jun", importance: "High", consensus: "0.3%", prior: "0.3%", actual: null, unit: "%" },
      ],
    },
  ],
  next_high_impact: { event: "Nonfarm Payrolls", date: "2026-07-03", time_et: "08:30" },
  data_mode: "sample",
  as_of: new Date().toISOString(),
  source: "generated-schedule",
};

const WEEKDAY_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

export function EconCalendarPanel() {
  const [data, setData] = useState<EconCalendar>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/econ-calendar")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: EconCalendar) => {
        if (alive && d && Array.isArray(d.by_day) && d.by_day.length > 0) {
          setData(d);
        }
        if (alive) setLoading(false);
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const todayIso = new Date().toISOString().slice(0, 10);
  const highCount = data.by_day.reduce(
    (n, day) => n + day.events.filter((e) => e.importance === "High").length,
    0,
  );
  const totalCount = data.by_day.reduce((n, day) => n + day.events.length, 0);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Economic Calendar</span>
        <div className="flex items-center gap-3 text-2xs text-terminal-muted normal-case tracking-normal">
          <span className="tabular-nums">{totalCount} releases</span>
          <span className="tabular-nums text-accent-red">{highCount} high-impact</span>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {err && (
          <div className="text-2xs text-terminal-dim">
            Showing sample schedule. Live fetch unavailable.
          </div>
        )}
        {loading && (
          <div className="text-terminal-dim text-xs py-1">Loading schedule...</div>
        )}

        <NextHighStrip next={data.next_high_impact} todayIso={todayIso} />

        <div className="flex flex-col gap-2.5">
          {data.by_day.map((day) => (
            <DayBlock key={day.date} day={day} todayIso={todayIso} />
          ))}
        </div>

        <Legend />
      </div>
    </div>
  );
}

// ── Next high-impact highlight strip ──────────────────────────────────────────
function NextHighStrip({ next, todayIso }: { next: NextHigh | null; todayIso: string }) {
  if (!next) {
    return (
      <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel p-3">
        <div className="text-2xs text-terminal-muted uppercase tracking-wider">
          Next high-impact release
        </div>
        <div className="text-terminal-dim text-sm mt-1">None scheduled in window</div>
      </div>
    );
  }
  const days = daysUntil(todayIso, next.date);
  const when =
    days <= 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
  return (
    <div className="bg-terminal-bg border-l-2 border-accent-red rounded-panel p-3 flex items-end gap-5 flex-wrap">
      <div className="min-w-0">
        <div className="text-2xs text-accent-red uppercase tracking-wider mb-1">
          Next high-impact release
        </div>
        <div className="stat-figure text-2xl leading-none text-terminal-text truncate">
          {next.event}
        </div>
        <div className="text-2xs text-terminal-dim mt-1 tabular-nums">
          {fmtLongDate(next.date)} - {next.time_et} ET
        </div>
      </div>
      <div className="ml-auto text-right">
        <div className="stat-figure text-3xl leading-none text-accent-amber tabular-nums">
          {when}
        </div>
        <div className="text-2xs text-terminal-muted uppercase tracking-wider mt-1">
          Countdown
        </div>
      </div>
    </div>
  );
}

// ── One day's agenda block ────────────────────────────────────────────────────
function DayBlock({ day, todayIso }: { day: EconDay; todayIso: string }) {
  const isToday = day.date === todayIso;
  const isPast = day.date < todayIso;
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1 px-1">
        <span
          className={
            "text-xs font-mono uppercase tracking-wider " +
            (isToday ? "text-accent-amber" : "text-terminal-muted")
          }
        >
          {WEEKDAY_FULL[day.weekday] ?? day.weekday}
        </span>
        <span className="text-2xs text-terminal-dim tabular-nums">
          {fmtShortDate(day.date)}
        </span>
        {isToday && (
          <span className="pill normal-case tracking-normal text-2xs bg-accent-amber/20 text-accent-amber">
            Today
          </span>
        )}
        <span className="ml-auto text-2xs text-terminal-dim tabular-nums">
          {day.events.length}
        </span>
      </div>
      <div className="bg-terminal-bg border border-terminal-border/50 rounded-panel overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-terminal-dim uppercase tracking-wide text-2xs border-b border-terminal-border/30">
              <th className="text-left py-1 px-2 font-normal">Time</th>
              <th className="text-left py-1 px-2 font-normal">Event</th>
              <th className="text-left py-1 px-2 font-normal">Imp</th>
              <th className="text-left py-1 px-2 font-normal">Period</th>
              <th className="text-right py-1 px-2 font-normal">Actual</th>
              <th className="text-right py-1 px-2 font-normal">Cons.</th>
              <th className="text-right py-1 px-2 font-normal">Prior</th>
            </tr>
          </thead>
          <tbody>
            {day.events.map((ev, i) => (
              <EventRow key={`${ev.event}-${i}`} ev={ev} isPast={isPast} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EventRow({ ev, isPast }: { ev: EconEvent; isPast: boolean }) {
  const high = ev.importance === "High";
  const rowCls =
    "border-t border-terminal-border/15 " +
    (high
      ? "bg-accent-red/[0.06] border-l-2 border-l-accent-red"
      : "border-l-2 border-l-transparent");
  const surprise = surpriseDir(ev.actual, ev.consensus);
  const actualCls =
    ev.actual === null
      ? "text-terminal-dim"
      : surprise === "up"
        ? "text-accent-green"
        : surprise === "down"
          ? "text-accent-red"
          : "text-terminal-text";
  return (
    <tr className={rowCls}>
      <td className="py-1.5 px-2 font-mono tabular-nums text-terminal-muted">
        {ev.time_et}
      </td>
      <td
        className={
          "py-1.5 px-2 " + (high ? "text-terminal-text font-medium" : "text-terminal-text")
        }
      >
        {ev.event}
      </td>
      <td className="py-1.5 px-2">
        <ImportancePill importance={ev.importance} />
      </td>
      <td className="py-1.5 px-2 text-terminal-muted whitespace-nowrap">{ev.period}</td>
      <td className={"py-1.5 px-2 text-right font-mono tabular-nums " + actualCls}>
        {ev.actual ?? (isPast ? "-" : "")}
      </td>
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">
        {ev.consensus ?? "-"}
      </td>
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
        {ev.prior ?? "-"}
      </td>
    </tr>
  );
}

function ImportancePill({ importance }: { importance: string }) {
  const cls =
    importance === "High"
      ? "bg-accent-red/15 text-accent-red"
      : importance === "Medium"
        ? "bg-terminal-divider/60 text-terminal-muted"
        : "text-terminal-dim";
  const label = importance === "High" ? "High" : importance === "Medium" ? "Med" : "Low";
  return (
    <span className={"pill normal-case tracking-normal text-2xs " + cls}>{label}</span>
  );
}

function Legend() {
  return (
    <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-1 pt-1 text-2xs text-terminal-muted">
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm bg-accent-red/40 inline-block" />
        High impact
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-0.5 rounded inline-block bg-accent-green" />
        Actual beat consensus
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-0.5 rounded inline-block bg-accent-red" />
        Actual missed consensus
      </span>
      <span className="ml-auto text-terminal-dim">All times US Eastern</span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseNum(s: string | null): number | null {
  if (s === null) return null;
  // Strip unit suffixes / symbols; keep sign + digits + decimal.
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

function surpriseDir(
  actual: string | null,
  consensus: string | null,
): "up" | "down" | "flat" | null {
  const a = parseNum(actual);
  const c = parseNum(consensus);
  if (a === null || c === null) return null;
  if (a > c) return "up";
  if (a < c) return "down";
  return "flat";
}

function daysUntil(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

function fmtShortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtLongDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
