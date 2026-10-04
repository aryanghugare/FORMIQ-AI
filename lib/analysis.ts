import { HttpError } from "./errors";
import { randomUUID } from "node:crypto";
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
    name: "Tagged dimension revision",
    description: "Compare stable element tags between architectural revisions.",
  },
  {
    id: "FW-01",
    name: "Opening width coordination",
    description: "Door and window measurements against current formwork.",
  },
  {
    id: "FW-02",
    name: "Structural dimension coordination",
    description: "Beam, wall and slab measurements against current formwork.",
  },
  {
    id: "REV-02",
    name: "New element coverage",
    description: "New tagged elements absent from the selected formwork.",
  },
  {
    id: "REV-03",
    name: "Removed element clearance",
    description: "Removed tagged elements that remain in formwork.",
  },
  {
    id: "QC-01",
    name: "Missing formwork coverage",
    description:
      "Current tagged elements with no matching formwork measurement.",
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
      "Block dimensional analysis with unknown units or no tagged measurements.",
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
  fw: Drawing,
  actor: string,
) {
  const started = performance.now();
  if (old.id === latest.id)
    throw new HttpError("Select two different architectural revisions.");
  if ([old, latest, fw].some((d) => d.projectId !== project.id))
    throw new HttpError("All drawings must belong to this project.");
  if (
    old.discipline !== "architecture" ||
    latest.discipline !== "architecture" ||
    fw.discipline !== "formwork"
  )
    throw new HttpError(
      "Select old architecture, new architecture, and formwork drawings.",
    );
  for (const d of [old, latest, fw]) {
    if (d.status !== "ready" || !d.model)
      throw new HttpError(`${d.name} is not ready for analysis.`);
    if (!d.model.unitScale)
      throw new HttpError(
        `${d.name} has unknown units. Export it with explicit $INSUNITS.`,
      );
    if (!d.model.measurements.length)
      throw new HttpError(
        `${d.name} has no tagged dimensions. See the CAD import guide.`,
      );
  }
  const runId = randomUUID(),
    createdAt = new Date().toISOString(),
    issues: Issue[] = [];
  const oldMap = mapByTag(old.model!.measurements),
    newMap = mapByTag(latest.model!.measurements),
    fwMap = mapByTag(fw.model!.measurements);
  const warnings = [
    ...new Set(
      [old, latest, fw].flatMap((d) =>
        d.model!.warnings.map((w) => `${d.name}: ${w}`),
      ),
    ),
  ];
  const add = (
    m: Measurement,
    rule: string,
    title: string,
    description: string,
    severity: Issue["severity"],
    values: Partial<Issue> = {},
  ) => {
    const impact =
      m.kind === "Door" || m.kind === "Window"
        ? ["Opening configuration", "Adjacent wall panels", "Dimensions"]
        : ["Panel arrangement", "Dimensions", "Structural interface"];
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
      drawingIds: [old.id, latest.id, fw.id],
      createdAt,
      notes: "",
      ...values,
    });
  };
  const allTags = new Set([
    ...oldMap.keys(),
    ...newMap.keys(),
    ...fwMap.keys(),
  ]);
  for (const tag of allTags) {
    const olds = oldMap.get(tag) ?? [],
      news = newMap.get(tag) ?? [],
      fws = fwMap.get(tag) ?? [];
    const before = olds[0],
      after = news[0],
      form = fws[0];
    if ([olds, news, fws].some((ms) => ms.length > 1)) {
      add(
        after ?? before ?? form,
        "QC-02",
        `${tag}: ambiguous dimension mapping`,
        "Multiple measurements share this tag. Verify unique tags for each checked dimension before comparing values.",
        "medium",
      );
      continue;
    }
    if (before && !after) {
      add(
        before,
        "REV-03",
        `${tag} removed in latest revision`,
        form
          ? "The element was removed from architecture but is still present in formwork. Check the retained opening or panel."
          : "This tagged element is absent from the latest architecture. Verify removal and downstream coordination.",
        form ? "high" : "low",
        { previous: before.value, formwork: form?.value },
      );
      continue;
    }
    if (after && !before) {
      add(
        after,
        "REV-02",
        `${tag} added in latest revision`,
        form
          ? "New architectural element. Verify the current formwork arrangement."
          : "New architectural element has no matching tagged formwork measurement.",
        "medium",
        { current: after.value, formwork: form?.value },
      );
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
        `${tag} changed from ${before.value} mm to ${after.value} mm (${after.value - before.value > 0 ? "+" : ""}${Math.round((after.value - before.value) * 1000) / 1000} mm). Check the affected formwork arrangement.`,
        form &&
          Math.abs(difference(after.value, form.value)) > project.tolerance
          ? "high"
          : "medium",
        { previous: before.value, current: after.value, formwork: form?.value },
      );
    }
    if (
      after &&
      form &&
      Math.abs(difference(after.value, form.value)) > project.tolerance
    ) {
      add(
        after,
        ["Door", "Window"].includes(after.kind) ? "FW-01" : "FW-02",
        `${tag}: formwork dimension mismatch`,
        `Latest architecture is ${after.value} mm; current formwork is ${form.value} mm. Difference: ${Math.abs(difference(after.value, form.value))} mm. Designer verification is required.`,
        "high",
        { previous: before?.value, current: after.value, formwork: form.value },
      );
    } else if (after && !form && before) {
      add(
        after,
        "QC-01",
        `${tag}: missing formwork reference`,
        "No matching tagged formwork measurement was found. Verify coverage or add a stable tag.",
        "medium",
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
    formworkId: fw.id,
    issueCount: issues.length,
    durationMs: Math.round(performance.now() - started),
    checks: RULES.length,
    warnings,
    tolerance: project.tolerance,
  };
  return { run, issues };
}
