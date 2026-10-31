import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFindings, findingLocations } from "../lib/accuracy";
import type { Bounds, Issue } from "../lib/types";

const box = (x: number, y: number, size = 100): Bounds => ({ minX: x, minY: y, maxX: x + size, maxY: y + size });
let n = 0;
const issue = (values: Partial<Issue>): Issue => ({
  id: String(++n), projectId: "p", runId: "r", number: n, title: `finding ${n}`, tag: "G", kind: "Geometry", rule: "GEO-01",
  severity: "medium", status: "open", description: "", point: { x: 0, y: 0 }, impact: [], drawingIds: [], createdAt: "", notes: "",
  category: "geometry", change: "added", ...values,
});

test("recall and precision count confirmed changes and explained findings", () => {
  const issues = [
    issue({ evidence: { basis: "", confidence: "high", tolerance: 1, previousIds: [], latestIds: [], latestBounds: box(1000, 1000) } }),
    issue({ evidence: { basis: "", confidence: "high", tolerance: 1, previousIds: [], latestIds: [], latestBounds: box(9000, 9000) } }),
    issue({ category: "quality", rule: "QC-03" }),
  ];
  const score = scoreFindings(issues, [{ x: 1050, y: 1050 }, { x: 5000, y: 5000, id: "missing" }], { radius: 200 });
  assert.equal(score.recall, 0.5);
  assert.equal(score.precision, 0.5);
  assert.equal(score.findings, 2, "quality advisories are not scored as change findings");
  assert.equal(score.missed[0].id, "missing");
  assert.equal(score.falsePositives.length, 1);
});

test("a combined summary finding matches only its individual change areas", () => {
  const summary = issue({
    evidence: {
      basis: "", confidence: "low", tolerance: 1, previousIds: [], latestIds: [], latestBounds: box(0, 0, 100000),
      items: [{ change: "added", previousIds: [], latestIds: [], bounds: box(100, 100), basis: "" }],
    },
  });
  assert.deepEqual(findingLocations(summary), [box(100, 100)]);
  const score = scoreFindings([summary], [{ x: 150, y: 150 }, { x: 50000, y: 50000 }], { radius: 10 });
  assert.equal(score.found, 1);
});

test("expected changes can require a category, change type or rule", () => {
  const dimension = issue({ category: "dimension", rule: "REV-01", change: "modified", point: { x: 10, y: 10 } });
  assert.equal(scoreFindings([dimension], [{ x: 10, y: 10, category: "geometry" }], { radius: 5 }).found, 0);
  assert.equal(scoreFindings([dimension], [{ x: 10, y: 10, rule: "REV-01", change: "modified" }], { radius: 5 }).found, 1);
});
