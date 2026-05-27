import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { MacroBoard, MacroBoardSnapshot, MacroCatalog } from "../api/types";

import { MacroTileCard } from "./MacroTile";
import { MacroSeriesDetail } from "./MacroSeriesDetail";

/**
 * Macro Pinboard — Wave 5.
 *
 * User-defined dashboards of arbitrary FRED series. Persist across sessions.
 */
export function MacroPinboard() {
  const [boards, setBoards] = useState<MacroBoard[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<MacroBoardSnapshot | null>(null);
  const [catalog, setCatalog] = useState<MacroCatalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    refresh();
    api.macroCatalog().then(setCatalog).catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) { setSnapshot(null); return; }
    let alive = true;
    api.macroBoardSnapshot(active)
      .then((s) => alive && setSnapshot(s))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [active]);

  const refresh = () => {
    api.listMacroBoards().then((d) => {
      setBoards(d.boards);
      if (!active && d.boards.length) setActive(d.boards[0].id);
    }).catch((e) => setErr(String(e)));
  };

  const onCreate = async () => {
    const name = prompt("Board name?");
    if (!name) return;
    const b = await api.createMacroBoard({ name, description: "", series_ids: [] });
    refresh();
    setActive(b.id);
  };

  const onRename = async () => {
    if (!snapshot) return;
    const name = prompt("New name?", snapshot.board.name);
    if (!name) return;
    await api.updateMacroBoard(snapshot.board.id, {
      name, description: snapshot.board.description ?? "", series_ids: snapshot.board.series_ids,
    });
    refresh();
  };

  const onDelete = async () => {
    if (!snapshot) return;
    if (!confirm(`Delete board "${snapshot.board.name}"?`)) return;
    await api.deleteMacroBoard(snapshot.board.id);
    setActive(null);
    refresh();
  };

  const onAddSeries = async (id: string) => {
    if (!snapshot) return;
    if (snapshot.board.series_ids.includes(id)) return;
    const sids = [...snapshot.board.series_ids, id];
    await api.updateMacroBoard(snapshot.board.id, {
      name: snapshot.board.name,
      description: snapshot.board.description ?? "",
      series_ids: sids,
    });
    const fresh = await api.macroBoardSnapshot(snapshot.board.id);
    setSnapshot(fresh);
  };

  const onRemoveSeries = async (id: string) => {
    if (!snapshot) return;
    const sids = snapshot.board.series_ids.filter((s) => s !== id);
    await api.updateMacroBoard(snapshot.board.id, {
      name: snapshot.board.name,
      description: snapshot.board.description ?? "",
      series_ids: sids,
    });
    const fresh = await api.macroBoardSnapshot(snapshot.board.id);
    setSnapshot(fresh);
  };

  if (err) return <div className="panel h-full"><div className="panel-header"><span>Pinboard</span></div>
    <div className="panel-body text-accent-red">⚠ {err}</div></div>;

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-1">
        <BoardSidebar
          boards={boards} active={active} setActive={setActive}
          onCreate={onCreate}
        />
      </div>

      <div className={"flex flex-col gap-2 min-h-0 " + (focused ? "col-span-2" : "col-span-4")}>
        {snapshot ? (
          <BoardView
            snapshot={snapshot}
            editing={editing}
            setEditing={setEditing}
            onRename={onRename}
            onDelete={onDelete}
            onRemoveSeries={onRemoveSeries}
            onClickTile={(id) => setFocused(id)}
          />
        ) : (
          <div className="panel h-full">
            <div className="panel-header"><span>No board selected</span></div>
            <div className="panel-body text-terminal-dim">Create or pick a board on the left.</div>
          </div>
        )}
        {editing && snapshot && catalog && (
          <SeriesPicker
            catalog={catalog}
            selected={snapshot.board.series_ids}
            onAdd={onAddSeries}
            onClose={() => setEditing(false)}
          />
        )}
      </div>

      {focused && (
        <div className="col-span-2 min-h-0 overflow-auto">
          <MacroSeriesDetail seriesId={focused} onClose={() => setFocused(null)} />
        </div>
      )}
    </div>
  );
}

function BoardSidebar({
  boards, active, setActive, onCreate,
}: {
  boards: MacroBoard[];
  active: number | null;
  setActive: (id: number) => void;
  onCreate: () => void;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Pinboards</span>
        <button onClick={onCreate} className="normal-case tracking-normal text-2xs text-accent-amber hover:underline">+ new</button>
      </div>
      <div className="panel-body p-0">
        {boards.length === 0 && (
          <div className="p-3 text-terminal-dim text-xs">No boards yet. Click "+ new" to start.</div>
        )}
        <ul className="divide-y divide-terminal-divider text-xs">
          {boards.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => setActive(b.id)}
                className={"w-full text-left px-3 py-2 " + (b.id === active ? "bg-white/[0.04] text-accent-amber" : "text-terminal-text hover:bg-white/[0.02]")}
              >
                <div>{b.name}</div>
                <div className="text-2xs text-terminal-dim">
                  {b.series_ids.length} series
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BoardView({
  snapshot, editing, setEditing, onRename, onDelete, onRemoveSeries, onClickTile,
}: {
  snapshot: MacroBoardSnapshot;
  editing: boolean;
  setEditing: (b: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  onRemoveSeries: (id: string) => void;
  onClickTile: (id: string) => void;
}) {
  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <span>{snapshot.board.name}</span>
        <div className="flex items-center gap-2 normal-case tracking-normal text-2xs">
          <button onClick={() => setEditing(!editing)} className="text-terminal-muted hover:text-accent-amber">
            {editing ? "done" : "edit"}
          </button>
          <button onClick={onRename} className="text-terminal-muted hover:text-accent-amber">rename</button>
          <button onClick={onDelete} className="text-terminal-muted hover:text-accent-red">delete</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 grid grid-cols-3 gap-2 content-start auto-rows-min">
        {snapshot.tiles.length === 0 && (
          <div className="col-span-3 text-terminal-dim text-xs p-3">
            Empty board. Click "edit" to add series.
          </div>
        )}
        {snapshot.tiles.map((t) => (
          <div key={t.id} className="relative">
            <MacroTileCard tile={t} onClick={(x) => onClickTile(x.id)} />
            {editing && (
              <button
                onClick={() => onRemoveSeries(t.id)}
                className="absolute top-1 right-1 text-rose-400 hover:text-rose-300 text-2xs bg-black/40 rounded px-1.5"
              >✕</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeriesPicker({
  catalog, selected, onAdd, onClose,
}: {
  catalog: MacroCatalog;
  selected: string[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const all = useMemo(() => {
    const out: { id: string; label: string; cat: string }[] = [];
    for (const c of catalog.categories) {
      for (const s of c.series) {
        out.push({ id: s.id, label: s.label, cat: c.label });
      }
    }
    return out;
  }, [catalog]);
  const filtered = all.filter((s) =>
    !q.trim() || s.id.toLowerCase().includes(q.toLowerCase()) || s.label.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="panel" style={{ flexShrink: 0, maxHeight: 220 }}>
      <div className="panel-header">
        <span>Add series</span>
        <button onClick={onClose} className="normal-case tracking-normal text-2xs text-terminal-muted">close</button>
      </div>
      <div className="panel-body p-2 flex flex-col gap-1">
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="search…"
          className="bg-terminal-panel border border-terminal-divider text-xs px-2 py-1 outline-none focus:border-accent-amber/40"
        />
        <ul className="flex-1 overflow-auto text-xs divide-y divide-terminal-divider">
          {filtered.slice(0, 100).map((s) => {
            const has = selected.includes(s.id);
            return (
              <li key={s.id}
                  className="flex items-center justify-between px-2 py-1">
                <span className="truncate" title={s.label}>
                  <span className="text-terminal-muted">{s.id}</span> · {s.label}
                </span>
                <button
                  disabled={has}
                  onClick={() => onAdd(s.id)}
                  className={"text-2xs " + (has ? "text-terminal-dim" : "text-accent-amber hover:underline")}
                >
                  {has ? "added" : "+ add"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
