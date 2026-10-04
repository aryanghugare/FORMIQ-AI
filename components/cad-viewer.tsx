"use client";
import { useMemo, useState, useRef, useId, memo } from "react";
import { ZoomIn, ZoomOut, Maximize, Layers3, Crosshair } from "lucide-react";
import type { CadEntity, Drawing, Issue } from "@/lib/types";
import { arcPath } from "@/lib/geometry";
const Entity = memo(function Entity({
  entity: e,
  color,
}: {
  entity: CadEntity;
  color: string;
}) {
  const p = e.points[0];
  if (!p) return null;
  const props = {
    stroke: color,
    strokeWidth: 1.2,
    vectorEffect: "non-scaling-stroke" as const,
    fill: "none",
  };
  if (e.type === "text")
    return (
      <text
        x={p.x}
        y={-p.y}
        fontSize={110}
        fill={color}
        opacity={0.8}
        fontFamily="monospace"
      >
        {e.text}
      </text>
    );
  if (e.type === "circle")
    return <circle cx={p.x} cy={-p.y} r={e.radius} {...props} />;
  if (e.type === "arc") return <path d={arcPath(e)} {...props} />;
  const points = e.points.map((p) => `${p.x},${-p.y}`).join(" ");
  return e.closed ? (
    <polygon points={points} {...props} />
  ) : (
    <polyline points={points} {...props} />
  );
});
export default function CadViewer({
  current,
  previous,
  issues,
  selected,
  onSelect,
  compact = false,
}: {
  current?: Drawing;
  previous?: Drawing;
  issues: Issue[];
  selected?: Issue;
  onSelect?: (issue: Issue) => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<"current" | "previous" | "overlay">(
      "current",
    ),
    [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [layerPanel, setLayerPanel] = useState(false),
    [hidden, setHidden] = useState<string[]>([]);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const gridId = useId();
  const hiddenLayers = useMemo(() => new Set(hidden), [hidden]);
  const model = (mode === "previous" ? previous : current)?.model;
  const bounds = useMemo(() => {
    const models =
      mode === "overlay" ? [current?.model, previous?.model] : [model];
    const bs = models.filter(Boolean).map((m) => m!.bounds);
    return bs.length
      ? {
          minX: Math.min(...bs.map((b) => b.minX)),
          maxX: Math.max(...bs.map((b) => b.maxX)),
          minY: Math.min(...bs.map((b) => b.minY)),
          maxY: Math.max(...bs.map((b) => b.maxY)),
        }
      : { minX: 0, maxX: 12000, minY: 0, maxY: 9000 };
  }, [model, current, previous, mode]);
  const span = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      1000,
    ),
    pad = span * 0.1,
    w = bounds.maxX - bounds.minX + pad * 2,
    h = bounds.maxY - bounds.minY + pad * 2;
  const center = selected?.point ?? {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  const viewBox = `${center.x - w / zoom / 2 + offset.x} ${-center.y - h / zoom / 2 + offset.y} ${w / zoom} ${h / zoom}`;
  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const geometry = useMemo(
    () =>
      model?.entities
        .filter((e) => !hiddenLayers.has(e.layer))
        .map((e) => (
          <Entity
            key={e.id}
            entity={e}
            color={
              e.layer === "GRID"
                ? "#bfcac1"
                : e.layer === "ANNOTATIONS"
                  ? "#84928a"
                  : mode === "overlay"
                    ? "#3c7a5c"
                    : "#6c8173"
            }
          />
        )),
    [model, hiddenLayers, mode],
  );
  const previousGeometry = useMemo(
    () =>
      mode === "overlay"
        ? previous?.model?.entities
            .filter((e) => !hiddenLayers.has(e.layer))
            .map((e) => <Entity key={e.id} entity={e} color="#cea38d" />)
        : undefined,
    [mode, previous?.model, hiddenLayers],
  );
  if (!model)
    return (
      <div className="viewer-empty">
        <Layers3 size={32} />
        <h3>Your drawing canvas</h3>
        <p>Upload a processed DXF or converted DWG to view its geometry.</p>
      </div>
    );
  return (
    <div className={`cad-viewer ${compact ? "compact" : ""}`}>
      <div className="viewer-toolbar">
        <div className="segmented">
          {(["current", "previous", "overlay"] as const)
            .filter((m) => m === "current" || previous?.model)
            .map((m) => (
              <button
                key={m}
                className={mode === m ? "active" : ""}
                onClick={() => {
                  setMode(m);
                  reset();
                }}
              >
                {m === "current"
                  ? "Latest revision"
                  : m === "previous"
                    ? "Previous revision"
                    : "Overlay"}
              </button>
            ))}
        </div>
        <button
          className="icon-button"
          aria-label="Toggle drawing layers"
          onClick={() => setLayerPanel(!layerPanel)}
        >
          <Layers3 size={16} />
        </button>
      </div>
      <div className="canvas-wrap">
        <svg
          className="cad-canvas"
          viewBox={viewBox}
          role="img"
          aria-label={`CAD drawing ${current?.name}. ${issues.length} findings marked.`}
          onPointerDown={(e) => {
            if ((e.target as Element).closest("[data-marker]")) return;
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              ox: offset.x,
              oy: offset.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const unitsPerPixel = Math.max(
              w / zoom / rect.width,
              h / zoom / rect.height,
            );
            setOffset({
              x: drag.current.ox - (e.clientX - drag.current.x) * unitsPerPixel,
              y: drag.current.oy - (e.clientY - drag.current.y) * unitsPerPixel,
            });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          <defs>
            <pattern
              id={gridId}
              width={500}
              height={500}
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 500 0 L 0 0 0 500"
                fill="none"
                stroke="#edf0ed"
                strokeWidth={10}
              />
            </pattern>
          </defs>
          <rect
            x={bounds.minX - span * 10}
            y={-bounds.maxY - span * 10}
            width={span * 22}
            height={span * 22}
            fill={`url(#${gridId})`}
          />
          {previousGeometry}
          {geometry}
          {issues
            .filter((i) => i.status !== "rejected")
            .map((i) => (
              <g
                key={i.id}
                data-marker="true"
                role="button"
                tabIndex={0}
                aria-label={`Issue ${i.number}: ${i.title}`}
                onClick={() => onSelect?.(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(i);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle
                  cx={i.point.x}
                  cy={-i.point.y}
                  r={span * 0.025}
                  fill={selected?.id === i.id ? "#c96636" : "#fff3e8"}
                  stroke="#c96636"
                  strokeWidth={18}
                />
                <text
                  x={i.point.x}
                  y={-i.point.y + span * 0.007}
                  textAnchor="middle"
                  fontSize={span * 0.018}
                  fill={selected?.id === i.id ? "#fff" : "#ad522b"}
                  fontWeight={600}
                >
                  {i.number}
                </text>
              </g>
            ))}
        </svg>
        {layerPanel && (
          <div className="layer-panel">
            <strong>Drawing layers</strong>
            {model.layers.map((layer) => (
              <label key={layer}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(layer)}
                  onChange={(e) =>
                    setHidden(
                      e.target.checked
                        ? hidden.filter((l) => l !== layer)
                        : [...hidden, layer],
                    )
                  }
                />
                {layer}
              </label>
            ))}
          </div>
        )}
        <div className="canvas-label">
          <span className="status-dot" />
          {(mode === "previous" ? previous : current)?.name} <span>· mm</span>
        </div>
        <div className="zoom-controls">
          <button
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(value * 1.4, 8))}
          >
            <ZoomIn size={16} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom out"
            onClick={() => setZoom((value) => Math.max(value / 1.4, 0.5))}
          >
            <ZoomOut size={16} />
          </button>
          <button aria-label="Fit drawing" onClick={reset}>
            <Maximize size={16} />
          </button>
          {selected && (
            <button
              aria-label="Focus selected issue"
              onClick={() => {
                setZoom(2.5);
                setOffset({ x: 0, y: 0 });
              }}
            >
              <Crosshair size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="viewer-footer">
        <span>
          <i className="legend-line" />{" "}
          {mode === "overlay" ? "Latest revision" : "Drawing geometry"}
        </span>
        {mode === "overlay" && (
          <span>
            <i className="legend-line old" /> Previous revision
          </span>
        )}
        <span>
          <i className="legend-dot" /> Review finding
        </span>
        <span className="viewer-hint">Drag to pan · Use controls to zoom</span>
      </div>
    </div>
  );
}
