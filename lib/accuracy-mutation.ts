import { scoreFindings } from "./accuracy";
import { analyze } from "./analysis";
import { cadEntityBounds } from "./geometry";
import type { CadEntity, CadModel, Drawing, Issue, Point, Project } from "./types";

/**
 * Known-answer accuracy: apply edits with a known location to a real drawing, compare, and score.
 * This measures detection of isolated CAD edits. It does not replace designer-confirmed revision
 * pairs, whose changes are messier, but its ground truth does not come from the engine or a person's reading of it.
 */
export type MutationKind = "delete" | "add" | "move" | "resize" | "text";
export const MUTATION_KINDS: MutationKind[] = ["delete", "add", "move", "resize", "text"];
const EXPECTED_CHANGE: Record<MutationKind, Issue["change"][]> = {
  delete: ["removed"],
  add: ["added"],
  move: ["moved"],
  resize: ["modified"],
  text: ["modified"],
};
export interface MutationSummary {
  kind: MutationKind;
  trials: number;
  detected: number;
  classified: number;
  extraFindings: number;
  recall: number;
  classifiedRate: number;
}
/** Small deterministic generator, so a run can be repeated exactly. */
export function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const box = (e: CadEntity) => {
  const xs = e.points.map((p) => p.x), ys = e.points.map((p) => p.y);
  return cadEntityBounds(e) ?? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const middle = (e: CadEntity): Point => {
  const b = box(e);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
};
/** One edit; returns the edited model and where the change is, or undefined if nothing is eligible. */
export function mutate(model: CadModel, kind: MutationKind, random: () => number, size: number) {
  const entities = model.entities;
  const eligible = entities
    .map((e, i) => ({ e, i }))
    .filter(({ e }) =>
      e.role !== "dimension" &&
      (kind === "text"
        ? e.type === "text"
        : e.type === "line" && Math.hypot(e.points[1].x - e.points[0].x, e.points[1].y - e.points[0].y) > size),
    );
  if (!eligible.length) return;
  const { e, i } = eligible[Math.floor(random() * eligible.length)];
  const next = entities.slice();
  let at = middle(e);
  if (kind === "delete") next.splice(i, 1);
  else if (kind === "add") {
    const b = model.bounds;
    const a = { x: b.minX + random() * (b.maxX - b.minX), y: b.minY + random() * (b.maxY - b.minY) };
    const angle = random() * Math.PI * 2;
    const added: CadEntity = {
      id: "mutation-added",
      type: "line",
      layer: e.layer,
      points: [a, { x: a.x + Math.cos(angle) * size, y: a.y + Math.sin(angle) * size }],
    };
    next.push(added);
    at = middle(added);
  } else if (kind === "move") {
    const angle = random() * Math.PI * 2;
    const dx = Math.cos(angle) * size, dy = Math.sin(angle) * size;
    next[i] = { ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    at = middle(next[i]);
  } else if (kind === "resize") {
    const [a, b] = e.points, length = Math.hypot(b.x - a.x, b.y - a.y);
    const grown = { x: b.x + ((b.x - a.x) / length) * size, y: b.y + ((b.y - a.y) / length) * size };
    next[i] = { ...e, points: [a, grown] };
    at = middle(next[i]);
  } else next[i] = { ...e, text: `${e.text ?? ""} REV` };
  return { model: { ...model, entities: next }, at };
}
const drawing = (id: string, project: Project, model: CadModel): Drawing => ({
  id, projectId: project.id, name: id, revision: id, discipline: "architecture", format: "DXF",
  size: 0, uploadedAt: "", uploadedBy: "", status: "ready", model,
});
export function runMutationTrials(model: CadModel, options: { trials: number; seed: number; tolerance?: number }): MutationSummary[] {
  const tolerance = options.tolerance ?? 1;
  const b = model.bounds, diagonal = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  // Edits are clearly above tolerance and small against the drawing; findings must land close to them.
  const size = Math.max(10 * tolerance, diagonal * 0.005);
  const radius = Math.max(5 * tolerance, diagonal * 0.01);
  const project: Project = { id: "mutation", name: "", code: "", location: "", description: "", tolerance, bomReleased: false, createdAt: "" };
  return MUTATION_KINDS.flatMap((kind) => {
    const random = seededRandom(options.seed + MUTATION_KINDS.indexOf(kind));
    let trials = 0, detected = 0, classified = 0, extraFindings = 0;
    for (let t = 0; t < options.trials; t++) {
      const edit = mutate(model, kind, random, size);
      if (!edit) break;
      trials++;
      const { issues } = analyze(project, drawing("a", project, model), drawing("b", project, edit.model), "Mutation check");
      const score = scoreFindings(issues, [{ id: kind, ...edit.at }], { radius, ignoreCategories: ["quality"] });
      if (score.found) detected++;
      extraFindings += score.falsePositives.length;
      const hit = new Set(score.matches[0]?.findings);
      if (issues.some((i) => hit.has(i.number) && EXPECTED_CHANGE[kind].includes(i.change))) classified++;
    }
    return trials
      ? [{ kind, trials, detected, classified, extraFindings, recall: detected / trials, classifiedRate: classified / trials }]
      : [];
  });
}
