/**
 * Supply Chain Map — three-column upstream / this sector / downstream layout
 * with an SVG layer drawing arrows between columns.
 *
 * Correlated sectors shown as a separate row below.
 */
import { useRef, useLayoutEffect, useState } from "react";
import type { SectorSupplyChainResponse, SupplyChainNode } from "../api/types";

interface Props {
  data: SectorSupplyChainResponse;
  sectorName: string;
  sectorEtf: string;
  onSelectSector?: (id: string) => void;
}

/** Measured centre-Y of a DOM element relative to a container. */
function midY(el: HTMLElement, container: HTMLElement): number {
  const eRect = el.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  return eRect.top + eRect.height / 2 - cRect.top;
}

export function SectorSupplyChainMap({
  data,
  sectorName,
  sectorEtf,
  onSelectSector,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const centerRef    = useRef<HTMLDivElement>(null);
  const upRefs       = useRef<(HTMLDivElement | null)[]>([]);
  const downRefs     = useRef<(HTMLDivElement | null)[]>([]);
  const [lines, setLines] = useState<
    { x1: number; y1: number; x2: number; y2: number; color: string }[]
  >([]);

  // Measure positions after paint and build arrow coordinates
  useLayoutEffect(() => {
    const container = containerRef.current;
    const center    = centerRef.current;
    if (!container || !center) return;

    const cRect   = container.getBoundingClientRect();
    const ctRect  = center.getBoundingClientRect();
    const centerX = ctRect.left - cRect.left;
    const centerW = ctRect.width;

    const next: typeof lines = [];

    // Upstream → center
    upRefs.current.forEach((el) => {
      if (!el) return;
      const eRect = el.getBoundingClientRect();
      next.push({
        x1: eRect.right  - cRect.left,
        y1: eRect.top + eRect.height / 2 - cRect.top,
        x2: centerX,
        y2: midY(center, container),
        color: "#374151",
      });
    });

    // center → downstream
    downRefs.current.forEach((el) => {
      if (!el) return;
      const eRect = el.getBoundingClientRect();
      next.push({
        x1: centerX + centerW,
        y1: midY(center, container),
        x2: eRect.left - cRect.left,
        y2: eRect.top + eRect.height / 2 - cRect.top,
        color: "#374151",
      });
    });

    setLines(next);
  }, [data]);

  const containerH =
    Math.max(data.upstream.length, data.downstream.length, 1) * 44 + 24;

  return (
    <div className="space-y-3">
      {/* Three-column map */}
      <div
        ref={containerRef}
        className="relative"
        style={{ minHeight: containerH }}
      >
        {/* SVG arrow layer */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width="100%"
          height="100%"
          overflow="visible"
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="#374151" />
            </marker>
          </defs>
          {lines.map((l, i) => (
            <line
              key={i}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.color}
              strokeWidth={1}
              markerEnd="url(#arrowhead)"
            />
          ))}
        </svg>

        {/* Column grid */}
        <div className="grid grid-cols-3 gap-4 items-center relative">
          {/* Upstream */}
          <div className="flex flex-col gap-2 items-end">
            <span className="text-2xs text-terminal-dim uppercase tracking-wider mb-1 self-start">
              Upstream
            </span>
            {data.upstream.length === 0 ? (
              <span className="text-terminal-dim text-2xs italic">none</span>
            ) : (
              data.upstream.map((node, i) => (
                <SectorNode
                  key={node.id}
                  node={node}
                  ref={(el) => { upRefs.current[i] = el; }}
                  onClick={onSelectSector}
                  align="right"
                />
              ))
            )}
          </div>

          {/* Center — this sector */}
          <div className="flex flex-col items-center gap-1">
            <span className="text-2xs text-terminal-dim uppercase tracking-wider mb-1">
              This Sector
            </span>
            <div
              ref={centerRef}
              className="px-4 py-3 rounded border-2 border-accent bg-accent/10 text-center"
            >
              <div className="text-accent font-bold text-sm">{sectorEtf}</div>
              <div className="text-terminal-fg text-xs mt-0.5">{sectorName}</div>
            </div>
          </div>

          {/* Downstream */}
          <div className="flex flex-col gap-2 items-start">
            <span className="text-2xs text-terminal-dim uppercase tracking-wider mb-1">
              Downstream
            </span>
            {data.downstream.length === 0 ? (
              <span className="text-terminal-dim text-2xs italic">end consumer</span>
            ) : (
              data.downstream.map((node, i) => (
                <SectorNode
                  key={node.id}
                  node={node}
                  ref={(el) => { downRefs.current[i] = el; }}
                  onClick={onSelectSector}
                  align="left"
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Correlated row */}
      {data.correlated.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-terminal-border/30">
          <span className="text-2xs text-terminal-dim uppercase tracking-wider">
            Correlated:
          </span>
          {data.correlated.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectSector?.(node.id)}
              className="pill text-2xs bg-terminal-border/40 hover:bg-terminal-border/70 hover:text-accent transition-colors"
            >
              ≈ {node.name}
              {node.etf && (
                <span className="ml-1 text-terminal-dim">{node.etf}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Notes */}
      {data.notes && (
        <p className="text-2xs text-terminal-dim italic px-1">{data.notes}</p>
      )}
    </div>
  );
}

// ── Node pill ─────────────────────────────────────────────────────────────

import { forwardRef } from "react";

const SectorNode = forwardRef<
  HTMLDivElement,
  {
    node: SupplyChainNode;
    onClick?: (id: string) => void;
    align: "left" | "right";
  }
>(({ node, onClick, align }, ref) => (
  <div
    ref={ref}
    className={`flex flex-col ${align === "right" ? "items-end" : "items-start"}`}
  >
    <button
      type="button"
      onClick={() => onClick?.(node.id)}
      className="px-3 py-1.5 rounded border border-terminal-border bg-terminal-panel hover:border-accent hover:text-accent transition-colors text-left"
    >
      <div className="text-xs font-medium text-terminal-fg leading-tight">
        {node.name}
      </div>
      {node.etf && (
        <div className="text-2xs text-terminal-dim">{node.etf}</div>
      )}
    </button>
  </div>
));
SectorNode.displayName = "SectorNode";
