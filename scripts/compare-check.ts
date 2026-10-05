import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { parseDxf } from "../lib/cad";
import { convertDwg, converterDescription } from "../lib/converter";
import { analyze } from "../lib/analysis";
import type { Drawing, Project } from "../lib/types";
async function main() {
  const [before, after, toleranceArg = "1"] = process.argv.slice(2);
  const tolerance = Number(toleranceArg);
  if (!before || !after || !Number.isFinite(tolerance) || tolerance <= 0)
    throw new Error("Usage: npm run compare:check -- previous.dxf latest.dxf [tolerance-mm]. DWG requires a configured native converter.");
  const project: Project = { id: "benchmark", name: "Comparison check", code: "CHECK", location: "", description: "", tolerance, bomReleased: false, createdAt: "" };
  const drawings: Drawing[] = [];
  for (const [index, path] of [before, after].entries()) {
    const bytes = readFileSync(path), extension = extname(path).toLowerCase();
    if (![".dxf", ".dwg"].includes(extension)) throw new Error("Use DWG or ASCII DXF files.");
    const model = parseDxf(extension === ".dwg" ? await convertDwg(bytes) : bytes.toString("utf8"));
    if (extension === ".dwg") model.converter = await converterDescription();
    drawings.push({ id: String(index), projectId: project.id, name: basename(path), revision: String(index), discipline: "architecture", format: extension === ".dwg" ? "DWG" : "DXF", size: bytes.length, uploadedAt: "", uploadedBy: "Check", status: "ready", sha256: createHash("sha256").update(bytes).digest("hex"), model });
  }
  const result = analyze(project, drawings[0], drawings[1], "Check");
  const controls = drawings.map((d) => {
    const run = analyze(project, d, { ...d, id: `${d.id}-copy`, model: { ...d.model!, entities: [...d.model!.entities].reverse() } }, "Check");
    return { name: d.name, selfComparisonChangeFindings: run.issues.filter((i) => i.category !== "quality").length };
  });
  console.log(JSON.stringify({ groundTruthValidated: false, note: "Self-comparison controls test stability; review findings against the original CAD to establish precision and recall.", engine: result.run.engineVersion, controls, sources: drawings.map((d) => ({ name: d.name, sha256: d.sha256, parser: d.model!.parserVersion, converter: d.model!.converter, entities: d.model!.entities.length, measurements: d.model!.measurements.length })), stats: result.run.stats, alignment: result.run.alignment, warnings: result.run.warnings, findings: result.issues.map((i) => ({ rule: i.rule, category: i.category, title: i.title, confidence: i.evidence?.confidence, basis: i.evidence?.basis })) }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Comparison failed."); process.exitCode = 1; });
