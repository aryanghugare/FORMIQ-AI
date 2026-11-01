/**
 * Known-answer accuracy on a real drawing: applies edits with known locations, then scores detection.
 *
 *   npm run accuracy:mutate -- drawing.dxf [--trials 40] [--seed 1] [--tolerance 1] [--json] [--min-recall 0.95]
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseDxf } from "../lib/cad";
import { decodeDxf } from "../lib/dxf-encoding";
import { convertDwg } from "../lib/converter";
import { runMutationTrials } from "../lib/accuracy-mutation";

const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
};
async function main() {
  const path = process.argv.slice(2).find((a) => [".dxf", ".dwg"].includes(extname(a).toLowerCase()));
  if (!path) throw new Error("Usage: npm run accuracy:mutate -- drawing.dxf [--trials 40] [--seed 1] [--tolerance 1] [--json] [--min-recall 0.95]");
  const bytes = readFileSync(path);
  const model = parseDxf(extname(path).toLowerCase() === ".dwg" ? await convertDwg(bytes) : decodeDxf(bytes));
  const results = runMutationTrials(model, { trials: option("--trials") ?? 40, seed: option("--seed") ?? 1, tolerance: option("--tolerance") });
  const trials = results.reduce((n, r) => n + r.trials, 0);
  const recall = trials ? results.reduce((n, r) => n + r.detected, 0) / trials : 0;
  if (process.argv.includes("--json")) console.log(JSON.stringify({ recall, results }, null, 2));
  else {
    console.log("edit      trials  detected  classified  extra findings");
    for (const r of results)
      console.log(`${r.kind.padEnd(9)} ${String(r.trials).padStart(6)}  ${`${(r.recall * 100).toFixed(1)}%`.padStart(8)}  ${`${(r.classifiedRate * 100).toFixed(1)}%`.padStart(10)}  ${String(r.extraFindings).padStart(14)}`);
    console.log(`\nOverall detection ${(recall * 100).toFixed(1)}% across ${trials} isolated edits. These are injected edits, not reviewer-confirmed revisions.`);
  }
  const minimum = option("--min-recall");
  if (minimum !== undefined && recall < minimum) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Mutation check failed.");
  process.exitCode = 1;
});
