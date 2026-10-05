import { displayedDimensionValue } from "./dimension-text";
import { HttpError } from "./errors";
import { randomUUID } from "node:crypto";
import { compareGeometry, type ChangeGroup } from "./geometry-comparison";
import { matchDimensions, type DimensionFinding } from "./dimension-matching";
import { alignmentTransformAt, applyTransform, describeTransform } from "./alignment";
import { center, diagonal, emptyBounds, extendBounds, intersects, type Prim } from "./primitives";
import type {
  AnalysisRun,
  Bounds,
  CadModel,
  ChangeItem,
  Drawing,
  FindingEvidence,
  Issue,
  Measurement,
  Point,
  Project,
  RunSource,
} from "./types";

export const ENGINE_VERSION = "compare-2.1.0";
export const RULES = [
  {
    id: "REV-01",
    name: "Dimension revision",
    description:
      "Compare tagged dimensions by tag and untagged dimensions by measured reference points and axis.",
  },
  {
    id: "REV-02",
    name: "Added dimension",
    description: "Identify dimensions introduced in the latest revision.",
  },
  {
    id: "REV-03",
    name: "Removed dimension",
    description: "Identify dimensions absent from the latest revision.",
  },
  {
    id: "QC-02",
    name: "Ambiguous dimension correspondence",
    description:
      "Several dimensions could correspond; values are not compared until mapped manually.",
  },
  {
    id: "QC-03",
    name: "Unit and extraction validation",
    description:
      "Require known units and readable measurements or supported geometry; flag unsupported content.",
  },
  {
    id: "QC-04",
    name: "Dimension text override",
    description:
      "Displayed dimension text that differs from the measured distance.",
  },
  {
    id: "QC-05",
    name: "Drawing alignment",
    description:
      "Report detected sheet or view translation/rotation and ambiguous alignment for confirmation.",
  },
  {
    id: "GEO-01",
    name: "Geometry additions",
    description: "Geometry present only in the latest revision.",
  },
  {
    id: "GEO-02",
    name: "Geometry removals",
    description: "Geometry present only in the previous revision.",
  },
  {
    id: "GEO-03",
    name: "Uncertain geometry correspondence",
    description:
      "Overlapping or congruent additions and removals whose correspondence is not established.",
  },
  {
    id: "GEO-04",
    name: "Geometry modified",
    description:
      "Geometry edited in place with specific before/after evidence (length, offset or radius).",
  },
  {
    id: "GEO-05",
    name: "Geometry moved",
    description:
      "Congruent geometry relocated within the drawing after alignment, with a unique candidate.",
  },
  {
    id: "ANN-01",
    name: "Annotation change",
    description:
      "Text, grid, title-block and annotation-layer changes, classified separately from drawn geometry.",
  },
  {
    id: "ANN-02",
    name: "Dimension annotation change",
    description:
      "Dimension text or placement changed while the measured value is unchanged.",
  },
];
const MAX_FINDINGS = 200;
const MAX_IDS = 500;
const r1 = (v: number) => Math.round(v * 10) / 10;
const difference = (a: number, b: number) => Math.round((a - b) * 1000) / 1000;
const boxDistance = (b: Bounds, p: Point) =>
  Math.hypot(
    Math.max(b.minX - p.x, 0, p.x - b.maxX),
    Math.max(b.minY - p.y, 0, p.y - b.maxY),
  );
const segmentDistance = (b: Bounds, p: Point, q: Point) => {
  let best = Infinity;
  for (let k = 0; k <= 16; k++)
    best = Math.min(best, boxDistance(b, { x: p.x + ((q.x - p.x) * k) / 16, y: p.y + ((q.y - p.y) * k) / 16 }));
  return best;
};
const unique = <T>(values: T[]) => [...new Set(values)];

export function analyze(
  project: Project,
  old: Drawing,
  latest: Drawing,
  actor: string,
  context: { sources?: RunSource[]; runId?: string; warnings?: string[] } = {},
) {
  const started = performance.now();
  if (old.id === latest.id)
    throw new HttpError("Select two different revisions.");
  if ([old, latest].some((d) => d.projectId !== project.id))
    throw new HttpError("All drawings must belong to this project.");
  if (
    !["architecture", "structure"].includes(old.discipline) ||
    old.discipline !== latest.discipline
  )
    throw new HttpError(
      "Compare Architecture with Architecture or Structure with Structure.",
    );
  for (const d of [old, latest]) {
    if (d.status !== "ready" || !d.model)
      throw new HttpError(`${d.name} is not ready for analysis.`);
    if (!d.model.unitScale)
      throw new HttpError(
        `${d.name} has unknown units. Export it with explicit $INSUNITS.`,
      );
    if (!d.model.measurements.length && !d.model.entities.length)
      throw new HttpError(
        `${d.name} has no readable linear dimensions or supported 2D geometry. Check the extraction notes or export a 2D ASCII DXF.`,
      );
  }
  const previousModel = old.model!,
    latestModel = latest.model!;
  const runId = context.runId ?? randomUUID(),
    createdAt = new Date().toISOString(),
    issues: Issue[] = [];
  const eps = Math.max(project.tolerance, 0.001);
  const warnings = [
    ...new Set([
      ...(context.warnings ?? []),
      ...[old, latest].flatMap((d) =>
        d.model!.warnings.map((w) => `${d.name}: ${w}`),
      ),
    ]),
  ];
  const geo = compareGeometry(previousModel, latestModel, eps);
  const alignment = geo.registration.alignment;
  warnings.push(...geo.registration.warnings);
  const extent = extendBounds({ ...previousModel.bounds }, latestModel.bounds);
  if (eps > 0.002 * diagonal(extent))
    warnings.push(
      `The ${project.tolerance} mm tolerance is large relative to the drawing extent (${Math.round(diagonal(extent))} mm). The drawing may not be at 1:1 model scale; small features can be matched to nearby geometry.`,
    );
  const transformAt = (p: Point) => alignmentTransformAt(alignment, p, 2 * eps);
  const toLatest = (p: Point) => applyTransform(transformAt(p), p);
  const impactFor = (kind: string) => {
    const impact =
      kind === "Door" || kind === "Window"
        ? ["Opening configuration", "Adjacent layout", "Dimensions"]
        : kind === "Geometry"
          ? ["Drawing geometry", "Layout coordination"]
          : kind === "Annotation" || kind === "Layout"
            ? ["Drawing presentation"]
            : ["Element geometry", "Dimensions", "Structural interface"];
    if (project.bomReleased) impact.push("Released BOM / fabrication items");
    return impact;
  };
  const add = (
    values: Pick<Issue, "tag" | "kind" | "rule" | "title" | "description" | "severity" | "point"> & Partial<Issue>,
  ) =>
    issues.push({
      id: randomUUID(),
      projectId: project.id,
      runId,
      number: issues.length + 1,
      status: "open",
      impact: impactFor(values.kind),
      drawingIds: [old.id, latest.id],
      createdAt,
      notes: "",
      ...values,
    });
  const entityIds = (prims: Prim[], indices: number[]) =>
    unique(indices.map((i) => prims[i].entity.id));
  const handles = (prims: Prim[], indices: number[]) =>
    unique(indices.map((i) => prims[i].entity.handle).filter((h): h is string => Boolean(h))).slice(0, 50);
  const unsupportedNear = (model: CadModel, b: Bounds | undefined, label: string) => {
    if (!b) return [];
    const near = (model.unsupported ?? []).filter((u) => u.bounds && intersects(u.bounds, b, eps));
    if (!near.length) return [];
    const types = unique(near.map((u) => u.type)).join(", ");
    return [`${near.length} unsupported ${types} record(s) in the ${label} drawing overlap this area and were not compared.`];
  };
  const item = (g: ChangeGroup): ChangeItem => ({
    change: g.change,
    previousIds: entityIds(geo.previous, g.previous).slice(0, MAX_IDS),
    latestIds: entityIds(geo.latest, g.latest).slice(0, MAX_IDS),
    bounds: g.bounds,
    ...(g.previousBounds ? { previousBounds: g.previousBounds } : {}),
    basis: g.basis,
    ...(g.delta && Object.keys(g.delta).length ? { delta: g.delta } : {}),
  });
  const evidenceFor = (g: ChangeGroup, items: ChangeGroup[]): FindingEvidence => {
    const previousIds = entityIds(geo.previous, g.previous),
      latestIds = entityIds(geo.latest, g.latest);
    const list = items.length > 1 ? items.slice(0, 200).map(item) : undefined;
    return {
      basis: g.basis,
      confidence: g.confidence,
      tolerance: eps,
      previousIds: previousIds.slice(0, MAX_IDS),
      latestIds: latestIds.slice(0, MAX_IDS),
      previousHandles: handles(geo.previous, g.previous),
      latestHandles: handles(geo.latest, g.latest),
      ...(g.previousBounds ? { previousBounds: g.previousBounds, previousPoint: center(g.previousBounds) } : {}),
      latestBounds: g.bounds,
      ...(g.delta && Object.keys(g.delta).length ? { delta: { ...g.delta, units: "mm" as const } } : {}),
      ...(list ? { items: list, omittedItems: Math.max(items.length - 200, 0) } : {}),
      ...(g.view ? { view: g.view } : {}),
      layerClass: g.classes.join(", "),
      warnings: [
        ...unsupportedNear(previousModel, g.previousBounds, "previous"),
        ...unsupportedNear(latestModel, g.latest.length ? g.latest.reduce((b, j) => extendBounds(b, geo.latest[j].bounds), emptyBounds()) : undefined, "latest"),
        ...(previousIds.length > MAX_IDS || latestIds.length > MAX_IDS ? [`Only the first ${MAX_IDS} entity references per drawing are listed.`] : []),
      ],
    };
  };
  const legacyGeometry = (g: ChangeGroup) => {
    const layers = unique([...g.previous.map((i) => geo.previous[i].entity.layer), ...g.latest.map((j) => geo.latest[j].entity.layer)]);
    return {
      added: entityIds(geo.latest, g.latest).length,
      removed: entityIds(geo.previous, g.previous).length,
      layer: layers.length === 1 ? layers[0] : "Multiple layers",
      bounds: g.bounds,
    };
  };

  const incompleteSources = [old, latest].filter((d) =>
    Object.values(d.model!.skippedCounts ?? {}).some((count) => count > 0) || (d.model!.unsupported?.length ?? 0) > 0,
  );
  if (incompleteSources.length) {
    const details = incompleteSources.map((d) => `${d.name}: ${Object.entries(d.model!.skippedCounts ?? {}).map(([type, count]) => `${count} ${type}`).join(", ") || "unsupported content"}`);
    add({
      tag: "EXTRACTION", kind: "Quality", rule: "QC-03", category: "quality", change: "uncertain", severity: "medium",
      title: "Partial CAD extraction requires verification",
      description: `${details.join("; ")}. These records were not compared. Absence of geometry findings does not establish that these drawings are identical. Check the original CAD and extraction warnings.`,
      point: center(latestModel.bounds),
      evidence: { basis: "The parser explicitly skipped unsupported content.", confidence: "high", tolerance: eps, previousIds: [], latestIds: [], warnings: details },
    });
  }

  // 1. Alignment is reported, never silently applied.
  if (alignment.global.status !== "identity") {
    const g = alignment.global;
    add({
      tag: "ALIGN",
      kind: "Layout",
      rule: "QC-05",
      category: "layout",
      change: g.status === "aligned" ? "aligned" : "uncertain",
      severity: g.status === "aligned" ? "low" : "medium",
      title: g.status === "aligned" ? `Drawing offset detected · ${describeTransform(g)}` : "Drawing alignment ambiguous",
      description:
        g.status === "aligned"
          ? `${g.basis} Geometry was compared after this alignment, which is typical of a changed export origin or a moved drawing. If the whole design was intentionally relocated, treat this as a design change.`
          : `${g.basis} Confirm the drawing origin; geometry findings may include unchanged content shown as removed and added.`,
      point: center(latestModel.bounds),
      evidence: {
        basis: g.basis,
        confidence: g.status === "aligned" ? (g.support >= 0.6 ? "high" : "medium") : "low",
        tolerance: eps,
        previousIds: [],
        latestIds: [],
        delta: { dx: r1(g.dx), dy: r1(g.dy), rotation: r1(g.rotation), units: "mm" },
      },
    });
  }
  for (const view of alignment.views.filter((v) => v.status === "aligned" || v.status === "ambiguous")) {
    const latestBox = view.latestBounds ?? view.previousBounds!;
    add({
      tag: view.id,
      kind: "Layout",
      rule: "QC-05",
      category: "layout",
      change: view.status === "aligned" ? "aligned" : "uncertain",
      severity: view.status === "aligned" ? "low" : "medium",
      title: view.status === "aligned" ? `View ${view.id} repositioned · ${describeTransform(view.transform)}` : `View ${view.id} placement ambiguous`,
      description: view.status === "aligned"
        ? `${view.basis} The view was compared in its own aligned frame. Confirm whether this placement change represents a design change.`
        : `${view.basis} No view-specific alignment was applied. Confirm the view placement before interpreting its geometry findings.`,
      point: center(latestBox),
      evidence: {
        basis: view.basis,
        confidence: view.status === "aligned" ? "medium" : "low",
        tolerance: eps,
        previousIds: [],
        latestIds: [],
        previousBounds: view.previousBounds,
        previousPoint: view.previousBounds && center(view.previousBounds),
        latestBounds: latestBox,
        view: view.id,
        delta: { dx: r1(view.transform.dx), dy: r1(view.transform.dy), rotation: r1(view.transform.rotation), units: "mm" },
      },
    });
  }

  // 2. Dimensions, with related geometry fused as supporting evidence.
  const dims = matchDimensions(previousModel.measurements, latestModel.measurements, transformAt, eps, project.tolerance);
  const open = new Set(geo.groups.filter((g) => !g.parts && g.previous.length + g.latest.length <= 400));
  const references = (f: DimensionFinding) => {
    const refs: [Point, Point][] = [];
    const prev = "before" in f ? f.before : undefined,
      next = "after" in f ? f.after : undefined;
    if (prev?.defPoints) refs.push([toLatest(prev.defPoints[0]), toLatest(prev.defPoints[1])]);
    if (next?.defPoints) refs.push(next.defPoints);
    if (!refs.length) {
      const m = (next ?? prev)!;
      const p = next ? m.point : toLatest(m.point);
      refs.push([p, p]);
    }
    return refs;
  };
  const fuse = (f: DimensionFinding) => {
    if (f.type !== "changed" && f.type !== "added" && f.type !== "removed") return [];
    const refs = references(f);
    const value = Math.max("before" in f ? f.before.value : 0, "after" in f ? f.after.value : 0);
    const taken: ChangeGroup[] = [];
    for (const g of open) {
      // Only element-sized geometry is linked; a large change area is not evidence for one dimension.
      if (diagonal(g.bounds) > Math.max(3 * value, 40 * eps)) continue;
      // Geometry touching a measured reference point, or a label close to the dimension line.
      const touches = refs.some(([p, q]) => boxDistance(g.bounds, p) <= 2 * eps || boxDistance(g.bounds, q) <= 2 * eps);
      const label = g.family === "text" && refs.some(([p, q]) => segmentDistance(g.bounds, p, q) <= Math.max(2 * eps, 0.5 * value));
      if (touches || label) taken.push(g);
    }
    taken.forEach((g) => {
      open.delete(g);
    });
    return taken;
  };
  const dimensionEvidence = (f: DimensionFinding, related: ChangeGroup[], basis: string, confidence: FindingEvidence["confidence"], delta?: number): FindingEvidence => {
    const prev = "before" in f ? [f.before] : "befores" in f ? f.befores : [];
    const next = "after" in f ? [f.after] : "afters" in f ? f.afters : [];
    const prevPoint = prev[0]?.point;
    return {
      basis: related.length
        ? `${basis} Related geometry touching the measured references: ${related.map((g) => `${g.change} (${g.previous.length + g.latest.length} primitives)`).join(", ")}. Proximity links evidence; it does not prove both belong to one element.`
        : basis,
      confidence,
      tolerance: project.tolerance,
      previousIds: unique([...prev.map((m) => m.entityId), ...related.flatMap((g) => entityIds(geo.previous, g.previous))]).slice(0, MAX_IDS),
      latestIds: unique([...next.map((m) => m.entityId), ...related.flatMap((g) => entityIds(geo.latest, g.latest))]).slice(0, MAX_IDS),
      previousHandles: unique(prev.map((m) => m.handle).filter((h): h is string => Boolean(h))),
      latestHandles: unique(next.map((m) => m.handle).filter((h): h is string => Boolean(h))),
      ...(prevPoint ? { previousPoint: prevPoint } : {}),
      ...(delta !== undefined ? { delta: { value: delta, units: "mm" as const } } : {}),
      ...(related.length ? { items: related.map(item) } : {}),
      layerClass: "dimension",
    };
  };
  const kindOf = (m: Measurement) => m.kind;
  for (const f of dims) {
    if (f.type === "changed") {
      const related = fuse(f);
      const delta = difference(f.after.value, f.before.value);
      add({
        tag: f.label,
        kind: kindOf(f.after),
        rule: "REV-01",
        category: "dimension",
        change: "modified",
        severity: "high",
        title: f.label.startsWith("Untagged") ? `Untagged dimension revised · ${f.before.value} → ${f.after.value} mm` : `${f.after.kind} ${f.label} revised`,
        description: `${f.label} changed from ${f.before.value} mm to ${f.after.value} mm (${delta > 0 ? "+" : ""}${delta} mm). ${f.basis} Verify the revised dimension and affected design details.`,
        point: f.after.point,
        previous: f.before.value,
        current: f.after.value,
        evidence: dimensionEvidence(f, related, f.basis, f.confidence, delta),
      });
    } else if (f.type === "added" || f.type === "removed") {
      const related = fuse(f);
      const m = f.type === "added" ? f.after : f.before;
      add({
        tag: f.label,
        kind: kindOf(m),
        rule: f.type === "added" ? "REV-02" : "REV-03",
        category: "dimension",
        change: f.type,
        severity: "medium",
        title: `${f.label} ${f.type} in latest revision`,
        description: `${f.basis} ${f.type === "added" ? "Verify its dimensions and placement." : "Verify its removal and downstream coordination."}`,
        point: f.type === "added" ? m.point : toLatest(m.point),
        ...(f.type === "added" ? { current: m.value } : { previous: m.value }),
        evidence: dimensionEvidence(f, related, f.basis, "high"),
      });
    } else if (f.type === "ambiguous") {
      const m = f.afters[0] ?? f.befores[0];
      add({
        tag: f.label,
        kind: kindOf(m),
        rule: "QC-02",
        category: "quality",
        change: "uncertain",
        severity: "medium",
        title: `${f.label}: ambiguous dimension mapping`,
        description: `${f.basis} Previous values: ${f.befores.slice(0, 20).map((x) => x.value).join(", ") || "none"}; latest values: ${f.afters.slice(0, 20).map((x) => x.value).join(", ") || "none"}.`,
        point: f.afters[0]?.point ?? toLatest(f.befores[0].point),
        evidence: dimensionEvidence(f, [], f.basis, "low"),
      });
    } else
      add({
        tag: f.label,
        kind: "Annotation",
        rule: "ANN-02",
        category: "annotation",
        change: "annotation",
        severity: "low",
        title: `${f.label}: dimension annotation changed`,
        description: f.basis,
        point: f.after.point,
        evidence: dimensionEvidence(f, [], f.basis, "high"),
      });
  }
  const overrides = latestModel.measurements.filter((m) => {
    const shown = displayedDimensionValue(m.displayText, latestModel.unitScale);
    return m.displayText && shown !== undefined && Math.abs(shown - m.value) > Math.max(project.tolerance, 0.5);
  });
  if (overrides.length)
    add({
      tag: "DIM-TEXT",
      kind: "Annotation",
      rule: "QC-04",
      category: "quality",
      change: "annotation",
      severity: "medium",
      title: `${overrides.length} dimension(s) display override text that differs from the measurement`,
      description: overrides.slice(0, 10).map((m) => `"${m.displayText}" shown where ${m.value} mm is measured`).join("; ") + ". Measured values were compared; confirm which value is intended.",
      point: overrides[0].point,
      evidence: {
        basis: "Displayed DIMENSION text (group 1) does not contain the measured value placeholder and differs from the measured distance.",
        confidence: "high",
        tolerance: project.tolerance,
        previousIds: [],
        latestIds: overrides.map((m) => m.entityId),
        layerClass: "dimension",
      },
    });

  // 3. Remaining geometry and annotation changes.
  const remaining = geo.groups;
  const ruleFor = (g: ChangeGroup) =>
    g.family !== "geometry"
      ? "ANN-01"
      : { added: "GEO-01", removed: "GEO-02", uncertain: "GEO-03", modified: "GEO-04", moved: "GEO-05" }[g.change];
  const subject = (g: ChangeGroup) =>
    g.family === "geometry"
      ? "Geometry"
      : g.classes.includes("text") && g.classes.length === 1
        ? "Text"
        : g.classes.includes("grid")
          ? "Grid annotation"
          : g.classes.includes("title block")
            ? "Title block"
            : "Annotation";
  const titleFor = (g: ChangeGroup) => {
    const s = subject(g);
    if (g.parts && g.view) return `Drawing view ${g.change} · ${legacyGeometry(g)[g.change === "added" ? "added" : "removed"]} entities`;
    if (g.change === "moved") return `${s} moved · (${g.delta?.dx}, ${g.delta?.dy}) mm`;
    if (g.change === "modified")
      return `${s} modified${g.delta?.length !== undefined ? ` · length ${g.delta.length > 0 ? "+" : ""}${g.delta.length} mm` : g.delta?.radius !== undefined ? ` · radius ${g.delta.radius > 0 ? "+" : ""}${g.delta.radius} mm` : ""}`;
    if (g.change === "uncertain") return `${s} changed · correspondence uncertain`;
    return `${s} ${g.change}`;
  };
  const sorted = [...remaining].sort(
    (a, b) => b.previous.length + b.latest.length - (a.previous.length + a.latest.length) || a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY,
  );
  const room = Math.max(MAX_FINDINGS - issues.length, 1);
  const individual = sorted.length > room ? sorted.slice(0, room - 1) : sorted;
  const overflow = sorted.length > room ? sorted.slice(room - 1) : [];
  const emit = (g: ChangeGroup, items: ChangeGroup[]) => {
    const geometry = legacyGeometry(g);
    const annotation = g.family !== "geometry";
    add({
      tag: `G${issues.length + 1}`,
      kind: annotation ? "Annotation" : "Geometry",
      rule: ruleFor(g),
      category: annotation ? "annotation" : "geometry",
      change: g.change,
      severity: annotation ? "low" : "medium",
      title: titleFor(g),
      description: `${g.basis} ${geometry.added} latest and ${geometry.removed} previous CAD entities are involved${g.view ? ` (view ${g.view})` : ""}. Geometry findings describe drawn primitives; they do not identify walls, doors or other elements.`,
      point: center(g.bounds),
      geometry,
      evidence: evidenceFor(g, items),
    });
  };
  for (const g of individual) emit(g, g.parts ?? [g]);
  if (overflow.length) {
    const pm = overflow.flatMap((g) => g.previous),
      lm = overflow.flatMap((g) => g.latest);
    const bounds = overflow.reduce((b, g) => extendBounds(b, g.bounds), emptyBounds());
    const summary: ChangeGroup = {
      change: "uncertain",
      family: overflow.some((g) => g.family === "geometry") ? "geometry" : "annotation",
      classes: unique(overflow.flatMap((g) => g.classes)),
      previous: pm,
      latest: lm,
      bounds,
      previousBounds: pm.length ? pm.reduce((b, i) => extendBounds(b, geo.previous[i].bounds), emptyBounds()) : undefined,
      basis: `${overflow.length} smaller change areas were combined to keep the register reviewable; counts are retained and up to 200 areas are available for individual inspection; any additional areas are explicitly reported as omitted.`,
      confidence: "low",
    };
    emit(summary, overflow);
    warnings.push(
      `More than ${MAX_FINDINGS} findings were produced. ${overflow.length} smaller change areas were combined into one summary finding; no change counts were discarded. Compare a smaller floor or zone for a more focused review.`,
    );
  }
  const geometryIssues = issues.filter((i) => i.geometry);
  if (geometryIssues.length || geo.groups.length) {
    const added = unique(geo.groups.flatMap((g) => entityIds(geo.latest, g.latest))).length,
      removed = unique(geo.groups.flatMap((g) => entityIds(geo.previous, g.previous))).length;
    warnings.push(
      `${added + removed} changed CAD entities (${added} added, ${removed} removed) are summarized in ${issues.length} findings. Geometry findings describe drawn primitives and do not infer dimensions or element identities; moved and modified classifications are evidence-based heuristics that require designer verification.`,
    );
  }
  const run: AnalysisRun = {
    id: runId,
    projectId: project.id,
    createdAt,
    createdBy: actor,
    oldId: old.id,
    newId: latest.id,
    issueCount: issues.length,
    durationMs: Math.round(performance.now() - started),
    checks: RULES.length,
    warnings,
    tolerance: project.tolerance,
    engineVersion: ENGINE_VERSION,
    config: {
      dimensionTolerance: project.tolerance,
      geometryTolerance: eps,
      alignment: "automatic-with-evidence",
      annotationFilter: "classify-only",
    },
    ...(context.sources ? { sources: context.sources } : {}),
    alignment,
    stats: geo.stats,
  };
  return { run, issues };
}
