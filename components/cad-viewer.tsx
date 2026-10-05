"use client";
import { cadEntityBounds } from "@/lib/geometry";
import { useMemo, useState, useRef, useId, useEffect, memo } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  Layers3,
  Crosshair,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type {
  AlignmentRecord,
  Bounds,
  CadEntity,
  Drawing,
  Issue,
} from "@/lib/types";
import { findingMarkers } from "@/lib/finding-markers";
import { arcPath, polylinePath } from "@/lib/geometry";
import {
  alignmentTransformAt,
  entityAnchor,
  transformEntity,
} from "@/lib/alignment";
const Entity = memo(function Entity({
  entity: e,
  color,
  width = 1.2,
  textScale,
}: {
  entity: CadEntity;
  color: string;
  width?: number;
  textScale: number;
}) {
  const p = e.points[0];
  if (!p) return null;
  const props = {
    stroke: color,
    strokeWidth: width,
    vectorEffect: "non-scaling-stroke" as const,
    fill: "none",
  };
  if (e.type === "text")
    return (
      <text
        x={p.x}
        y={-p.y}
        fontSize={e.height && e.height > 0 ? e.height : textScale}
        fill={color}
        opacity={0.8}
        fontFamily="monospace"
        transform={
          e.rotation ? `rotate(${-e.rotation} ${p.x} ${-p.y})` : undefined
        }
      >
        {e.text}
      </text>
    );
  if (e.type === "circle")
    return <circle cx={p.x} cy={-p.y} r={e.radius} {...props} />;
  if (e.type === "arc") return <path d={arcPath(e)} {...props} />;
  if (e.bulges?.some(Boolean)) return <path d={polylinePath(e)} {...props} />;
  const points = e.points.map((p) => `${p.x},${-p.y}`).join(" ");
  return e.closed ? (
    <polygon points={points} {...props} />
  ) : (
    <polyline points={points} {...props} />
  );
});
const union = (boxes: (Bounds | undefined)[]): Bounds | undefined => {
  const bs = boxes.filter((b): b is Bounds => Boolean(b));
  return bs.length
    ? {
        minX: Math.min(...bs.map((b) => b.minX)),
        maxX: Math.max(...bs.map((b) => b.maxX)),
        minY: Math.min(...bs.map((b) => b.minY)),
        maxY: Math.max(...bs.map((b) => b.maxY)),
      }
    : undefined;
};
function entityBounds(entities: CadEntity[]): Bounds | undefined {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const entity of entities) {
    const b = cadEntityBounds(entity);
    if (!b) continue;
    bounds.minX = Math.min(bounds.minX, b.minX); bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.minY = Math.min(bounds.minY, b.minY); bounds.maxY = Math.max(bounds.maxY, b.maxY);
  }
  return Number.isFinite(bounds.minX) ? bounds : undefined;
}
type Mode = "current" | "previous" | "overlay";
export default function CadViewer({
  current,
  previous,
  issues,
  selected,
  onSelect,
  compact = false,
  alignment,
  tolerance = 1,
  legacy = false,
}: {
  current?: Drawing;
  previous?: Drawing;
  issues: Issue[];
  selected?: Issue;
  onSelect?: (issue: Issue) => void;
  compact?: boolean;
  /** Recorded analysis alignment; the overlay maps previous geometry exactly as the analysis did. */
  alignment?: AlignmentRecord;
  tolerance?: number;
  legacy?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(
      previous?.model ? "overlay" : "current",
    ),
    [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [layerPanel, setLayerPanel] = useState(false),
    [hidden, setHidden] = useState<string[]>([]),
    [showFindings, setShowFindings] = useState(true),
    [item, setItem] = useState(0),
    [size, setSize] = useState({ width: 900, height: 600 });
  const canvasRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [current?.id, previous?.id]);
  useEffect(() => {
    setItem(0);
    if (!selected) return;
    setShowFindings(true);
    if (!previous?.model) return;
    if (selected.change === "removed" || selected.rule === "GEO-02")
      setMode("previous");
    else if (selected.change === "added" || selected.rule === "GEO-01")
      setMode("current");
    else setMode("overlay");
  }, [selected?.id]);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const gridId = useId();
  const hiddenLayers = useMemo(() => new Set(hidden), [hidden]);
  const pad = 2 * Math.max(tolerance, 0.001);
  const alignedPrevious = useMemo(
    () =>
      previous?.model?.entities.map((e) =>
        transformEntity(e, alignmentTransformAt(alignment, entityAnchor(e), pad)),
      ) ?? [],
    [previous?.model, alignment, pad],
  );
  // Overlay and latest share the latest-revision frame; previous mode shows the drawing as uploaded.
  const model = (mode === "previous" ? previous : current)?.model;
  const bounds = useMemo(
    () =>
      (mode === "overlay"
        ? union([current?.model?.bounds, entityBounds(alignedPrevious)])
        : model?.bounds) ?? { minX: 0, maxX: 12000, minY: 0, maxY: 9000 },
    [model, current?.model, alignedPrevious, mode],
  );
  const span = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      1,
    ),
    margin = span * 0.1,
    w = bounds.maxX - bounds.minX + margin * 2,
    h = bounds.maxY - bounds.minY + margin * 2;
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  const viewBox = `${center.x - w / zoom / 2 + offset.x} ${-center.y - h / zoom / 2 + offset.y} ${w / zoom} ${h / zoom}`;
  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const unitsPerPixel = Math.max(w / zoom / size.width, h / zoom / size.height);
  const textScale = span / 120;
  // Marker positions in the frame of the displayed drawing.
  const placed = useMemo(
    () =>
      issues.flatMap((i) => {
        if (mode !== "previous") return [i];
        if (i.change === "added" || i.rule === "GEO-01") return [];
        const point =
          i.evidence?.previousPoint ??
          (i.evidence?.previousBounds &&
            {
              x: (i.evidence.previousBounds.minX + i.evidence.previousBounds.maxX) / 2,
              y: (i.evidence.previousBounds.minY + i.evidence.previousBounds.maxY) / 2,
            });
        if (point) return [{ ...i, point }];
        // Older runs have no previous-frame location; only an unaligned run can reuse the latest one.
        return !alignment || alignment.global.status !== "aligned" ? [i] : [];
      }),
    [issues, mode, alignment],
  );
  const markers = useMemo(
    () =>
      findingMarkers(
        showFindings
          ? placed.filter(
              (i) =>
                i.status !== "rejected" &&
                (!i.geometry || !hiddenLayers.has(i.geometry.layer)),
            )
          : [],
        unitsPerPixel,
        selected?.id,
      ),
    [placed, showFindings, hiddenLayers, unitsPerPixel, selected?.id],
  );
  const focusOn = (area: Bounds | undefined, point?: { x: number; y: number }) => {
    const target = point ?? (area && { x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 });
    if (!target) return;
    const nextZoom = area
      ? Math.min(
          40,
          Math.max(
            1,
            Math.min(
              w / Math.max(area.maxX - area.minX, span / 400),
              h / Math.max(area.maxY - area.minY, span / 400),
            ) / 1.6,
          ),
        )
      : 2.5;
    setZoom(nextZoom);
    setOffset({ x: target.x - center.x, y: center.y - target.y });
  };
  const evidence = selected?.evidence;
  const items = evidence?.items ?? [];
  const activeItem = items.length ? items[Math.min(item, items.length - 1)] : undefined;
  // Entities to emphasise: the selected item, otherwise the whole finding.
  const highlight = useMemo(() => {
    const prevIds = new Set(activeItem?.previousIds ?? evidence?.previousIds ?? []);
    const latestIds = new Set(activeItem?.latestIds ?? evidence?.latestIds ?? []);
    return { prevIds, latestIds };
  }, [activeItem, evidence]);
  const selectionBox =
    mode === "previous"
      ? (activeItem?.previousBounds ?? evidence?.previousBounds)
      : (activeItem?.bounds ?? evidence?.latestBounds ?? selected?.geometry?.bounds);
  const visible = (e: CadEntity) => !hiddenLayers.has(e.layer);
  const geometry = useMemo(
    () =>
      model?.entities.filter(visible).map((e) => (
        <Entity
          key={e.id}
          entity={e}
          textScale={textScale}
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
    [model, hiddenLayers, mode, textScale],
  );
  const previousGeometry = useMemo(
    () =>
      mode === "overlay"
        ? alignedPrevious
            .filter(visible)
            .map((e) => (
              <Entity key={e.id} entity={e} color="#cea38d" textScale={textScale} />
            ))
        : undefined,
    [mode, alignedPrevious, hiddenLayers, textScale],
  );
  const highlighted = useMemo(() => {
    if (!showFindings || !selected) return null;
    const previousSource = mode === "previous" ? (previous?.model?.entities ?? []) : mode === "overlay" ? alignedPrevious : [];
    const latestSource = mode === "previous" ? [] : (current?.model?.entities ?? []);
    return [
      ...previousSource
        .filter((e) => highlight.prevIds.has(e.id))
        .map((e) => <Entity key={`hp-${e.id}`} entity={e} color="#c0392b" width={3} textScale={textScale} />),
      ...latestSource
        .filter((e) => highlight.latestIds.has(e.id))
        .map((e) => <Entity key={`hl-${e.id}`} entity={e} color="#0b6fa4" width={3} textScale={textScale} />),
    ];
  }, [showFindings, selected?.id, mode, highlight, previous?.model, current?.model, alignedPrevious, textScale]);
  if (!model)
    return (
      <div className="viewer-empty">
        <Layers3 size={32} />
        <h3>Your drawing canvas</h3>
        <p>Upload a processed DXF or converted DWG to view its geometry.</p>
      </div>
    );
  const alignedNote =
    mode === "overlay" && alignment
      ? alignment.global.status === "aligned" || alignment.views.some((v) => v.status === "aligned")
        ? "Previous revision shown with the analysis alignment"
        : alignment.global.status === "ambiguous"
          ? "Alignment ambiguous — previous revision shown unaligned"
          : ""
      : "";
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
        <div className="viewer-actions">
          <button
            className="button small"
            aria-pressed={showFindings}
            onClick={() => setShowFindings((value) => !value)}
          >
            {showFindings ? "Hide findings" : "Show findings"}
          </button>
          <button
            className="icon-button"
            aria-label="Toggle drawing layers"
            onClick={() => setLayerPanel(!layerPanel)}
          >
            <Layers3 size={16} />
          </button>
        </div>
      </div>
      {legacy && (
        <p className="viewer-notice" role="note">
          This analysis was recorded before source snapshots were kept; the
          canvas shows the drawings&apos; stored models. Rerun the analysis for
          aligned evidence.
        </p>
      )}
      <div className="canvas-wrap">
        <svg
          className="cad-canvas"
          ref={canvasRef}
          viewBox={viewBox}
          role="img"
          aria-label={`CAD drawing ${current?.name}. ${markers.length} finding markers; nearby findings are clustered.`}
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
              width={span / 20}
              height={span / 20}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${span / 20} 0 L 0 0 0 ${span / 20}`}
                fill="none"
                stroke="#edf0ed"
                strokeWidth={span / 1000}
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
          {highlighted}
          {showFindings && selectionBox && (
            <rect
              x={selectionBox.minX - unitsPerPixel * 4}
              y={-selectionBox.maxY - unitsPerPixel * 4}
              width={selectionBox.maxX - selectionBox.minX + unitsPerPixel * 8}
              height={selectionBox.maxY - selectionBox.minY + unitsPerPixel * 8}
              fill="#f2a35c"
              fillOpacity={0.1}
              stroke="#b65a24"
              strokeWidth={2 * unitsPerPixel}
              strokeDasharray={`${6 * unitsPerPixel} ${4 * unitsPerPixel}`}
              pointerEvents="none"
            />
          )}
          {markers.map(({ point, issues: group }) => {
            const issue = group[0],
              clustered = group.length > 1;
            const active = selected?.id === issue.id && !clustered;
            const activate = () => {
              if (clustered) {
                setZoom(Math.min(zoom * 1.8, 40));
                setOffset({ x: point.x - center.x, y: center.y - point.y });
              } else onSelect?.(issues.find((i) => i.id === issue.id) ?? issue);
            };
            return (
              <g
                key={issue.id}
                data-marker="true"
                role="button"
                tabIndex={0}
                aria-label={
                  clustered
                    ? `${group.length} nearby findings. Zoom to inspect.`
                    : `Issue ${issue.number}: ${issue.title}`
                }
                onClick={activate}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <title>
                  {clustered
                    ? `${group.length} nearby findings — zoom in or choose one in the list`
                    : issue.title}
                </title>
                <circle
                  cx={point.x}
                  cy={-point.y}
                  r={unitsPerPixel * (clustered ? 17 : 13)}
                  fill={active ? "#b65a24" : clustered ? "#0c7196" : "#fff3e8"}
                  stroke={clustered ? "#ffffff" : "#b65a24"}
                  strokeWidth={unitsPerPixel * 1.5}
                />
                <text
                  x={point.x}
                  y={-point.y}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={unitsPerPixel * 11}
                  fill={active || clustered ? "#ffffff" : "#934619"}
                  fontWeight={600}
                  pointerEvents="none"
                >
                  {clustered ? group.length : issue.number}
                </text>
              </g>
            );
          })}
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
          {alignedNote && <span> · {alignedNote}</span>}
        </div>
        {showFindings && items.length > 1 && (
          <div className="item-navigator" role="group" aria-label="Changes inside this finding">
            <button
              aria-label="Previous change in this finding"
              onClick={() => {
                const next = (item - 1 + items.length) % items.length;
                setItem(next);
                focusOn(mode === "previous" ? items[next].previousBounds : items[next].bounds);
              }}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              Change {Math.min(item, items.length - 1) + 1} of {items.length}
              {evidence?.omittedItems ? ` (+${evidence.omittedItems})` : ""} ·{" "}
              {activeItem?.change}
            </span>
            <button
              aria-label="Next change in this finding"
              onClick={() => {
                const next = (item + 1) % items.length;
                setItem(next);
                focusOn(mode === "previous" ? items[next].previousBounds : items[next].bounds);
              }}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        <div className="zoom-controls">
          <button
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(value * 1.4, 40))}
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
                const marker = placed.find((i) => i.id === selected.id);
                focusOn(selectionBox, selectionBox ? undefined : marker?.point);
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
        {selected && showFindings && (
          <span>
            <i className="legend-line highlight" /> Selected finding entities
          </span>
        )}
        <span>
          <i className="legend-dot" /> Review finding
        </span>
        <span className="viewer-hint">
          Drag to pan · Blue markers group nearby findings · Zoom or use the
          list
        </span>
      </div>
    </div>
  );
}
