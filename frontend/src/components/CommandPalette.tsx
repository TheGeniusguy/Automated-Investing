import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api/client";
import type { SearchResult } from "../api/types";
import { PANEL_NAV } from "./Sidebar";

/**
 * Global command palette (Cmd-K / Ctrl-K).
 *
 * Toggles open on the keyboard shortcut, queries /api/search (debounced),
 * and merges in panel-navigation targets from the sidebar's flat PANEL_NAV.
 * Arrow keys + enter to select, Esc / click-outside to close.
 *
 *   ticker → onPickTicker(symbol) + onScrollTo("ticker-dossier")
 *   series → onScrollTo("macro-explorer")
 *   panel  → onScrollTo(key)
 */
type PaletteItem =
  | { kind: "ticker"; key: string; label: string; sublabel: string | null }
  | { kind: "series"; key: string; label: string; sublabel: string | null }
  | { kind: "panel"; key: string; label: string; sublabel: string | null };

interface Props {
  onPickTicker: (symbol: string) => void;
  onScrollTo: (panelKey: string) => void;
}

export function CommandPalette({ onPickTicker, onScrollTo }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global toggle shortcut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reset + focus on open.
  useEffect(() => {
    if (open) {
      setQ("");
      setSearchResults([]);
      setActive(0);
      // Focus after the modal mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .search(query, 20)
        .then((r) => setSearchResults(r.results))
        .catch(() => setSearchResults([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  // Merge panel-nav matches with backend search results.
  const items = useMemo<PaletteItem[]>(() => {
    const query = q.trim().toLowerCase();
    const panelMatches: PaletteItem[] = PANEL_NAV.filter(
      (p) =>
        !query ||
        p.key.toLowerCase().includes(query) ||
        p.label.toLowerCase().includes(query),
    ).map((p) => ({
      kind: "panel",
      key: p.key,
      label: p.label,
      sublabel: p.section,
    }));

    const searchItems: PaletteItem[] = searchResults.map((r) => ({
      kind: r.type,
      key: r.key,
      label: r.label,
      sublabel: r.sublabel,
    }));

    // Panels first when typing a short query (fast jumps), then data results.
    return [...panelMatches, ...searchItems];
  }, [q, searchResults]);

  // Keep the active index in range as the list changes.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);

  const select = (item: PaletteItem) => {
    if (item.kind === "ticker") {
      onPickTicker(item.key);
      onScrollTo("ticker-dossier");
    } else if (item.kind === "series") {
      onScrollTo("macro-explorer");
    } else {
      onScrollTo(item.key);
    }
    setOpen(false);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) select(item);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="panel w-full max-w-xl mx-4 flex flex-col max-h-[70vh] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header flex items-center gap-2">
          <span className="text-accent-amber font-semibold">⌘K</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search tickers, FRED series, or panels…"
            className="flex-1 bg-transparent border-none outline-none text-sm text-terminal-fg placeholder:text-terminal-dim"
          />
          <span className="text-2xs text-terminal-dim">Esc to close</span>
        </div>

        <div className="panel-body flex-1 overflow-auto p-1 text-xs">
          {items.length === 0 && (
            <p className="text-terminal-dim italic p-2">
              {q.trim() ? "No matches." : "Start typing to search."}
            </p>
          )}
          <ul>
            {items.map((item, idx) => (
              <li key={`${item.kind}:${item.key}:${idx}`}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => select(item)}
                  className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 ${
                    idx === active ? "bg-accent/20 text-accent" : "text-terminal-fg hover:bg-terminal-border/30"
                  }`}
                >
                  <span className="pill text-2xs uppercase shrink-0">{item.kind}</span>
                  <span className="font-mono shrink-0">{item.label}</span>
                  {item.sublabel && (
                    <span className="text-terminal-dim truncate">{item.sublabel}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
