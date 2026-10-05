import { alignmentTransformAt, describeTransform, entityAnchor } from "./alignment";
import {
  apply,
  cluster,
  diagonal,
  emptyBounds,
  extendBounds,
  IDENTITY,
  isIdentity,
  matchPrims,
  normalizeDegrees,
  type Prim,
} from "./primitives";
import type { AlignmentRecord, Bounds, RigidTransform, ViewAlignment } from "./types";

interface Candidate {
  transform: RigidTransform;
  matched: number;
  support: number;
}
const MAX_SAMPLED_SEGMENTS = 400;
const MAX_BUCKET = 80;

/** Least-squares rigid fit (2D Kabsch) for point correspondences. */
function rigidFit(pairs: [{ x: number; y: number }, { x: number; y: number }][]): RigidTransform | undefined {
  if (pairs.length < 2) return;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (const [p, q] of pairs) {
    px += p.x; py += p.y; qx += q.x; qy += q.y;
  }
  px /= pairs.length; py /= pairs.length; qx /= pairs.length; qy /= pairs.length;
  let sin = 0, cos = 0;
  for (const [p, q] of pairs) {
    const ax = p.x - px, ay = p.y - py, bx = q.x - qx, by = q.y - qy;
    cos += ax * bx + ay * by;
    sin += ax * by - ay * bx;
  }
  let rotation = (Math.atan2(sin, cos) * 180) / Math.PI;
  const snapped = Math.round(rotation / 90) * 90;
  if (Math.abs(rotation - snapped) < 1e-4) rotation = snapped;
  const r = (rotation * Math.PI) / 180;
  return {
    rotation: normalizeDegrees(rotation),
    dx: qx - (Math.cos(r) * px - Math.sin(r) * py),
    dy: qy - (Math.sin(r) * px + Math.cos(r) * py),
  };
}

/** Rotation candidates: right angles plus peaks of the length-weighted orientation correlation. */
function rotationCandidates(prev: Prim[], latest: Prim[]) {
  const hist = (prims: Prim[]) => {
    const h = new Array(180).fill(0);
    for (const p of prims) h[Math.round(p.angle) % 180] += p.length;
    return h;
  };
  const a = hist(prev), b = hist(latest);
  const corr = Array.from({ length: 180 }, (_, s) =>
    a.reduce((sum, v, i) => sum + v * b[(i + s) % 180], 0),
  );
  const peaks = corr
    .map((v, s) => ({ v, s }))
    .filter(({ s }) => s % 90 > 1 && s % 90 < 89)
    .sort((x, y) => y.v - x.v)
    .slice(0, 2)
    .filter(({ v }) => v > 0)
    .flatMap(({ s }) => [s, s + 180]);
  return [0, 90, 180, 270, ...peaks];
}

function vote(
  prims: { prev: Prim[]; latest: Prim[] },
  prevIdx: number[],
  latestIdx: number[],
  eps: number,
  diag: number,
): RigidTransform[] {
  const minLength = Math.max(4 * eps, diag * 0.002);
  const segs = (all: Prim[], idx: number[]) =>
    idx.map((i) => all[i]).filter((p) => p.kind === "seg" && p.length >= minLength);
  const prev = segs(prims.prev, prevIdx), latest = segs(prims.latest, latestIdx);
  if (!prev.length || !latest.length) return [];
  const qL = Math.max(2 * eps, diag * 0.001), qT = Math.max(2 * eps, diag * 0.0005);
  const buckets = new Map<string, Prim[]>();
  for (const l of latest) {
    const k = `${Math.round(l.length / qL)}|${Math.round(l.angle) % 180}`;
    const list = buckets.get(k);
    if (list) list.push(l);
    else buckets.set(k, [l]);
  }
  const lookup = (length: number, angle: number) => {
    const out: Prim[] = [];
    const lb = Math.round(length / qL), ab = Math.round(angle);
    for (let dl = -1; dl <= 1; dl++)
      for (let da = -1; da <= 1; da++) {
        const list = buckets.get(`${lb + dl}|${(((ab + da) % 180) + 180) % 180}`);
        if (list) for (const l of list) out.push(l);
      }
    return out.filter(
      (l) =>
        Math.abs(l.length - length) <= qL &&
        Math.abs(normalizeDegrees(l.angle - angle + 90) % 180 - 90) <= 1.5,
    );
  };
  // Prefer long, distinctive segments; repeated modules vote weakly.
  const lengthCounts = new Map<number, number>();
  for (const l of latest) {
    const key = Math.round(l.length / qL);
    lengthCounts.set(key, (lengthCounts.get(key) ?? 0) + 1);
  }
  const sampled = [...prev]
    .sort((x, y) => y.length - x.length || x.mid.x - y.mid.x || x.mid.y - y.mid.y)
    .filter((s) => {
      const bucket = Math.round(s.length / qL);
      const n = [-1, 0, 1].reduce((count, delta) => count + (lengthCounts.get(bucket + delta) ?? 0), 0);
      return n > 0 && n <= MAX_BUCKET;
    });
  const stride = Math.max(1, Math.floor(sampled.length / MAX_SAMPLED_SEGMENTS));
  const chosen = sampled.filter((_, i) => i % stride === 0).slice(0, MAX_SAMPLED_SEGMENTS);
  const results: { t: RigidTransform; votes: number }[] = [];
  for (const rotation of rotationCandidates(prev, latest)) {
    const r = (rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const bins = new Map<string, [number, number, number]>();
    for (const s of chosen) {
      const rx = cos * s.mid.x - sin * s.mid.y, ry = sin * s.mid.x + cos * s.mid.y;
      for (const l of lookup(s.length, normalizeDegrees(s.angle + rotation) % 180)) {
        const tx = l.mid.x - rx, ty = l.mid.y - ry;
        const k = `${Math.round(tx / qT)},${Math.round(ty / qT)}`;
        const bin = bins.get(k) ?? [0, 0, 0];
        bin[0]++; bin[1] += tx; bin[2] += ty;
        bins.set(k, bin);
      }
    }
    const peaks = [...bins.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 3);
    for (const [k, [count]] of peaks) {
      const [bx, by] = k.split(",").map(Number);
      let n = 0, sx = 0, sy = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const bin = bins.get(`${bx + dx},${by + dy}`);
          if (bin) { n += bin[0]; sx += bin[1]; sy += bin[2]; }
        }
      if (count >= 3) results.push({ t: { rotation, dx: sx / n, dy: sy / n }, votes: count });
    }
  }
  return results.sort((a, b) => b.votes - a.votes).slice(0, 8).map((r) => r.t);
}

/** Re-estimate a candidate from its own coincident segment endpoints, then score it. */
function evaluate(
  prims: { prev: Prim[]; latest: Prim[] },
  prevIdx: number[],
  latestIdx: number[],
  eps: number,
  candidate: RigidTransform,
): Candidate {
  const score = (t: RigidTransform) => {
    const matched = matchPrims(prims.prev, prims.latest, eps, () => t, prevIdx, latestIdx);
    return { matched: matched.size, map: matched };
  };
  const relaxed = matchPrims(prims.prev, prims.latest, eps * 3, () => candidate, prevIdx, latestIdx);
  const pairs: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (const [i, j] of relaxed) {
    const p = prims.prev[i], q = prims.latest[j];
    if (p.kind !== "seg") continue;
    const pa = apply(candidate, p.a);
    const forward = Math.hypot(pa.x - q.a.x, pa.y - q.a.y) <= Math.hypot(pa.x - q.b.x, pa.y - q.b.y);
    pairs.push([p.a, forward ? q.a : q.b], [p.b, forward ? q.b : q.a]);
  }
  const refined = rigidFit(pairs);
  const base = score(candidate);
  const better = refined ? score(refined) : undefined;
  const chosen = better && better.matched >= base.matched ? { t: refined!, ...better } : { t: candidate, ...base };
  return {
    transform: chosen.t,
    matched: chosen.matched,
    support: (2 * chosen.matched) / Math.max(prevIdx.length + latestIdx.length, 1),
  };
}
const distinct = (a: RigidTransform, b: RigidTransform, eps: number) =>
  Math.abs(normalizeDegrees(a.rotation - b.rotation + 180) - 180) > 0.5 ||
  Math.hypot(a.dx - b.dx, a.dy - b.dy) > 4 * eps;

export interface Registration {
  alignment: AlignmentRecord;
  transformFor: (prevIndex: number) => RigidTransform;
  previousViews: { id: string; members: number[]; bounds: Bounds }[];
  latestViews: { id: string; members: number[]; bounds: Bounds }[];
  warnings: string[];
}

/**
 * Detect a global rigid transform and per-view transforms (multi-view sheets) from geometric
 * evidence. Alignment is applied only with strong, unambiguous support; it never fits scale.
 */
export function register(prev: Prim[], latest: Prim[], eps: number): Registration {
  const prims = { prev, latest };
  const all = (list: Prim[]) => list.map((_, i) => i);
  const bounds = extendBounds(
    prev.reduce((b, p) => extendBounds(b, p.bounds), emptyBounds()),
    latest.reduce((b, p) => extendBounds(b, p.bounds), emptyBounds()),
  );
  const diag = Number.isFinite(bounds.minX) ? Math.max(diagonal(bounds), eps) : 1;
  const warnings: string[] = [];
  const total = prev.length + latest.length;
  const identityMatched = matchPrims(prev, latest, eps, () => IDENTITY).size;
  const identity: Candidate = {
    transform: IDENTITY,
    matched: identityMatched,
    support: (2 * identityMatched) / Math.max(total, 1),
  };
  let global: AlignmentRecord["global"] = {
    ...IDENTITY,
    status: "identity",
    support: identity.support,
    basis: `${identity.matched} primitives coincide at their original coordinates.`,
  };
  if (identity.support < 0.8 && prev.length && latest.length) {
    const candidates = vote(prims, all(prev), all(latest), eps, diag)
      .map((t) => evaluate(prims, all(prev), all(latest), eps, t))
      .sort((a, b) => b.matched - a.matched);
    const best = candidates[0];
    const second = candidates.find((c) => best && distinct(c.transform, best.transform, eps));
    if (best && !isIdentity(best.transform, eps) && best.matched >= 8 && best.support >= 0.6 && best.support >= identity.support + 0.2 && best.support >= 1.5 * identity.support) {
      const clear = !second || second.matched <= 0.8 * best.matched;
      global = {
        ...best.transform,
        status: clear ? "aligned" : "ambiguous",
        support: best.support,
        alternative: second?.support,
        basis: clear
          ? `${best.matched} primitives coincide after ${describeTransform(best.transform)} versus ${identity.matched} without alignment.`
          : `Two different alignments are similarly supported (${best.matched} vs ${second!.matched} coinciding primitives). No alignment was applied.`,
      };
      if (!clear) {
        global = { ...global, ...IDENTITY };
        warnings.push(
          "Drawing alignment is ambiguous: more than one translation/rotation explains the geometry similarly well. Geometry was compared at original coordinates; confirm the drawing origin before relying on geometry findings.",
        );
      } else
        warnings.push(
          `Previous revision geometry was aligned by ${describeTransform(best.transform)} before comparison (supported by ${Math.round(best.support * 100)}% of primitives). If the whole drawing was intentionally moved, review the alignment finding.`,
        );
    } else if (identity.support < 0.3 && total > 20)
      warnings.push(
        "Little geometry coincides and no reliable alignment was found. Check that both drawings cover the same floor or zone and use the same origin, orientation and units.",
      );
  }
  const globalT: RigidTransform = global.status === "aligned" ? global : IDENTITY;
  const viewCell = Math.max(diag / 150, eps * 10);
  const label = (prefix: string, groups: number[][], list: Prim[]) =>
    groups
      .map((members) => ({ members, bounds: members.reduce((b, i) => extendBounds(b, list[i].bounds), emptyBounds()) }))
      .sort((a, b) => a.bounds.minX - b.bounds.minX || b.bounds.maxY - a.bounds.maxY)
      .map((v, i) => ({ id: `${prefix}${i + 1}`, ...v }));
  const previousViews = label("V", cluster(prev, all(prev), viewCell, true), prev);
  const latestViews = label("L", cluster(latest, all(latest), viewCell, true), latest);
  const initial = matchPrims(prev, latest, eps, () => globalT);
  const claimed = new Set(initial.values());
  const minimumView = Math.max(12, prev.length * 0.03);
  const views: ViewAlignment[] = [];
  const viewTransforms = new Map<string, RigidTransform>();
  let viewSearches = 0;
  for (const view of [...previousViews].sort((a, b) => b.members.length - a.members.length)) {
    const matched = view.members.filter((i) => initial.has(i)).length;
    const record: ViewAlignment = {
      id: view.id,
      previousBounds: view.bounds,
      transform: globalT,
      status: matched ? "unchanged" : "removed",
      matched,
      total: view.members.length,
      basis: `${matched} of ${view.members.length} primitives coincide under the drawing alignment.`,
    };
    if (view.members.length >= minimumView && matched / view.members.length < 0.5 && viewSearches++ < 32) {
      const open = all(latest).filter((j) => !claimed.has(j));
      const candidates = vote(prims, view.members, open, eps, diagonal(view.bounds))
        .map((t) => evaluate(prims, view.members, open, eps, t))
        .sort((a, b) => b.matched - a.matched);
      const best = candidates[0];
      const second = candidates.find((c) => best && distinct(c.transform, best.transform, eps));
      if (best && best.matched >= 8 && best.matched >= 0.6 * view.members.length && distinct(best.transform, globalT, eps)) {
        if (!second || second.matched <= 0.8 * best.matched) {
          record.status = "aligned";
          record.transform = best.transform;
          record.matched = best.matched;
          record.basis = `${best.matched} of ${view.members.length} primitives in this view coincide after ${describeTransform(best.transform)}; the rest of the sheet does not share this transform.`;
          viewTransforms.set(view.id, best.transform);
          for (const j of matchPrims(prev, latest, eps, () => best.transform, view.members, open).values()) claimed.add(j);
        } else {
          record.status = "ambiguous";
          record.basis = `This view matches under several different placements (${best.matched} vs ${second.matched} primitives). It was compared without view-specific alignment.`;
          warnings.push(`View ${view.id}: placement is ambiguous; geometry in this view may appear as removed and added.`);
        }
      }
    }
    views.push(record);
  }
  if (viewSearches > 32) warnings.push("Only the 32 largest unmatched views were searched for separate placement transforms. Other views remain in the global frame; compare a smaller zone for reliable view registration.");
  for (const view of latestViews) {
    const matched = view.members.filter((j) => claimed.has(j)).length;
    if (view.members.length >= 12 && matched / view.members.length < 0.1)
      views.push({
        id: view.id,
        latestBounds: view.bounds,
        transform: globalT,
        status: "added",
        matched,
        total: view.members.length,
        basis: `${matched} of ${view.members.length} primitives in this latest-revision view correspond to previous geometry.`,
      });
  }
  views.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  // Isolated labels or single primitives are not reported as sheet views.
  const alignment: AlignmentRecord = {
    global,
    views: views.filter((v) => v.total >= 12 || v.status === "aligned"),
  };
  const pad = 2 * eps;
  const cache = new Map<number, RigidTransform>();
  const transformFor = (i: number) => {
    let t = cache.get(i);
    if (!t) {
      t = alignmentTransformAt(alignment, entityAnchor(prev[i].entity), pad);
      cache.set(i, t);
    }
    return t;
  };
  // Record which latest view received most of each previous view's matched content.
  const latestViewOf = new Map<number, number>();
  latestViews.forEach((v, k) => v.members.forEach((j) => latestViewOf.set(j, k)));
  const final = matchPrims(prev, latest, eps, transformFor);
  for (const record of alignment.views) {
    const view = previousViews.find((v) => v.id === record.id);
    if (!view) continue;
    const tally = new Map<number, number>();
    for (const i of view.members) {
      const j = final.get(i);
      if (j !== undefined) tally.set(latestViewOf.get(j)!, (tally.get(latestViewOf.get(j)!) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) record.latestBounds = latestViews[top[0]].bounds;
    if (record.status === "removed" && top) record.status = "unchanged";
  }
  return { alignment, previousViews, latestViews, warnings, transformFor };
}
