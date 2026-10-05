import { test } from "node:test";
import assert from "node:assert/strict";
import { compareGeometry } from "../lib/geometry-comparison";
import { findingMarkers } from "../lib/finding-markers";
import type { CadModel, Issue, CadEntity } from "../lib/types";
const entity = (id: string, x: number, layer = "WALL"): CadEntity => ({
  id,
  type: "line",
  layer,
  points: [
    { x, y: 0 },
    { x: x + 10, y: 0 },
  ],
});
const model = (entities: CadEntity[]): CadModel => ({
  entities,
  measurements: [],
  layers: [],
  units: "mm",
  unitScale: 1,
  warnings: [],
  bounds: { minX: 0, minY: 0, maxX: 10000, maxY: 10000 },
  entityCount: entities.length,
});
test("a moved line retains before/after references and its displacement", () => {
  const result = compareGeometry(model([entity("1", 100), entity("2", 9000)]), model([entity("3", 110), entity("2", 9000)]), 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].change, "moved");
  assert.equal(result.groups[0].delta?.dx, 10);
  assert.equal(result.groups[0].previous.length, 1);
  assert.equal(result.groups[0].latest.length, 1);
});
test("grouped additions preserve duplicate counts", () => {
  const result = compareGeometry(model([]), model(Array.from({ length: 300 }, (_, i) => entity(String(i), 100, `Layer-${i}`))), 1);
  assert.equal(result.groups.reduce((n, g) => n + g.latest.length, 0), 300);
  assert.equal(result.groups.reduce((n, g) => n + g.previous.length, 0), 0);
});
const issue = (id: string, x: number) =>
  ({ id, number: Number(id), point: { x, y: 0 } }) as Issue;
test("markers cluster at overview and split on zoom while keeping selection visible", () => {
  const issues = [issue("1", 0), issue("2", 100), issue("3", 1000)];
  const overview = findingMarkers(issues, 10);
  assert.equal(overview.length, 2);
  assert.deepEqual(
    overview[0].issues.map((i) => i.id),
    ["1", "2"],
  );
  assert.equal(findingMarkers(issues, 1).length, 3);
  const selected = findingMarkers(issues, 10, "2");
  assert.equal(selected.at(-1)?.issues[0].id, "2");
  assert.equal(selected.at(-1)?.issues.length, 1);
  assert.equal(
    selected.reduce((n, marker) => n + marker.issues.length, 0),
    3,
  );
});
