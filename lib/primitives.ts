import { bulgeArc } from "./geometry";
import type { Bounds, CadEntity, Point, RigidTransform } from "./types";

export type PrimKind = "seg" | "arc" | "circle" | "text";
export type LayerClass =
  | "geometry"
  | "text"
  | "dimension"
  | "grid"
  | "title block"
  | "annotation";
/** One comparable primitive. Lines and polyline edges are both segments. */
export interface Prim {
  entity: CadEntity;
  kind: PrimKind;
  /** Segment endpoints, arc start/end points (counterclockwise), or circle/text anchor. */
  a: Point;
  b: Point;
  c?: Point;
  r?: number;
  start?: number;
  end?: number;
  text?: string;
  rotation?: number;
  height?: number;
  cls: LayerClass;
  mid: Point;
  length: number;
  /** Segment direction in degrees, [0, 180). */
  angle: number;
  bounds: Bounds;
}

const GRID = new Set(["GRID", "GRIDS", "GRD", "AXIS", "AXES", "GRIDLINE"]);
const TITLE = new Set([
  "TITLE",
  "TITLEBLOCK",
  "TB",
  "TBLK",
  "BORDER",
  "FRAME",
  "SHEET",
]);
const ANNOTATION = new Set([
  "DIM",
  "DIMS",
  "DIMENSION",
  "DIMENSIONS",
  "ANNO",
  "ANNOT",
  "ANNOTATION",
  "ANNOTATIONS",
  "TEXT",
  "TXT",
  "NOTE",
  "NOTES",
  "TAG",
  "TAGS",
  "LABEL",
  "LABELS",
  "SYMB",
  "SYMBOL",
  "SYMBOLS",
  "KEYNOTE",
  "KEYNOTES",
  "DEFPOINTS",
  "IDEN",
]);
/** Layer-name evidence only; unknown layers stay ordinary drawing geometry. */
export function layerClass(entity: CadEntity): LayerClass {
  if (entity.role === "dimension") return "dimension";
  if (entity.type === "text") return "text";
  const tokens = entity.layer.toUpperCase().split(/[^A-Z0-9]+/);
  if (tokens.some((t) => GRID.has(t))) return "grid";
  if (tokens.some((t) => TITLE.has(t))) return "title block";
  if (tokens.some((t) => ANNOTATION.has(t))) return "annotation";
  return "geometry";
}
export const isAnnotationClass = (cls: LayerClass) => cls !== "geometry";

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const IDENTITY: RigidTransform = { rotation: 0, dx: 0, dy: 0 };
export const isIdentity = (t: RigidTransform, eps: number) =>
  Math.abs(t.dx) <= eps &&
  Math.abs(t.dy) <= eps &&
  Math.abs(normalizeDegrees(t.rotation + 180) - 180) < 1e-6;
export const normalizeDegrees = (d: number) => ((d % 360) + 360) % 360;
export function apply(t: RigidTransform, p: Point): Point {
  if (!t.rotation) return { x: p.x + t.dx, y: p.y + t.dy };
  const r = (t.rotation * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r);
  return {
    x: cos * p.x - sin * p.y + t.dx,
    y: sin * p.x + cos * p.y + t.dy,
  };
}
export function invert(t: RigidTransform): RigidTransform {
  const r = (-t.rotation * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r);
  return {
    rotation: -t.rotation,
    dx: -(cos * t.dx - sin * t.dy),
    dy: -(sin * t.dx + cos * t.dy),
  };
}
export const emptyBounds = (): Bounds => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});
export function extendBounds(target: Bounds, b: Bounds) {
  target.minX = Math.min(target.minX, b.minX);
  target.minY = Math.min(target.minY, b.minY);
  target.maxX = Math.max(target.maxX, b.maxX);
  target.maxY = Math.max(target.maxY, b.maxY);
  return target;
}
export const boundsOf = (points: Point[], pad = 0): Bounds => ({
  minX: Math.min(...points.map((p) => p.x)) - pad,
  minY: Math.min(...points.map((p) => p.y)) - pad,
  maxX: Math.max(...points.map((p) => p.x)) + pad,
  maxY: Math.max(...points.map((p) => p.y)) + pad,
});
export const intersects = (a: Bounds, b: Bounds, pad = 0) =>
  a.minX - pad <= b.maxX &&
  b.minX - pad <= a.maxX &&
  a.minY - pad <= b.maxY &&
  b.minY - pad <= a.maxY;
export const contains = (outer: Bounds, inner: Bounds, pad = 0) =>
  inner.minX >= outer.minX - pad &&
  inner.maxX <= outer.maxX + pad &&
  inner.minY >= outer.minY - pad &&
  inner.maxY <= outer.maxY + pad;
export const center = (b: Bounds): Point => ({
  x: (b.minX + b.maxX) / 2,
  y: (b.minY + b.maxY) / 2,
});
export const diagonal = (b: Bounds) =>
  Math.hypot(b.maxX - b.minX, b.maxY - b.minY);

const polar = (c: Point, r: number, degrees: number): Point => ({
  x: c.x + r * Math.cos((degrees * Math.PI) / 180),
  y: c.y + r * Math.sin((degrees * Math.PI) / 180),
});
const sweepOf = (start: number, end: number) => {
  const s = normalizeDegrees(end - start);
  return s === 0 ? 360 : s;
};
function arcBounds(c: Point, r: number, start: number, end: number): Bounds {
  const pts = [polar(c, r, start), polar(c, r, end)];
  const sweep = sweepOf(start, end);
  for (const q of [0, 90, 180, 270])
    if (normalizeDegrees(q - start) <= sweep) pts.push(polar(c, r, q));
  return boundsOf(pts);
}
function textBounds(p: Point, text: string, height = 0, rotation = 0): Bounds {
  if (!height) return boundsOf([p]);
  const w = Math.max(text.length, 1) * height * 0.6;
  const r = (rotation * Math.PI) / 180;
  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: height },
    { x: 0, y: height },
  ].map((q) => ({
    x: p.x + q.x * Math.cos(r) - q.y * Math.sin(r),
    y: p.y + q.x * Math.sin(r) + q.y * Math.cos(r),
  }));
  return boundsOf(corners);
}
function segment(entity: CadEntity, a: Point, b: Point, cls: LayerClass): Prim {
  return {
    entity,
    kind: "seg",
    a,
    b,
    cls,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    length: dist(a, b),
    angle: normalizeDegrees((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 180,
    bounds: boundsOf([a, b]),
  };
}
function arc(
  entity: CadEntity,
  c: Point,
  r: number,
  start: number,
  end: number,
  cls: LayerClass,
): Prim {
  const sweep = sweepOf(start, end);
  return {
    entity,
    kind: "arc",
    a: polar(c, r, start),
    b: polar(c, r, end),
    c,
    r,
    start: normalizeDegrees(start),
    end: normalizeDegrees(end),
    cls,
    mid: polar(c, r, start + sweep / 2),
    length: (r * sweep * Math.PI) / 180,
    angle: 0,
    bounds: arcBounds(c, r, start, end),
  };
}
/** Decompose entities into comparable primitives; polyline bulges become true arcs. */
export function primitives(entities: CadEntity[]): Prim[] {
  const result: Prim[] = [];
  for (const entity of entities) {
    const cls = layerClass(entity);
    const pts = entity.points;
    if (!pts.length) continue;
    if (entity.type === "text") {
      const text = (entity.text ?? "").replace(/\s+/g, " ").trim();
      result.push({
        entity,
        kind: "text",
        a: pts[0],
        b: pts[0],
        text,
        rotation: entity.rotation,
        height: entity.height,
        cls,
        mid: pts[0],
        length: 0,
        angle: 0,
        bounds: textBounds(pts[0], text, entity.height, entity.rotation),
      });
    } else if (entity.type === "circle") {
      const r = entity.radius ?? 0;
      result.push({
        entity,
        kind: "circle",
        a: pts[0],
        b: pts[0],
        c: pts[0],
        r,
        cls,
        mid: pts[0],
        length: 2 * Math.PI * r,
        angle: 0,
        bounds: boundsOf([pts[0]], r),
      });
    } else if (entity.type === "arc")
      result.push(
        arc(
          entity,
          pts[0],
          entity.radius ?? 0,
          entity.startAngle ?? 0,
          entity.endAngle ?? 0,
          cls,
        ),
      );
    else {
      const count =
        entity.type === "polyline" && entity.closed && pts.length > 2
          ? pts.length
          : pts.length - 1;
      let emitted = 0;
      for (let i = 0; i < count; i++) {
        const a = pts[i],
          b = pts[(i + 1) % pts.length];
        if (dist(a, b) === 0) continue;
        const bulge = entity.bulges?.[i] ?? 0;
        if (bulge) {
          const g = bulgeArc(a, b, bulge);
          result.push(arc(entity, g.center, g.radius, g.startAngle, g.endAngle, cls));
        } else result.push(segment(entity, a, b, cls));
        emitted++;
      }
      // A degenerate entity must remain visible to the comparison.
      if (!emitted) result.push(segment(entity, pts[0], pts[0], cls));
    }
  }
  // Canonical order makes matching independent of CAD entity order.
  const q = (v: number) => Math.round(v * 1000);
  return result
    .map((p) => ({ p, key: [kindOrder[p.kind], q(p.mid.x), q(p.mid.y), q(p.length), p.text ?? ""] as const }))
    .sort((x, y) => {
      for (let i = 0; i < 4; i++) {
        const d = (x.key[i] as number) - (y.key[i] as number);
        if (d) return d;
      }
      return x.key[4] < y.key[4] ? -1 : x.key[4] > y.key[4] ? 1 : 0;
    })
    .map(({ p }) => p);
}
const kindOrder: Record<PrimKind, number> = { seg: 0, arc: 1, circle: 2, text: 3 };

/** Primitive geometry mapped through a rigid transform. */
export function transformPrim(p: Prim, t: RigidTransform): Prim {
  if (isIdentity(t, 0)) return p;
  const a = apply(t, p.a),
    b = apply(t, p.b);
  const c = p.c ? apply(t, p.c) : undefined;
  const mid = apply(t, p.mid);
  let bounds: Bounds;
  let start = p.start,
    end = p.end;
  if (p.kind === "arc") {
    start = normalizeDegrees(p.start! + t.rotation);
    end = normalizeDegrees(p.end! + t.rotation);
    bounds = arcBounds(c!, p.r!, start, end);
  } else if (p.kind === "circle") bounds = boundsOf([c!], p.r!);
  else if (p.kind === "text")
    bounds = textBounds(a, p.text ?? "", p.height, (p.rotation ?? 0) + t.rotation);
  else bounds = boundsOf([a, b]);
  return {
    ...p,
    a,
    b,
    c,
    mid,
    start,
    end,
    rotation:
      p.rotation === undefined ? undefined : normalizeDegrees(p.rotation + t.rotation),
    angle:
      p.kind === "seg" ? normalizeDegrees(p.angle + t.rotation) % 180 : p.angle,
    bounds,
  };
}

/** Distance score when two primitives coincide within eps, otherwise undefined. */
export function coincide(p: Prim, q: Prim, eps: number): number | undefined {
  if (p.kind !== q.kind || isAnnotationClass(p.cls) !== isAnnotationClass(q.cls)) return;
  if (p.kind === "seg") {
    const forward = Math.max(dist(p.a, q.a), dist(p.b, q.b)),
      reverse = Math.max(dist(p.a, q.b), dist(p.b, q.a));
    const score = Math.min(forward, reverse);
    return score <= eps ? score : undefined;
  }
  if (p.kind === "circle") {
    const score = Math.max(dist(p.c!, q.c!), Math.abs(p.r! - q.r!));
    return score <= eps ? score : undefined;
  }
  if (p.kind === "arc") {
    const score = Math.max(
      dist(p.c!, q.c!),
      Math.abs(p.r! - q.r!),
      dist(p.a, q.a),
      dist(p.b, q.b),
      dist(p.mid, q.mid),
    );
    return score <= eps ? score : undefined;
  }
  if (p.text !== q.text) return;
  if (
    p.rotation !== undefined &&
    q.rotation !== undefined &&
    Math.abs(normalizeDegrees(p.rotation - q.rotation + 180) - 180) > 1
  )
    return;
  if (p.height && q.height && Math.abs(p.height - q.height) > Math.max(eps, 0.05 * p.height))
    return;
  const score = dist(p.a, q.a);
  return score <= eps ? score : undefined;
}

export class PointGrid {
  private cells = new Map<string, number[]>();
  constructor(private cell: number) {}
  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  insert(index: number, p: Point) {
    const k = this.key(p.x, p.y);
    const list = this.cells.get(k);
    if (list) list.push(index);
    else this.cells.set(k, [index]);
  }
  near(p: Point, radius: number, limit = Infinity): number[] {
    const result: number[] = [];
    const span = Math.max(1, Math.ceil(radius / this.cell));
    const cx = Math.floor(p.x / this.cell),
      cy = Math.floor(p.y / this.cell);
    for (let dx = -span; dx <= span; dx++)
      for (let dy = -span; dy <= span; dy++) {
        const list = this.cells.get(`${cx + dx},${cy + dy}`);
        if (list) for (const i of list) {
          result.push(i);
          if (result.length > limit) return result;
        }
      }
    return result;
  }
}

/**
 * One-to-one tolerance matching. Each previous primitive is mapped through its own transform
 * and claims the closest unclaimed coincident latest primitive. Duplicates are preserved.
 */
export function matchPrims(
  previous: Prim[],
  latest: Prim[],
  eps: number,
  transformFor: (index: number) => RigidTransform,
  previousSubset?: number[],
  latestSubset?: number[],
) {
  const grid = new PointGrid(Math.max(eps * 2, 1e-6));
  const latestIndices = latestSubset ?? latest.map((_, i) => i);
  for (const i of latestIndices) grid.insert(i, latest[i].mid);
  const allowed = latestSubset ? new Set(latestSubset) : undefined;
  const latestFor = new Map<number, number>();
  const claimed = new Set<number>();
  for (const i of previousSubset ?? previous.map((_, k) => k)) {
    const p = transformPrim(previous[i], transformFor(i));
    let best: number | undefined,
      bestScore = Infinity;
    for (const j of grid.near(p.mid, eps)) {
      if (claimed.has(j) || (allowed && !allowed.has(j))) continue;
      const score = coincide(p, latest[j], eps);
      if (score !== undefined && (score < bestScore || (score === bestScore && j < best!))) {
        best = j;
        bestScore = score;
      }
    }
    if (best !== undefined) {
      claimed.add(best);
      latestFor.set(i, best);
    }
  }
  return latestFor;
}

/** Sample points along primitive geometry for rasterized clustering. */
function samples(p: Prim, step: number): Point[] {
  if (p.kind === "text")
    return [
      p.a,
      { x: p.bounds.minX, y: p.bounds.minY },
      { x: p.bounds.maxX, y: p.bounds.maxY },
    ];
  const n = Math.min(4000, Math.max(1, Math.ceil(p.length / step)));
  if (p.kind === "seg")
    return Array.from({ length: n + 1 }, (_, k) => ({
      x: p.a.x + ((p.b.x - p.a.x) * k) / n,
      y: p.a.y + ((p.b.y - p.a.y) * k) / n,
    }));
  const sweep = p.kind === "circle" ? 360 : sweepOf(p.start!, p.end!);
  const start = p.kind === "circle" ? 0 : p.start!;
  return Array.from({ length: n + 1 }, (_, k) => polar(p.c!, p.r!, start + (sweep * k) / n));
}

/**
 * Spatial clusters: primitives within roughly one cell of each other join, then clusters whose
 * extents overlap merge. With `frames`, a sparse cluster enclosing several substantial clusters
 * (a sheet border) is kept separate instead of absorbing them.
 */
export function cluster(
  prims: Prim[],
  indices: number[],
  cell: number,
  frames = false,
): number[][] {
  if (!indices.length) return [];
  const parent = new Map<number, number>(indices.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(i) !== root) {
      const next = parent.get(i)!;
      parent.set(i, root);
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const owner = new Map<string, number>();
  const touched: [number, number, number][] = [];
  for (const i of indices) {
    for (const s of samples(prims[i], cell / 2)) {
      const cx = Math.floor(s.x / cell),
        cy = Math.floor(s.y / cell),
        k = `${cx},${cy}`;
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else union(o, i);
      touched.push([i, cx, cy]);
    }
  }
  for (const [i, cx, cy] of touched)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const o = owner.get(`${cx + dx},${cy + dy}`);
        if (o !== undefined) union(o, i);
      }
  const groups = new Map<number, number[]>();
  for (const i of indices) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  let list = [...groups.values()].map((members) => ({
    members,
    bounds: members.reduce((b, i) => extendBounds(b, prims[i].bounds), emptyBounds()),
    frame: false,
  }));
  if (list.length > 3000) return list.map((g) => g.members);
  if (frames) {
    const substantial = Math.max(8, indices.length * 0.05);
    for (const g of list) {
      const inside = list.filter(
        (o) => o !== g && o.members.length >= substantial && contains(g.bounds, o.bounds),
      );
      g.frame =
        inside.length >= 2 &&
        inside.reduce((n, o) => n + o.members.length, 0) >= 2 * g.members.length;
    }
  }
  for (let changed = true, passes = 0; changed && passes < 50; passes++) {
    changed = false;
    list.sort((a, b) => a.bounds.minX - b.bounds.minX);
    const removed = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.frame || removed.has(i)) continue;
      for (let j = i + 1; j < list.length && list[j].bounds.minX <= a.bounds.maxX; j++) {
        const b = list[j];
        if (removed.has(j) || b.frame || !intersects(a.bounds, b.bounds)) continue;
        for (const m of b.members) a.members.push(m);
        extendBounds(a.bounds, b.bounds);
        removed.add(j);
        changed = true;
      }
    }
    list = list.filter((_, i) => !removed.has(i));
  }
  return list.map((g) => g.members);
}
