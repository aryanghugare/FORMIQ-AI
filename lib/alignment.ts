import type {
  AlignmentRecord,
  Bounds,
  CadEntity,
  Point,
  RigidTransform,
} from "./types";

const IDENTITY: RigidTransform = { rotation: 0, dx: 0, dy: 0 };
const area = (b: Bounds) => (b.maxX - b.minX) * (b.maxY - b.minY);

/** Shared by analysis, viewer and reports so previous geometry is mapped identically everywhere. */
export function alignmentTransformAt(
  alignment: AlignmentRecord | undefined,
  point: Point,
  pad = 0,
): RigidTransform {
  if (!alignment) return IDENTITY;
  let best: { transform: RigidTransform; size: number } | undefined;
  for (const view of alignment.views) {
    const b = view.previousBounds;
    if (view.status !== "aligned" || !b) continue;
    if (
      point.x >= b.minX - pad &&
      point.x <= b.maxX + pad &&
      point.y >= b.minY - pad &&
      point.y <= b.maxY + pad &&
      (!best || area(b) < best.size)
    )
      best = { transform: view.transform, size: area(b) };
  }
  if (best) return best.transform;
  const g = alignment.global;
  return g.status === "aligned" ? g : IDENTITY;
}
export function entityAnchor(entity: CadEntity): Point {
  const pts = entity.points;
  if (!pts.length) return { x: 0, y: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
export function applyTransform(t: RigidTransform, p: Point): Point {
  if (!t.rotation) return { x: p.x + t.dx, y: p.y + t.dy };
  const r = (t.rotation * Math.PI) / 180;
  return {
    x: Math.cos(r) * p.x - Math.sin(r) * p.y + t.dx,
    y: Math.sin(r) * p.x + Math.cos(r) * p.y + t.dy,
  };
}
/** Entity mapped into the latest-revision frame for an aligned overlay. */
export function transformEntity(
  entity: CadEntity,
  t: RigidTransform,
): CadEntity {
  if (!t.rotation && !t.dx && !t.dy) return entity;
  const mapped: CadEntity = {
    ...entity,
    points: entity.points.map((p) => applyTransform(t, p)),
  };
  if (entity.type === "arc") {
    mapped.startAngle = (((entity.startAngle ?? 0) + t.rotation) % 360 + 360) % 360;
    mapped.endAngle = (((entity.endAngle ?? 0) + t.rotation) % 360 + 360) % 360;
  }
  if (entity.rotation !== undefined)
    mapped.rotation = (((entity.rotation + t.rotation) % 360) + 360) % 360;
  return mapped;
}
export const describeTransform = (t: RigidTransform) =>
  `${t.rotation ? `rotation ${round(t.rotation, 2)}°, ` : ""}translation (${round(t.dx, 1)}, ${round(t.dy, 1)}) mm`;
const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
