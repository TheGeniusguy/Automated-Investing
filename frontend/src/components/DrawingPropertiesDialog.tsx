import { useState, useEffect } from "react";
import type { Drawing } from "../api/types";

interface Props {
  drawing: Drawing | null;
  onClose: () => void;
  onSave: (id: number, patch: { style?: Record<string, unknown>; label?: string }) => void;
  onDelete: (id: number) => void;
}

const COLOR_PRESETS = ["#ffb800", "#5fb878", "#ef5350", "#8b5cf6", "#26a69a",
                       "#06b6d4", "#fb7185", "#84cc16", "#f59e0b", "#a78bfa"];
const LINE_STYLES = ["solid", "dashed", "dotted"] as const;

export function DrawingPropertiesDialog({ drawing, onClose, onSave, onDelete }: Props) {
  const [color, setColor] = useState("#ffb800");
  const [width, setWidth] = useState(1);
  const [style, setStyle] = useState<"solid" | "dashed" | "dotted">("solid");
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!drawing) return;
    setColor(String(drawing.style.color ?? "#ffb800"));
    setWidth(Number(drawing.style.line_width ?? 1));
    setStyle((drawing.style.line_style ?? "solid") as "solid" | "dashed" | "dotted");
    setLabel(drawing.label ?? "");
  }, [drawing?.id]);

  if (!drawing) return null;

  const save = () => {
    onSave(drawing.id, {
      style: { ...drawing.style, color, line_width: width, line_style: style },
      label,
    });
    onClose();
  };

  return (
    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-terminal-panel border border-terminal-border rounded p-4 w-[360px] text-xs space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-accent font-semibold">Drawing properties</h3>
          <button onClick={onClose} className="text-terminal-dim hover:text-accent">✕</button>
        </div>
        <div className="text-terminal-dim text-[10px]">
          {drawing.drawing_type} · id {drawing.id}
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase text-terminal-dim">Color</label>
          <div className="flex flex-wrap gap-1">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={`w-6 h-6 rounded border-2 ${color === c ? "border-white" : "border-transparent"}`}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-6 h-6 rounded bg-transparent border-0"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] uppercase text-terminal-dim">Width</label>
            <input
              type="number" min={1} max={5} value={width}
              onChange={(e) => setWidth(Number(e.target.value) || 1)}
              className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase text-terminal-dim">Style</label>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as "solid" | "dashed" | "dotted")}
              className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1"
            >
              {LINE_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[10px] uppercase text-terminal-dim">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional label"
            className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1"
          />
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-terminal-border">
          <button
            onClick={() => { onDelete(drawing.id); onClose(); }}
            className="text-rose-400 hover:text-rose-300 text-[10px]"
          >
            Delete drawing
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="pill text-[10px]">Cancel</button>
            <button onClick={save} className="pill text-[10px] bg-accent text-black">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
