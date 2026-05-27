import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { Watchlist, WatchlistSummary } from "../api/types";

/**
 * Watchlists panel — DB-backed multi-watchlist UI.
 *
 * Left pane: list of watchlists with create / rename / delete / mark-default.
 * Right pane: items of the selected watchlist with add / remove / reorder.
 */
export function WatchlistsPanel() {
  const [lists, setLists] = useState<WatchlistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [active, setActive] = useState<Watchlist | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshList = async () => {
    try {
      const res = await api.listWatchlists();
      setLists(res.watchlists);
      if (!selectedId && res.watchlists.length > 0) {
        setSelectedId(res.watchlists[0].id);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const refreshActive = async () => {
    if (!selectedId) {
      setActive(null);
      return;
    }
    try {
      setActive(await api.getWatchlist(selectedId));
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refreshList();
  }, []);

  useEffect(() => {
    refreshActive();
  }, [selectedId]);

  const createList = async () => {
    const name = window.prompt("Watchlist name");
    if (!name) return;
    setBusy(true);
    try {
      const w = await api.createWatchlist(name);
      await refreshList();
      setSelectedId(w.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const renameList = async (l: WatchlistSummary) => {
    const name = window.prompt("New name", l.name);
    if (!name || name === l.name) return;
    await api.updateWatchlist(l.id, { name });
    await refreshList();
    if (selectedId === l.id) await refreshActive();
  };

  const setDefault = async (l: WatchlistSummary) => {
    await api.updateWatchlist(l.id, { is_default: true });
    await refreshList();
  };

  const deleteList = async (l: WatchlistSummary) => {
    if (!window.confirm(`Delete watchlist "${l.name}"? Items will be removed too.`)) return;
    await api.deleteWatchlist(l.id);
    if (selectedId === l.id) setSelectedId(null);
    await refreshList();
  };

  const addItem = async () => {
    if (!selectedId) return;
    const raw = window.prompt("Ticker(s), comma- or space-separated");
    if (!raw) return;
    const tickers = raw.split(/[\s,]+/).filter(Boolean);
    for (const t of tickers) {
      try {
        await api.addWatchlistItem(selectedId, { ticker: t });
      } catch (e) {
        setErr(`add ${t}: ${e}`);
      }
    }
    await refreshActive();
    await refreshList();
  };

  const removeItem = async (ticker: string) => {
    if (!selectedId) return;
    await api.removeWatchlistItem(selectedId, ticker);
    await refreshActive();
    await refreshList();
  };

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">WATCHLISTS</span>
          <span className="text-xs text-terminal-dim">{lists.length} list{lists.length === 1 ? "" : "s"}</span>
        </div>
        <button onClick={createList} disabled={busy} className="pill text-xs hover:bg-accent hover:text-black">
          + New
        </button>
      </header>

      <div className="panel-body flex-1 overflow-hidden grid grid-cols-[200px_1fr] gap-2 p-2">
        {/* Left: lists */}
        <aside className="overflow-auto border-r border-terminal-border pr-2">
          {err && <div className="text-rose-400 text-xs mb-2">{err}</div>}
          {lists.length === 0 && (
            <p className="text-terminal-dim text-xs italic">
              No watchlists yet. Click "+ New" to create one.
            </p>
          )}
          <ul className="space-y-1">
            {lists.map((l) => (
              <li
                key={l.id}
                className={`p-2 rounded cursor-pointer text-xs ${
                  l.id === selectedId
                    ? "bg-terminal-panel border border-accent/40"
                    : "hover:bg-terminal-panel/50"
                }`}
                onClick={() => setSelectedId(l.id)}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-semibold truncate">{l.name}</span>
                  {l.is_default && <span className="text-[9px] text-accent">★</span>}
                </div>
                <div className="text-terminal-dim">{l.item_count} tickers</div>
                <div className="mt-1 flex gap-1 text-[10px]">
                  <button className="text-terminal-dim hover:text-accent" onClick={(e) => { e.stopPropagation(); renameList(l); }}>rename</button>
                  {!l.is_default && (
                    <button className="text-terminal-dim hover:text-accent" onClick={(e) => { e.stopPropagation(); setDefault(l); }}>set default</button>
                  )}
                  <button className="text-terminal-dim hover:text-rose-400" onClick={(e) => { e.stopPropagation(); deleteList(l); }}>delete</button>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        {/* Right: items of selected */}
        <div className="overflow-auto">
          {!active && <p className="text-terminal-dim text-xs italic p-2">Select a watchlist on the left.</p>}
          {active && (
            <>
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{active.name}</div>
                  {active.description && (
                    <div className="text-xs text-terminal-dim truncate">{active.description}</div>
                  )}
                </div>
                <button onClick={addItem} className="pill text-xs hover:bg-accent hover:text-black">
                  + Add ticker
                </button>
              </div>
              {active.items.length === 0 ? (
                <p className="text-terminal-dim text-xs italic">No tickers yet.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-terminal-dim uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1 px-2">Ticker</th>
                      <th className="text-left py-1 px-2">Label</th>
                      <th className="text-left py-1 px-2">Group</th>
                      <th className="text-right py-1 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.items.map((it) => (
                      <tr key={it.ticker} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                        <td className="py-1 px-2 font-mono">{it.ticker}</td>
                        <td className="py-1 px-2 text-terminal-dim">{it.label ?? "—"}</td>
                        <td className="py-1 px-2 text-terminal-dim">{it.group_name ?? "—"}</td>
                        <td className="py-1 px-2 text-right">
                          <button
                            className="text-terminal-dim hover:text-rose-400 text-[10px]"
                            onClick={() => removeItem(it.ticker)}
                          >
                            remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
