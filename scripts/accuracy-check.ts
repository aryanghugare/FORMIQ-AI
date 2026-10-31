/**
 * Scores the comparison engine against reviewer-confirmed changes.
 *
 *   npm run accuracy:check -- benchmark/manifest.json [--json] [--min-recall 0.9] [--min-precision 0.8]
 *
 * Manifest (paths relative to the manifest; coordinates in latest-revision millimetres):
 * {
 *   "tolerance": 1, "radius": 500,
 *   "cases": [{
 *     "name": "L12 Rev.05 -> Rev.06", "previous": "L12-05.dwg", "latest": "L12-06.dwg",
 *     "expected": [{ "id": "D14 widened", "x": 12000, "y": 3400, "category": "geometry" }]
 *   }]
 * }
 */
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { z } from "zod";
import { parseDxf } from "../lib/cad";
import { decodeDxf } from "../lib/dxf-encoding";
import { convertDwg } from "../lib/converter";
import { analyze } from "../lib/analysis";
import { scoreFindings, type CaseScore } from "../lib/accuracy";
import type { Drawing, Project } from "../lib/types";

const expectedChange = z.object({
  id: z.string().optional(),
  x: z.number(),
  y: z.number(),
  radius: z.number().positive().optional(),
  category: z.enum(["dimension", "geometry", "annotation", "layout", "quality"]).optional(),
  change: z.enum(["added", "removed", "modified", "moved", "annotation", "uncertain", "aligned"]).optional(),
  rule: z.string().optional(),
  note: z.string().optional(),
});
const manifestSchema = z.object({
  tolerance: z.number().positive().default(1),
  radius: z.number().positive().default(500),
  ignoreCategories: z.array(z.string()).default(["quality"]),
  cases: z
    .array(
      z.object({
        name: z.string(),
        previous: z.string(),
        latest: z.string(),
        tolerance: z.number().positive().optional(),
        radius: z.number().positive().optional(),
        discipline: z.enum(["architecture", "structure"]).default("architecture"),
        expected: z.array(expectedChange),
      }),
    )
    .min(1),
});

async function load(path: string, id: string, discipline: Drawing["discipline"]): Promise<Drawing> {
  const bytes = readFileSync(path),
    extension = extname(path).toLowerCase();
  if (![".dxf", ".dwg"].includes(extension)) throw new Error(`${path}: use DWG or ASCII DXF files.`);
  const model = parseDxf(extension === ".dwg" ? await convertDwg(bytes) : decodeDxf(bytes));
  return { id, projectId: "accuracy", name: basename(path), revision: id, discipline, format: extension === ".dwg" ? "DWG" : "DXF", size: bytes.length, uploadedAt: "", uploadedBy: "Accuracy check", status: "ready", model };
}

const percent = (v: number) => `${(v * 100).toFixed(1)}%`;
const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
};

async function main() {
  const manifestPath = process.argv.slice(2).find((a) => a.endsWith(".json"));
  if (!manifestPath)
    throw new Error("Usage: npm run accuracy:check -- manifest.json [--json] [--min-recall 0.9] [--min-precision 0.8]");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const root = dirname(resolve(manifestPath));
  const results: (CaseScore & { name: string; selfComparisonFindings: number })[] = [];
  for (const c of manifest.cases) {
    const tolerance = c.tolerance ?? manifest.tolerance;
    const project: Project = { id: "accuracy", name: c.name, code: "ACC", location: "", description: "", tolerance, bomReleased: false, createdAt: "" };
    const previous = await load(resolve(root, c.previous), "previous", c.discipline);
    const latest = await load(resolve(root, c.latest), "latest", c.discipline);
    const { issues } = analyze(project, previous, latest, "Accuracy check");
    // Stability control: a drawing compared with itself (entity order reversed) should report no changes.
    const self = analyze(project, latest, { ...latest, id: "latest-copy", model: { ...latest.model!, entities: [...latest.model!.entities].reverse() } }, "Accuracy check");
    results.push({
      name: c.name,
      selfComparisonFindings: self.issues.filter((i) => !manifest.ignoreCategories.includes(i.category ?? "")).length,
      ...scoreFindings(issues, c.expected, { radius: c.radius ?? manifest.radius, ignoreCategories: manifest.ignoreCategories }),
    });
  }
  const totals = results.reduce(
    (t, r) => ({ expected: t.expected + r.expected, found: t.found + r.found, findings: t.findings + r.findings, truePositives: t.truePositives + r.truePositives }),
    { expected: 0, found: 0, findings: 0, truePositives: 0 },
  );
  const recall = totals.expected ? totals.found / totals.expected : 1,
    precision = totals.findings ? totals.truePositives / totals.findings : 1;
  if (process.argv.includes("--json")) console.log(JSON.stringify({ recall, precision, totals, cases: results }, null, 2));
  else {
    for (const r of results) {
      console.log(`\n${r.name}\n  recall ${percent(r.recall)} (${r.found}/${r.expected})  precision ${percent(r.precision)} (${r.truePositives}/${r.findings})  self-comparison findings: ${r.selfComparisonFindings}`);
      for (const m of r.missed) console.log(`  MISSED  ${m.id ?? ""} at (${m.x}, ${m.y})${m.note ? ` - ${m.note}` : ""}`);
      for (const f of r.falsePositives) console.log(`  EXTRA   #${f.number} ${f.rule} ${f.title} at (${Math.round(f.point.x)}, ${Math.round(f.point.y)})`);
    }
    console.log(`\nOverall recall ${percent(recall)}  precision ${percent(precision)}`);
  }
  const minRecall = option("--min-recall"),
    minPrecision = option("--min-precision");
  if ((minRecall !== undefined && recall < minRecall) || (minPrecision !== undefined && precision < minPrecision)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Accuracy check failed.");
  process.exitCode = 1;
});
