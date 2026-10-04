import { HttpError } from "./errors";
import { randomUUID } from "node:crypto";
import { geometryAreas } from "./geometry-comparison";
import type {
  AnalysisRun,
  Drawing,
  Issue,
  Measurement,
  Project,
} from "./types";
export const RULES = [
  {
    id: "REV-01",
    name: "Dimension revision",
    description:
      "Compare tagged or automatically referenced dimensions between revisions of the same discipline.",
  },
  {
    id: "REV-02",
    name: "Added element detection",
    description: "Identify tagged elements introduced in the latest revision.",
  },
  {
    id: "REV-03",
    name: "Removed element detection",
    description: "Identify tagged elements absent from the latest revision.",
  },
  {
    id: "QC-02",
    name: "Ambiguous tag detection",
    description: "Multiple dimensions for one tag require manual mapping.",
  },
  {
    id: "QC-03",
    name: "Unit and extraction validation",
    description:
      "Require known units and readable measurements or supported geometry.",
  },
  {
    id: "GEO-01",
    name: "Geometry additions",
    description:
      "Detect extracted geometry present only in the latest revision.",
  },
  {
    id: "GEO-02",
    name: "Geometry removals",
    description:
      "Detect extracted geometry present only in the previous revision.",
  },
  {
    id: "GEO-03",
    name: "Geometry change areas",
    description:
      "Summarize nearby additions and removals without inferring element identity.",
  },
];
const mapByTag = (ms: Measurement[]) => {
  const map = new Map<string, Measurement[]>();
  for (const m of ms) {
    const group = map.get(m.tag);
    if (group) group.push(m);
    else map.set(m.tag, [m]);
  }
  return map;
};
const difference = (a: number, b: number) => Math.round((a - b) * 1000) / 1000;
export function analyze(
  project: Project,
  old: Drawing,
  latest: Drawing,
  actor: string,
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
  const runId = randomUUID(),
    createdAt = new Date().toISOString(),
    issues: Issue[] = [];
  const oldMap = mapByTag(old.model!.measurements),
    newMap = mapByTag(latest.model!.measurements);
  const warnings = [
    ...new Set(
      [old, latest].flatMap((d) =>
        d.model!.warnings.map((w) => `${d.name}: ${w}`),
      ),
    ),
  ];
  const add = (
    m: Pick<Measurement, "tag" | "kind" | "point">,
    rule: string,
    title: string,
    description: string,
    severity: Issue["severity"],
    values: Partial<Issue> = {},
  ) => {
    const impact =
      m.kind === "Door" || m.kind === "Window"
        ? ["Opening configuration", "Adjacent layout", "Dimensions"]
        : ["Element geometry", "Dimensions", "Structural interface"];
    if (project.bomReleased) impact.push("Released BOM / fabrication items");
    issues.push({
      id: randomUUID(),
      projectId: project.id,
      runId,
      number: issues.length + 1,
      title,
      description,
      severity,
      status: "open",
      tag: m.tag,
      kind: m.kind,
      rule,
      point: m.point,
      impact,
      drawingIds: [old.id, latest.id],
      createdAt,
      notes: "",
      ...values,
    });
  };
  const geometryMode =
    !old.model!.measurements.length || !latest.model!.measurements.length;
  if (geometryMode) {
    warnings.push(
      "Geometry comparison was used because one or both drawings have no readable linear dimensions. Changes are compared at their existing coordinates and layers; moved geometry appears as removed/added. These findings do not infer dimensions or element identities. Designer verification is required.",
    );
    const { areas, total, added, removed, combined } = geometryAreas(
      old.model!,
      latest.model!,
    );
    for (const area of areas) {
      const change =
        area.added && area.removed
          ? "changed"
          : area.added
            ? "added"
            : "removed";
      add(
        {
          tag: `G${issues.length + 1}`,
          kind: "Geometry",
          point: {
            x: (area.bounds.minX + area.bounds.maxX) / 2,
            y: (area.bounds.minY + area.bounds.maxY) / 2,
          },
        },
        change === "changed"
          ? "GEO-03"
          : change === "added"
            ? "GEO-01"
            : "GEO-02",
        `Geometry ${change} · area ${issues.length + 1}`,
        `Layer ${area.layer}: ${area.added} added and ${area.removed} removed CAD entities in this area. Nearby changes are grouped for review; this does not mean they belong to one element. Modified or moved geometry can appear as removed and added. Use Overlay to verify both source drawings.`,
        "medium",
        {
          geometry: area,
          impact: [
            "Drawing geometry",
            "Layout coordination",
            ...(project.bomReleased
              ? ["Released BOM / fabrication items"]
              : []),
          ],
        },
      );
    }
    warnings.push(
      `${total} changed CAD entities (${added} added, ${removed} removed) are summarized in ${areas.length} review areas. These are geometry changes, not measured dimension changes.`,
    );
    if (combined)
      warnings.push(
        "More than 200 change areas were found. Smaller areas beyond the first 199 were combined into one summary; no change counts were discarded. Compare a smaller floor or zone for a more focused review.",
      );
    if (
      total > 20 &&
      total /
        Math.max(
          old.model!.entities.length + latest.model!.entities.length,
          1,
        ) >
        0.6
    )
      warnings.push(
        "Much of the extracted geometry differs. Check that both drawings cover the same floor or zone and use the same origin, orientation and units before treating these as design revisions. No automatic alignment is applied.",
      );
  }
  const allTags = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const tag of allTags) {
    const olds = oldMap.get(tag) ?? [],
      news = newMap.get(tag) ?? [];
    const before = olds[0],
      after = news[0];
    if ([olds, news].some((ms) => ms.length > 1)) {
      add(
        after ?? before,
        "QC-02",
        `${tag}: ambiguous dimension mapping`,
        "Multiple measurements share this tag. Verify unique tags before comparing values.",
        "medium",
      );
      continue;
    }
    if (before && !after) {
      add(
        before,
        "REV-03",
        `${tag} removed in latest revision`,
        "This tagged element is absent from the latest revision. Verify its removal and downstream coordination.",
        "medium",
        { previous: before.value },
      );
      continue;
    }
    if (after && !before) {
      add(
        after,
        "REV-02",
        `${tag} added in latest revision`,
        "A new tagged element was found in the latest revision. Verify its dimensions and placement.",
        "medium",
        { current: after.value },
      );
      continue;
    }
    if (
      before &&
      after &&
      Math.abs(difference(after.value, before.value)) > project.tolerance
    ) {
      add(
        after,
        "REV-01",
        `${after.kind} ${tag} revised`,
        `${tag} changed from ${before.value} mm to ${after.value} mm (${after.value - before.value > 0 ? "+" : ""}${difference(after.value, before.value)} mm). Verify the revised dimension and affected design details.`,
        "high",
        { previous: before.value, current: after.value },
      );
    }
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
    checks: geometryMode ? 8 : 5,
    warnings,
    tolerance: project.tolerance,
  };
  return { run, issues };
}
