import { register, type Registration } from "./registration";
import { alignmentTransformAt, entityAnchor } from "./alignment";
import {
  cluster,
  dist,
  emptyBounds,
  extendBounds,
  intersects,
  matchPrims,
  normalizeDegrees,
  primitives,
  diagonal,
  transformPrim,
  type LayerClass,
  type Prim,
} from "./primitives";
import type { Bounds, CadModel } from "./types";

export type Family = "geometry" | "text" | "annotation";
export const familyOf = (cls: LayerClass): Family =>
  cls === "geometry" ? "geometry" : cls === "text" ? "text" : "annotation";
export interface ChangeGroup {
  change: "added" | "removed" | "modified" | "moved" | "uncertain";
  family: Family;
  classes: LayerClass[];
  /** Indices into `previous` / `latest` primitive lists. */
  previous: number[];
  latest: number[];
  /** Latest-revision frame (previous geometry mapped through the alignment). */
  bounds: Bounds;
  previousBounds?: Bounds;
  basis: string;
  confidence: "high" | "medium" | "low";
  delta?: { dx?: number; dy?: number; length?: number; radius?: number };
  view?: string;
  parts?: ChangeGroup[];
}
export interface GeometryComparison {
  previous: Prim[];
  latest: Prim[];
  registration: Registration;
  groups: ChangeGroup[];
  stats: Record<string, number>;
}
const r1 = (v: number) => Math.round(v * 10) / 10;
const angleGap = (a: number, b: number) =>
  Math.abs((normalizeDegrees(a - b + 90) % 180) - 90);

/** Collinear runs that cover the same extent are equivalent segmentations of one line. */
function segmentation(
  aligned: Prim[],
  latest: Prim[],
  up: number[],
  ul: number[],
  eps: number,
) {
  type Entry = { side: 0 | 1; i: number; theta: number; d: number; p: Prim };
  const entries: Entry[] = [];
  for (const [side, list, idx] of [
    [0, aligned, up],
    [1, latest, ul],
  ] as const)
    for (const i of idx) {
      const p = list[i];
      if (p.kind !== "seg" || p.length <= eps) continue;
      const theta = p.angle >= 179.95 ? p.angle - 180 : p.angle;
      const r = (theta * Math.PI) / 180;
      entries.push({ side, i, theta, d: -Math.sin(r) * p.a.x + Math.cos(r) * p.a.y, p });
    }
  const byAngle = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = `${familyOf(e.p.cls)}:${Math.round(e.theta * 10)}`;
    byAngle.set(k, [...(byAngle.get(k) ?? []), e]);
  }
  const prevMatched = new Set<number>(),
    latestMatched = new Set<number>();
  for (const bucket of byAngle.values()) {
    bucket.sort((a, b) => a.d - b.d);
    const lines: Entry[][] = [];
    for (const e of bucket) {
      const last = lines.at(-1);
      if (last && Math.abs(e.d - last[0].d) <= eps) last.push(e);
      else lines.push([e]);
    }
    for (const line of lines) {
      if (!line.some((e) => e.side === 0) || !line.some((e) => e.side === 1)) continue;
      const r = (line[0].theta * Math.PI) / 180,
        ux = Math.cos(r),
        uy = Math.sin(r);
      const runs = (side: 0 | 1) => {
        const spans = line
          .filter((e) => e.side === side)
          .map((e) => {
            const t1 = e.p.a.x * ux + e.p.a.y * uy,
              t2 = e.p.b.x * ux + e.p.b.y * uy;
            return { i: e.i, t1: Math.min(t1, t2), t2: Math.max(t1, t2) };
          })
          .sort((a, b) => a.t1 - b.t1 || a.t2 - b.t2);
        const result: { t1: number; t2: number; members: number[] }[] = [];
        for (const s of spans) {
          const run = result.at(-1);
          // Only abutting pieces merge; overlapping duplicates remain separate instances.
          if (run && Math.abs(s.t1 - run.t2) <= eps) {
            run.t2 = s.t2;
            run.members.push(s.i);
          } else result.push({ t1: s.t1, t2: s.t2, members: [s.i] });
        }
        return result;
      };
      const before = runs(0),
        after = runs(1);
      const used = new Set<number>();
      const lowerBound = (start: number) => {
        let lo = 0, hi = after.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (after[mid].t1 < start) lo = mid + 1; else hi = mid; }
        return lo;
      };
      for (const a of before)
        for (let k = lowerBound(a.t1 - eps); k < after.length && after[k].t1 <= a.t1 + eps; k++) {
          const b = after[k];
          if (used.has(k) || (a.members.length < 2 && b.members.length < 2)) continue;
          if (Math.abs(a.t1 - b.t1) <= eps && Math.abs(a.t2 - b.t2) <= eps) {
            used.add(k);
            a.members.forEach((i) => prevMatched.add(i));
            b.members.forEach((j) => latestMatched.add(j));
            break;
          }
        }
    }
  }
  return { prevMatched, latestMatched };
}

/** Evidence that a previous primitive was edited into a latest primitive. */
function relation(p: Prim, q: Prim, eps: number) {
  if (p.kind === "seg" && q.kind === "seg") {
    if (angleGap(p.angle, q.angle) > 0.2) return;
    const r = (p.angle * Math.PI) / 180;
    const off = (pt: { x: number; y: number }) =>
      Math.abs(-Math.sin(r) * (pt.x - p.a.x) + Math.cos(r) * (pt.y - p.a.y));
    const shared = Math.min(dist(p.a, q.a), dist(p.a, q.b), dist(p.b, q.a), dist(p.b, q.b));
    if (off(q.a) <= eps && off(q.b) <= eps && shared <= eps)
      return { type: "length" as const, score: 0, length: q.length - p.length };
    if (Math.abs(p.length - q.length) <= eps)
      return { type: "offset" as const, score: 1, dx: q.mid.x - p.mid.x, dy: q.mid.y - p.mid.y };
    return;
  }
  if ((p.kind === "arc" || p.kind === "circle") && p.kind === q.kind) {
    if (p.kind === "arc" && (Math.abs(normalizeDegrees(p.start! - q.start! + 180) - 180) > 0.2 || Math.abs(normalizeDegrees(p.end! - q.end! + 180) - 180) > 0.2)) return;
    if (dist(p.c!, q.c!) <= eps)
      return { type: "radius" as const, score: 0, radius: q.r! - p.r! };
    if (Math.abs(p.r! - q.r!) <= eps)
      return { type: "offset" as const, score: 1, dx: q.c!.x - p.c!.x, dy: q.c!.y - p.c!.y };
    return;
  }
  if (p.kind === "text" && q.kind === "text") {
    if (dist(p.a, q.a) <= eps) return { type: "text" as const, score: 0 };
    if (p.text === q.text)
      return { type: "offset" as const, score: 1, dx: q.a.x - p.a.x, dy: q.a.y - p.a.y };
  }
}

export function compareGeometry(
  previousModel: CadModel,
  latestModel: CadModel,
  eps: number,
): GeometryComparison {
  // Dimension definition lines are compared by the dimension rules, not as drawn geometry.
  const previous = primitives(previousModel.entities).filter((p) => p.cls !== "dimension");
  const latest = primitives(latestModel.entities).filter((p) => p.cls !== "dimension");
  // Text and sheet annotations must not determine the physical drawing frame.
  const physicalPrevious = previous.map((p, i) => ({ p, i })).filter(({ p }) => p.cls === "geometry");
  const physicalLatest = latest.map((p, i) => ({ p, i })).filter(({ p }) => p.cls === "geometry");
  const registration = register(physicalPrevious.map(({ p }) => p), physicalLatest.map(({ p }) => p), eps);
  registration.previousViews.forEach((v) => { v.members = v.members.map((i) => physicalPrevious[i].i); });
  registration.latestViews.forEach((v) => { v.members = v.members.map((i) => physicalLatest[i].i); });
  registration.transformFor = (i) => alignmentTransformAt(registration.alignment, entityAnchor(previous[i].entity), 2 * eps);
  const aligned = previous.map((p, i) => transformPrim(p, registration.transformFor(i)));
  const exact = matchPrims(previous, latest, eps, registration.transformFor);
  const latestExact = new Set(exact.values());
  const up = previous.map((_, i) => i).filter((i) => !exact.has(i));
  const ul = latest.map((_, j) => j).filter((j) => !latestExact.has(j));
  const seg = segmentation(aligned, latest, up, ul, eps);
  const remainingPrev = up.filter((i) => !seg.prevMatched.has(i));
  const remainingLatest = ul.filter((j) => !seg.latestMatched.has(j));
  const extent = extendBounds(
    aligned.reduce((b, p) => extendBounds(b, p.bounds), emptyBounds()),
    latest.reduce((b, p) => extendBounds(b, p.bounds), emptyBounds()),
  );
  const diag = Number.isFinite(extent.minX) ? diagonal(extent) : 1;
  const cell = Math.max(2 * eps, diag / 400);
  type Component = {
    members: number[];
    family: Family;
    bounds: Bounds;
    centroid: { x: number; y: number };
    length: number;
    signature: string;
  };
  const components = (list: Prim[], idx: number[]): Component[] => {
    const result: Component[] = [];
    for (const family of ["geometry", "text", "annotation"] as Family[]) {
      const subset = idx.filter((i) => familyOf(list[i].cls) === family);
      for (const members of cluster(list, subset, cell)) {
        const kinds: Record<string, number> = {};
        let cx = 0,
          cy = 0,
          length = 0;
        const bounds = emptyBounds();
        for (const i of members) {
          const p = list[i];
          kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
          cx += p.mid.x;
          cy += p.mid.y;
          length += p.length;
          extendBounds(bounds, p.bounds);
        }
        result.push({
          members,
          family,
          bounds,
          centroid: { x: cx / members.length, y: cy / members.length },
          length,
          signature: `${family}|${members.length}|${Object.entries(kinds).sort().join(";")}`,
        });
      }
    }
    return result;
  };
  const before = components(aligned, remainingPrev);
  const after = components(latest, remainingLatest);
  const groups: ChangeGroup[] = [];
  const unionBounds = (a: number[], b: number[]) => {
    const box = emptyBounds();
    for (const i of a) extendBounds(box, aligned[i].bounds);
    for (const j of b) extendBounds(box, latest[j].bounds);
    return box;
  };
  const previousBoundsOf = (a: number[]) =>
    a.length ? a.reduce((box, i) => extendBounds(box, previous[i].bounds), emptyBounds()) : undefined;
  const classesOf = (a: number[], b: number[]) => [
    ...new Set([...a.map((i) => previous[i].cls), ...b.map((j) => latest[j].cls)]),
  ];
  const push = (g: Omit<ChangeGroup, "bounds" | "previousBounds" | "classes">) =>
    groups.push({
      ...g,
      classes: classesOf(g.previous, g.latest),
      bounds: unionBounds(g.previous, g.latest),
      previousBounds: previousBoundsOf(g.previous),
    });

  // Moved: a component that is congruent with exactly one component after a translation.
  const index = new Map<string, number[]>();
  after.forEach((c, k) => index.set(c.signature, [...(index.get(c.signature) ?? []), k]));
  let limitedCorrespondence = 0;
  const candidates = before.map((a) => {
    const reach = Math.max(3 * diagonal(a.bounds), 50 * eps);
    const found: number[] = [];
    const eligible = index.get(a.signature) ?? [];
    if (eligible.length > 50) { limitedCorrespondence++; return found; }
    for (const k of eligible) {
      const b = after[k];
      const dx = b.centroid.x - a.centroid.x,
        dy = b.centroid.y - a.centroid.y,
        shift = Math.hypot(dx, dy);
      if (shift <= eps || shift > reach || Math.abs(a.length - b.length) > eps * a.members.length) continue;
      const matched = matchPrims(aligned, latest, eps, () => ({ rotation: 0, dx, dy }), a.members, b.members);
      if (matched.size === a.members.length) found.push(k);
    }
    return found;
  });
  const reverse = new Map<number, number[]>();
  candidates.forEach((ks, a) => ks.forEach((k) => reverse.set(k, [...(reverse.get(k) ?? []), a])));
  const usedBefore = new Set<number>(),
    usedAfter = new Set<number>();
  candidates.forEach((ks, a) => {
    if (!ks.length) return;
    const A = before[a];
    if (ks.length === 1 && reverse.get(ks[0])!.length === 1) {
      const B = after[ks[0]];
      const dx = B.centroid.x - A.centroid.x,
        dy = B.centroid.y - A.centroid.y;
      push({
        change: "moved",
        family: A.family,
        previous: A.members,
        latest: B.members,
        basis: `${A.members.length} primitive(s) coincide exactly after a translation of (${r1(dx)}, ${r1(dy)}) mm relative to the aligned previous revision; this is the only congruent candidate nearby.`,
        confidence: A.members.length >= 4 ? "high" : "medium",
        delta: { dx: r1(dx), dy: r1(dy) },
      });
      usedBefore.add(a);
      usedAfter.add(ks[0]);
    } else {
      const others = [...new Set(ks.flatMap((k) => reverse.get(k)!))].filter((o) => !usedBefore.has(o));
      const ks2 = [...new Set(others.flatMap((o) => candidates[o]))].filter((k) => !usedAfter.has(k));
      if (!others.length || !ks2.length) return;
      push({
        change: "uncertain",
        family: A.family,
        previous: others.flatMap((o) => before[o].members),
        latest: ks2.flatMap((k) => after[k].members),
        basis: `${others.length} removed and ${ks2.length} added congruent shapes could correspond in more than one way. No movement was inferred; verify which element moved.`,
        confidence: "low",
      });
      others.forEach((o) => usedBefore.add(o));
      ks2.forEach((k) => usedAfter.add(k));
    }
  });

  // Moved with edits: most of a component coincides with one nearby component under one translation.
  const partial: { a: number; k: number; dx: number; dy: number; matched: number }[] = [];
  let partialChecks = 0, componentChecks = 0;
  for (let a = 0; a < before.length; a++) {
    if (usedBefore.has(a)) continue;
    const A = before[a];
    if (A.members.length < 4) continue;
    const reach = Math.max(3 * diagonal(A.bounds), 50 * eps);
    const options: typeof partial = [];
    let incomplete = false;
    for (let k = 0; k < after.length; k++) {
      if (++componentChecks > 200000) { incomplete = true; break; }
      const B = after[k];
      if (usedAfter.has(k) || B.family !== A.family || B.members.length < 4) continue;
      if (Math.hypot(B.centroid.x - A.centroid.x, B.centroid.y - A.centroid.y) > reach) continue;
      partialChecks += Math.min(A.members.length, 200) * Math.min(B.members.length, 200);
      if (partialChecks > 500000) { incomplete = true; break; }
      const bins = new Map<string, { n: number; dx: number; dy: number }>();
      for (const i of A.members.slice(0, 200))
        for (const j of B.members.slice(0, 200)) {
          const p = aligned[i], q = latest[j];
          if (p.kind !== q.kind || Math.abs(p.length - q.length) > eps || (p.kind === "seg" && angleGap(p.angle, q.angle) > 0.2)) continue;
          const dx = q.mid.x - p.mid.x, dy = q.mid.y - p.mid.y;
          const key = `${Math.round(dx / (2 * eps))},${Math.round(dy / (2 * eps))}`;
          const bin = bins.get(key) ?? { n: 0, dx, dy };
          bin.n++;
          bins.set(key, bin);
        }
      const top = [...bins.values()].sort((x, y) => y.n - x.n)[0];
      if (!top || Math.hypot(top.dx, top.dy) <= eps) continue;
      const matched = matchPrims(aligned, latest, eps, () => ({ rotation: 0, dx: top.dx, dy: top.dy }), A.members, B.members).size;
      if (matched >= 0.6 * Math.max(A.members.length, B.members.length))
        options.push({ a, k, dx: top.dx, dy: top.dy, matched });
    }
    if (incomplete) limitedCorrespondence++;
    else if (options.length === 1) partial.push(options[0]);
  }
  for (const m of partial) {
    if (usedBefore.has(m.a) || usedAfter.has(m.k) || partial.filter((x) => x.k === m.k).length > 1) continue;
    const A = before[m.a], B = after[m.k];
    push({
      change: "moved",
      family: A.family,
      previous: A.members,
      latest: B.members,
      basis: `${m.matched} of ${A.members.length} previous primitives coincide with a unique nearby shape after a translation of (${r1(m.dx)}, ${r1(m.dy)}) mm; ${A.members.length - m.matched} previous and ${B.members.length - m.matched} latest primitives differ, so the element appears moved with edits.`,
      confidence: "medium",
      delta: { dx: r1(m.dx), dy: r1(m.dy) },
    });
    usedBefore.add(m.a);
    usedAfter.add(m.k);
  }

  // Modified or uncertain: remaining components that overlap in place.
  const restBefore = before.map((_, a) => a).filter((a) => !usedBefore.has(a));
  const restAfter = after.map((_, k) => k).filter((k) => !usedAfter.has(k));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const a of restBefore) parent.set(`b${a}`, `b${a}`);
  for (const k of restAfter) parent.set(`a${k}`, `a${k}`);
  const sorted = [...restAfter].sort((x, y) => after[x].bounds.minX - after[y].bounds.minX);
  let overlapChecks = 0;
  for (const a of restBefore) {
    const A = before[a];
    for (const k of sorted) {
      if (++overlapChecks > 500000) { limitedCorrespondence++; break; }
      const B = after[k];
      if (B.bounds.minX > A.bounds.maxX + eps) break;
      if (A.family === B.family && intersects(A.bounds, B.bounds, eps)) parent.set(find(`b${a}`), find(`a${k}`));
    }
  }
  const sets = new Map<string, { b: number[]; a: number[] }>();
  for (const key of parent.keys()) {
    const root = find(key);
    const s = sets.get(root) ?? { b: [], a: [] };
    (key[0] === "b" ? s.b : s.a).push(Number(key.slice(1)));
    sets.set(root, s);
  }
  for (const { b, a } of sets.values()) {
    const family = (b.length ? before[b[0]] : after[a[0]]).family;
    const pm = b.flatMap((x) => before[x].members),
      lm = a.flatMap((k) => after[k].members);
    if (!b.length || !a.length) {
      push({
        change: b.length ? "removed" : "added",
        family,
        previous: pm,
        latest: lm,
        basis: limitedCorrespondence
          ? "Unmatched geometry after bounded correspondence search. A move or edit could not be established; inspect the other revision or compare a smaller zone."
          : b.length
            ? "No coincident, re-segmented, moved or overlapping counterpart exists in the latest revision."
            : "No coincident, re-segmented, moved or overlapping counterpart exists in the previous revision.",
        confidence: limitedCorrespondence ? "low" : "high",
      });
      continue;
    }
    const used = new Set<number>();
    const found: NonNullable<ReturnType<typeof relation>>[] = [];
    const inspectRelations = pm.length * lm.length <= 100000;
    if (!inspectRelations) limitedCorrespondence++;
    for (const i of inspectRelations ? pm : []) {
      let best: { j: number; rel: NonNullable<ReturnType<typeof relation>> } | undefined;
      for (const j of lm) {
        if (used.has(j)) continue;
        const rel = relation(aligned[i], latest[j], eps);
        if (rel && (!best || rel.score < best.rel.score)) best = { j, rel };
      }
      if (best) {
        used.add(best.j);
        found.push(best.rel);
      }
    }
    const explained = (2 * found.length) / (pm.length + lm.length);
    const lengths = found.filter((f) => f.type === "length").map((f) => f.length!);
    const radii = found.filter((f) => f.type === "radius").map((f) => f.radius!);
    const offsets = found.filter((f) => f.type === "offset");
    const texts = found.filter((f) => f.type === "text").length;
    const parts = [
      lengths.length && `${lengths.length} collinear segment(s) sharing an endpoint changed length (${[...new Set(lengths.map(r1))].slice(0, 3).map((v) => `${v > 0 ? "+" : ""}${v}`).join(", ")} mm)`,
      radii.length && `${radii.length} arc/circle radius change(s) about the same centre (${[...new Set(radii.map(r1))].slice(0, 3).map((v) => `${v > 0 ? "+" : ""}${v}`).join(", ")} mm)`,
      offsets.length && `${offsets.length} parallel same-size primitive(s) offset in place`,
      texts && `${texts} text value(s) changed at the same position`,
    ].filter(Boolean);
    if (inspectRelations && explained < 0.25) {
      const note = (side: string) =>
        `No coincident, re-segmented, moved or edited counterpart exists in the ${side} revision; nearby ${side === "latest" ? "added" : "removed"} geometry overlaps but does not correspond (${Math.round(explained * 100)}% of primitives relate).`;
      push({ change: "removed", family, previous: pm, latest: [], basis: note("latest"), confidence: "medium" });
      push({ change: "added", family, previous: [], latest: lm, basis: note("previous"), confidence: "medium" });
      continue;
    }
    const modified = b.length === 1 && a.length === 1 && explained >= 0.5;
    const uniform = (values: number[]) => values.length && values.every((v) => Math.abs(v - values[0]) <= eps);
    push({
      change: modified ? "modified" : "uncertain",
      family,
      previous: pm,
      latest: lm,
      basis: modified
        ? `Overlapping geometry edited in place: ${parts.join("; ")}. ${Math.round(explained * 100)}% of the affected primitives have a specific before/after correspondence.`
        : `${pm.length} removed and ${lm.length} added primitives overlap here${parts.length ? ` (${parts.join("; ")})` : ""}, but their correspondence is not established. They may be one modified element or separate changes.`,
      confidence: modified ? (explained >= 0.8 ? "high" : "medium") : "low",
      ...(modified
        ? {
            delta: {
              ...(uniform(lengths) ? { length: r1(lengths[0]) } : {}),
              ...(uniform(radii) ? { radius: r1(radii[0]) } : {}),
            },
          }
        : {}),
    });
  }

  // A latest/previous sheet view without any counterpart is one added/removed view, not many areas.
  for (const view of registration.alignment.views) {
    if (view.status !== "added" && view.status !== "removed") continue;
    const side = view.status === "added" ? "latest" : "previous";
    const members = new Set(
      (side === "latest" ? registration.latestViews : registration.previousViews).find((v) => v.id === view.id)?.members ?? [],
    );
    const inside = groups.filter(
      (g) => g.change === view.status && g[side].length && g[side].every((i) => members.has(i)),
    );
    if (inside.length < 2) {
      inside.forEach((g) => (g.view = view.id));
      continue;
    }
    for (const g of inside) groups.splice(groups.indexOf(g), 1);
    const pm = inside.flatMap((g) => g.previous),
      lm = inside.flatMap((g) => g.latest);
    groups.push({
      change: view.status,
      family: inside.some((g) => g.family === "geometry") ? "geometry" : inside[0].family,
      classes: classesOf(pm, lm),
      previous: pm,
      latest: lm,
      bounds: unionBounds(pm, lm),
      previousBounds: previousBoundsOf(pm),
      basis: `Whole drawing view ${view.status}: ${view.basis}`,
      confidence: "high",
      view: view.id,
      parts: inside,
    });
  }
  if (limitedCorrespondence)
    registration.warnings.push(`${limitedCorrespondence} dense or highly repeated change groups exceeded the correspondence search budget. Movement/edits were not guessed from a truncated search; review their added/removed or uncertain geometry in a smaller zone.`);
  const count = (change: ChangeGroup["change"], side: "previous" | "latest") =>
    groups.filter((g) => g.change === change).reduce((n, g) => n + g[side].length, 0);
  return {
    previous,
    latest,
    registration,
    groups,
    stats: {
      limitedCorrespondenceGroups: limitedCorrespondence,
      previousPrimitives: previous.length,
      latestPrimitives: latest.length,
      exactMatches: exact.size,
      segmentationPrevious: seg.prevMatched.size,
      segmentationLatest: seg.latestMatched.size,
      movedPrimitives: count("moved", "previous"),
      modifiedPrevious: count("modified", "previous"),
      modifiedLatest: count("modified", "latest"),
      uncertainPrevious: count("uncertain", "previous"),
      uncertainLatest: count("uncertain", "latest"),
      addedPrimitives: count("added", "latest"),
      removedPrimitives: count("removed", "previous"),
    },
  };
}
