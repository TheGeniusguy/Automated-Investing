import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";

/**
 * Alerts panel - DB-backed rule engine UI.
 *
 * Create rule form (type / symbol / threshold / note), a rules table with
 * inline-confirm delete, an "Evaluate now" action that reports checked vs
 * triggered counts, and a triggered-events log with fired rows tinted clay.
 *
 * Shapes are mirrored locally - the client returns permissive `any` and each
 * panel binds its own interfaces.
 */

// ── Local shape mirrors (see backend/app/alerts/engine.py) ────────────────
interface AlertRule {
  id: number;
  rule_type: string;
  symbol: string;
  threshold: number | null;
  note: string | null;
  active: boolean;
  created_at: string | null;
}

interface AlertEvent {
  id: number;
  rule_id: number | null;
  rule_type: string;
  symbol: string;
  message: string;
  observed_value: number | null;
  threshold: number | null;
  triggered_at: string | null;
}

interface RulesResponse {
  rules: AlertRule[];
  count: number;
}

interface EventsResponse {
  events: AlertEvent[];
  count: number;
}

interface EvaluateResponse {
  triggered: AlertEvent[];
  checked: number;
}

const RULE_TYPES = [
  { value: "price_above", label: "Price above" },
  { value: "price_below", label: "Price below" },
  { value: "pct_move", label: "Percent move" },
  { value: "rsi_above", label: "RSI above" },
  { value: "rsi_below", label: "RSI below" },
  { value: "regime_change", label: "Regime change" },
] as const;

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  RULE_TYPES.map((t) => [t.value, t.label]),
);

// A rule fired recently if an event references it; we tint such rows clay.
function fmtNum(v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AlertsPanel() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [evalMsg, setEvalMsg] = useState<string | null>(null);

  // Create-rule form state.
  const [fType, setFType] = useState<string>("price_above");
  const [fSymbol, setFSymbol] = useState("");
  const [fThreshold, setFThreshold] = useState("");
  const [fNote, setFNote] = useState("");

  const isRegime = fType === "regime_change";

  const load = async () => {
    setLoading(true);
    try {
      const [r, e] = await Promise.all([
        api.alertsRules() as Promise<RulesResponse>,
        api.alertsEvents() as Promise<EventsResponse>,
      ]);
      setRules(Array.isArray(r?.rules) ? r.rules : []);
      setEvents(Array.isArray(e?.events) ? e.events : []);
      setErr(null);
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Symbols with at least one fired event, for row tinting.
  const firedSymbols = useMemo(() => {
    const s = new Set<string>();
    for (const ev of events) s.add(ev.symbol.toUpperCase());
    return s;
  }, [events]);

  const createRule = async () => {
    const symbol = fSymbol.trim().toUpperCase();
    if (!symbol) {
      setErr("Symbol is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { type: fType, symbol };
      // regime_change reads its baseline from the note, no threshold.
      if (!isRegime && fThreshold.trim() !== "") {
        body.threshold = Number(fThreshold);
      }
      if (fNote.trim() !== "") body.note = fNote.trim();
      await api.alertsCreateRule(body);
      setFSymbol("");
      setFThreshold("");
      setFNote("");
      await load();
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteRule = async (id: number) => {
    setBusy(true);
    setErr(null);
    try {
      await api.alertsDeleteRule(id);
      setConfirmId(null);
      await load();
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const evaluate = async () => {
    setBusy(true);
    setErr(null);
    setEvalMsg(null);
    try {
      const res = (await api.alertsEvaluate()) as EvaluateResponse;
      const checked = res?.checked ?? 0;
      const fired = Array.isArray(res?.triggered) ? res.triggered.length : 0;
      setEvalMsg(
        `Checked ${checked} rule${checked === 1 ? "" : "s"}, ${fired} triggered`,
      );
      await load();
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">ALERTS</span>
          <span className="text-2xs text-terminal-dim">
            {rules.length} rule{rules.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={evaluate}
          disabled={busy || loading}
          className="pill text-xs hover:bg-accent hover:text-black disabled:opacity-40"
        >
          Evaluate now
        </button>
      </header>

      <div className="panel-body flex-1 overflow-auto p-3 space-y-4">
        {err && (
          <div className="text-accent-red text-xs border border-accent-red/40 rounded px-2 py-1">
            {err}
          </div>
        )}
        {evalMsg && (
          <div className="text-accent-green text-xs border border-accent-green/30 rounded px-2 py-1">
            {evalMsg}
          </div>
        )}

        {/* ── Create rule ─────────────────────────────────────────── */}
        <div>
          <div className="text-2xs uppercase tracking-wide text-terminal-dim mb-2">
            Create rule
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-terminal-muted">Type</span>
              <select
                value={fType}
                onChange={(e) => setFType(e.target.value)}
                className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs"
              >
                {RULE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-terminal-muted">Symbol</span>
              <input
                value={fSymbol}
                onChange={(e) => setFSymbol(e.target.value)}
                placeholder="AAPL"
                className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono uppercase"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-terminal-muted">
                {isRegime ? "Threshold (not used for regime)" : "Threshold"}
              </span>
              <input
                value={fThreshold}
                onChange={(e) => setFThreshold(e.target.value)}
                placeholder={isRegime ? "n/a" : "250"}
                disabled={isRegime}
                inputMode="decimal"
                className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono disabled:opacity-40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-terminal-muted">
                {isRegime ? "Baseline regime (note)" : "Note"}
              </span>
              <input
                value={fNote}
                onChange={(e) => setFNote(e.target.value)}
                placeholder={isRegime ? "risk_on" : "Trim into strength"}
                className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs"
              />
            </label>
          </div>
          <div className="mt-2 flex justify-end">
            <button
              onClick={createRule}
              disabled={busy}
              className="pill text-xs hover:bg-accent hover:text-black disabled:opacity-40"
            >
              + Add rule
            </button>
          </div>
        </div>

        {/* ── Rules table ─────────────────────────────────────────── */}
        <div>
          <div className="text-2xs uppercase tracking-wide text-terminal-dim mb-2">
            Rules
          </div>
          {loading ? (
            <p className="text-terminal-dim text-xs italic">Loading rules...</p>
          ) : rules.length === 0 ? (
            <p className="text-terminal-dim text-xs italic">
              No rules yet. Add one above.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Type</th>
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-right py-1 px-2">Threshold</th>
                  <th className="text-left py-1 px-2">Note</th>
                  <th className="text-right py-1 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const fired = firedSymbols.has(r.symbol.toUpperCase());
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-terminal-border/50 ${
                        fired
                          ? "bg-accent-amber/10"
                          : "hover:bg-terminal-panel/60"
                      }`}
                    >
                      <td className="py-1 px-2">
                        {TYPE_LABEL[r.rule_type] ?? r.rule_type}
                      </td>
                      <td className="py-1 px-2 font-mono">{r.symbol}</td>
                      <td className="py-1 px-2 text-right font-mono">
                        {fmtNum(r.threshold)}
                      </td>
                      <td className="py-1 px-2 text-terminal-dim">
                        {r.note ?? "-"}
                      </td>
                      <td className="py-1 px-2 text-right whitespace-nowrap">
                        {confirmId === r.id ? (
                          <span className="inline-flex gap-2">
                            <button
                              className="text-accent-red hover:underline text-2xs"
                              disabled={busy}
                              onClick={() => deleteRule(r.id)}
                            >
                              confirm
                            </button>
                            <button
                              className="text-terminal-dim hover:text-terminal-text text-2xs"
                              onClick={() => setConfirmId(null)}
                            >
                              cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            className="text-terminal-dim hover:text-accent-red text-2xs"
                            onClick={() => setConfirmId(r.id)}
                          >
                            delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Triggered events ────────────────────────────────────── */}
        <div>
          <div className="text-2xs uppercase tracking-wide text-terminal-dim mb-2">
            Triggered events
          </div>
          {loading ? (
            <p className="text-terminal-dim text-xs italic">Loading events...</p>
          ) : events.length === 0 ? (
            <p className="text-terminal-dim text-xs italic">
              No events yet. Run Evaluate now.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Time</th>
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-left py-1 px-2">Type</th>
                  <th className="text-left py-1 px-2">Message</th>
                  <th className="text-right py-1 px-2">Observed</th>
                  <th className="text-right py-1 px-2">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr
                    key={ev.id}
                    className="border-b border-terminal-border/50 bg-accent-red/10"
                  >
                    <td className="py-1 px-2 text-terminal-dim whitespace-nowrap">
                      {fmtTime(ev.triggered_at)}
                    </td>
                    <td className="py-1 px-2 font-mono">{ev.symbol}</td>
                    <td className="py-1 px-2">
                      {TYPE_LABEL[ev.rule_type] ?? ev.rule_type}
                    </td>
                    <td className="py-1 px-2 text-terminal-text">{ev.message}</td>
                    <td className="py-1 px-2 text-right font-mono">
                      {fmtNum(ev.observed_value)}
                    </td>
                    <td className="py-1 px-2 text-right font-mono text-terminal-dim">
                      {fmtNum(ev.threshold)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
