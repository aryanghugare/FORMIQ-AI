import { applyTransform } from "./alignment";
import { PointGrid } from "./primitives";
import type { Measurement, Point, RigidTransform } from "./types";

export type DimensionFinding =
  | { type: "changed"; before: Measurement; after: Measurement; label: string; basis: string; confidence: "high" | "medium" }
  | { type: "added"; after: Measurement; label: string; basis: string }
  | { type: "removed"; before: Measurement; label: string; basis: string }
  | { type: "ambiguous"; befores: Measurement[]; afters: Measurement[]; label: string; basis: string }
  | { type: "annotation"; before: Measurement; after: Measurement; label: string; basis: string };

const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const axisGap = (a: number, b: number) => Math.abs(((((a - b) % 180) + 270) % 180) - 90);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (p: Point) => `(${Math.round(p.x * 10) / 10}, ${Math.round(p.y * 10) / 10})`;
const isTagged = (m: Measurement) => !m.tag.startsWith("DIM@");
const differs = (a: number, b: number, tolerance: number) =>
  Math.abs(r3(a - b)) > tolerance;

/** Previous measurement expressed in the latest-revision frame. */
interface Mapped {
  m: Measurement;
  refs?: [Point, Point];
  axis?: number;
  line?: Point;
}
const mapMeasurement = (m: Measurement, at: (p: Point) => RigidTransform): Mapped => {
  const t = at(m.defPoints ? { x: (m.defPoints[0].x + m.defPoints[1].x) / 2, y: (m.defPoints[0].y + m.defPoints[1].y) / 2 } : m.point);
  return {
    m,
    refs: m.defPoints && [applyTransform(t, m.defPoints[0]), applyTransform(t, m.defPoints[1])],
    axis: m.axis === undefined ? undefined : (((m.axis + t.rotation) % 180) + 180) % 180,
    line: m.linePoint && applyTransform(t, m.linePoint),
  };
};
const ownFrame = (m: Measurement): Mapped => ({ m, refs: m.defPoints, axis: m.axis, line: m.linePoint });

/**
 * Dimension correspondence. Tagged dimensions use their tag (split by measured axis when one tag
 * labels several axes). Untagged dimensions use measured reference points and axis after
 * alignment, never the annotation position or the numerical value alone.
 */
export function matchDimensions(
  previous: Measurement[],
  latest: Measurement[],
  at: (p: Point) => RigidTransform,
  eps: number,
  tolerance: number,
): DimensionFinding[] {
  const findings: DimensionFinding[] = [];
  const compare = (before: Mapped, after: Mapped, label: string, basis: string, confidence: "high" | "medium") => {
    if (differs(after.m.value, before.m.value, tolerance)) {
      findings.push({ type: "changed", before: before.m, after: after.m, label, basis, confidence });
      return;
    }
    const notes: string[] = [];
    if ((before.m.displayText ?? "") !== (after.m.displayText ?? ""))
      notes.push(`displayed text changed from "${before.m.displayText ?? "<measured>"}" to "${after.m.displayText ?? "<measured>"}"`);
    if (before.line && after.line && d(before.line, after.line) > eps)
      notes.push(`dimension annotation repositioned by ${Math.round(d(before.line, after.line) * 10) / 10} mm`);
    if (notes.length)
      findings.push({
        type: "annotation",
        before: before.m,
        after: after.m,
        label,
        basis: `Measured value unchanged (${after.m.value} mm); ${notes.join("; ")}. ${basis}`,
      });
  };
  // Tagged dimensions and explicit schedule annotations.
  const byTag = (list: Measurement[]) => {
    const map = new Map<string, Measurement[]>();
    for (const m of list.filter(isTagged)) map.set(m.tag, [...(map.get(m.tag) ?? []), m]);
    return map;
  };
  const oldTags = byTag(previous),
    newTags = byTag(latest);
  for (const tag of new Set([...oldTags.keys(), ...newTags.keys()])) {
    const olds = (oldTags.get(tag) ?? []).map((m) => mapMeasurement(m, at)),
      news = (newTags.get(tag) ?? []).map(ownFrame);
    const pair = (b: Mapped | undefined, a: Mapped | undefined, label: string, basis: string) => {
      if (b && a) compare(b, a, label, basis, "high");
      else if (b)
        findings.push({ type: "removed", before: b.m, label, basis: "This tagged dimension is absent from the latest revision." });
      else if (a)
        findings.push({ type: "added", after: a.m, label, basis: "A new tagged dimension was found in the latest revision." });
    };
    if (olds.length <= 1 && news.length <= 1) {
      pair(olds[0], news[0], tag, "Matched by tag.");
      continue;
    }
    // One tag on several measured axes (e.g. width and height) can still be paired per axis.
    const all = [...olds, ...news];
    const axes: number[] = [];
    const assignments = new Map<Mapped, number>();
    for (const x of [...all].sort((a, b) => (a.axis ?? 0) - (b.axis ?? 0))) {
      if (x.axis === undefined) continue;
      let key = axes.find((axis) => axisGap(axis, x.axis!) <= 0.5);
      if (key === undefined) { key = x.axis; axes.push(key); }
      assignments.set(x, key);
    }
    const axisKey = (x: Mapped) => assignments.get(x);
    const keys = new Set(all.map(axisKey));
    const separable =
      !keys.has(undefined) &&
      [...keys].every((k) => olds.filter((o) => axisKey(o) === k).length <= 1 && news.filter((n) => axisKey(n) === k).length <= 1);
    if (separable && keys.size > 1) {
      for (const k of [...keys].sort((a, b) => a! - b!))
        pair(
          olds.find((o) => axisKey(o) === k),
          news.find((n) => axisKey(n) === k),
          `${tag} · ${k}°`,
          `Matched by tag and measured axis (${k}°).`,
        );
      continue;
    }
    findings.push({
      type: "ambiguous",
      befores: olds.map((o) => o.m),
      afters: news.map((n) => n.m),
      label: tag,
      basis: `${olds.length} previous and ${news.length} latest measurements share this tag on the same axis. Values were not compared; assign unique tags or verify manually.`,
    });
  }
  // Untagged dimensions.
  const oldU = previous.filter((m) => !isTagged(m)).map((m) => mapMeasurement(m, at));
  const newU = latest.filter((m) => !isTagged(m)).map(ownFrame);
  const legacyOld = oldU.filter((o) => !o.refs),
    legacyNew = newU.filter((n) => !n.refs);
  for (const o of legacyOld) {
    const n = legacyNew.find((x) => x.m.tag === o.m.tag);
    if (n) {
      legacyNew.splice(legacyNew.indexOf(n), 1);
      compare(o, n, "Untagged dimension", "Matched by legacy anchor reference.", "medium");
    } else findings.push({ type: "removed", before: o.m, label: "Untagged dimension", basis: "No dimension with the same legacy anchor reference exists in the latest revision." });
  }
  for (const n of legacyNew)
    findings.push({ type: "added", after: n.m, label: "Untagged dimension", basis: "No dimension with the same legacy anchor reference exists in the previous revision." });
  const olds = oldU.filter((o) => o.refs).sort((a, b) => a.refs![0].x - b.refs![0].x || a.refs![0].y - b.refs![0].y || a.m.value - b.m.value);
  const news = newU.filter((n) => n.refs);
  const sameAxis = (a: Mapped, b: Mapped) => a.axis !== undefined && b.axis !== undefined && axisGap(a.axis, b.axis) <= 0.5;
  const sharedRefs = (a: Mapped, b: Mapped) => {
    const [p, q] = a.refs!, [r, s] = b.refs!;
    if ((d(p, r) <= eps && d(q, s) <= eps) || (d(p, s) <= eps && d(q, r) <= eps)) return 2;
    return [d(p, r), d(p, s), d(q, r), d(q, s)].some((x) => x <= eps) ? 1 : 0;
  };
  const usedOld = new Set<Mapped>(), usedNew = new Set<Mapped>();
  // Index measured endpoints; annotation placement and numerical values never select a match.
  const endpointGrid = new PointGrid(Math.max(eps * 2, 0.001));
  news.forEach((n, index) => n.refs!.forEach((p) => endpointGrid.insert(index, p)));
  const nearby = (o: Mapped) => [...new Set(o.refs!.flatMap((p) => endpointGrid.near(p, eps, 256)))];
  const exact = new Map<Mapped, Mapped[]>(), exactReverse = new Map<Mapped, Mapped[]>();
  let candidateChecks = 0;
  for (const o of olds) {
    const indices = nearby(o);
    candidateChecks += indices.length;
    if (indices.length > 256 || candidateChecks > 200000) {
      findings.push({ type: "ambiguous", befores: olds.map((x) => x.m), afters: news.map((x) => x.m), label: "Untagged dimensions", basis: "Reference points are too densely repeated for bounded, reliable matching. Untagged values were not compared; select a smaller zone or assign unique tags." });
      return findings;
    }
    for (const index of indices) {
      const n = news[index];
      if (!sameAxis(o, n) || sharedRefs(o, n) !== 2) continue;
      exact.set(o, [...(exact.get(o) ?? []), n]);
      exactReverse.set(n, [...(exactReverse.get(n) ?? []), o]);
    }
  }
  // Pair only mutually unique reference matches. Repeated dimensions remain ambiguous.
  for (const o of olds) {
    const matches = exact.get(o) ?? [];
    if (matches.length !== 1 || exactReverse.get(matches[0])!.length !== 1) continue;
    const n = matches[0];
    usedOld.add(o); usedNew.add(n);
    compare(o, n, "Untagged dimension", `Matched by both measured reference points ${fmt(n.refs![0])}–${fmt(n.refs![1])} and axis ${n.axis}° after alignment.`, "high");
  }
  const restOld = olds.filter((o) => !usedOld.has(o)),
    restNew = news.filter((n) => !usedNew.has(n));
  const candidates = new Map<Mapped, Mapped[]>(), reverse = new Map<Mapped, Mapped[]>();
  for (const o of restOld) {
    const exactMatches = (exact.get(o) ?? []).filter((n) => !usedNew.has(n));
    const list = exactMatches.length ? exactMatches : nearby(o).map((i) => news[i]).filter((n) =>
      !usedNew.has(n) && !exactReverse.has(n) && sameAxis(o, n) && sharedRefs(o, n) === 1,
    );
    if (list.length) candidates.set(o, list);
    for (const n of list) reverse.set(n, [...(reverse.get(n) ?? []), o]);
  }
  const handled = new Set<Mapped>();
  for (const o of restOld) {
    const list = candidates.get(o);
    if (!list || handled.has(o)) continue;
    if (list.length === 1 && reverse.get(list[0])!.length === 1) {
      const n = list[0];
      handled.add(o).add(n);
      const shared = [n.refs![0], n.refs![1]].find((p) => o.refs!.some((q) => d(p, q) <= eps))!;
      compare(o, n, "Untagged dimension", `Matched by shared reference point ${fmt(shared)} and measured axis ${n.axis}°; the other reference point moved.`, "medium");
      continue;
    }
    // Connected ambiguity: report all candidates together instead of guessing.
    const groupOld = new Set<Mapped>([o]), groupNew = new Set<Mapped>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of groupOld) for (const n of candidates.get(x) ?? []) if (!groupNew.has(n)) { groupNew.add(n); grew = true; }
      for (const n of groupNew) for (const x of reverse.get(n) ?? []) if (!groupOld.has(x)) { groupOld.add(x); grew = true; }
    }
    groupOld.forEach((x) => handled.add(x));
    groupNew.forEach((x) => handled.add(x));
    findings.push({
      type: "ambiguous",
      befores: [...groupOld].map((x) => x.m),
      afters: [...groupNew].map((x) => x.m),
      label: "Untagged dimensions",
      basis: `${groupOld.size} previous and ${groupNew.size} latest untagged dimensions share reference points on the same axis, so more than one correspondence is possible. Values were not compared.`,
    });
  }
  for (const o of restOld)
    if (!handled.has(o))
      findings.push({ type: "removed", before: o.m, label: "Untagged dimension", basis: `No latest dimension measures the reference points ${fmt(o.refs![0])}–${fmt(o.refs![1])} on axis ${o.axis}° or shares one of them.` });
  for (const n of restNew)
    if (!handled.has(n))
      findings.push({ type: "added", after: n.m, label: "Untagged dimension", basis: `No previous dimension measures the reference points ${fmt(n.refs![0])}–${fmt(n.refs![1])} on axis ${n.axis}° or shares one of them.` });
  return findings;
}
