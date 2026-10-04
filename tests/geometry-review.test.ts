import { test } from "node:test";
import assert from "node:assert/strict";
import { geometryAreas } from "../lib/geometry-comparison";
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
test("changed geometry is grouped spatially with honest mixed counts", () => {
  const before = model([entity("1", 100), entity("2", 9000)]);
  const after = model([entity("3", 110), entity("2", 9000)]);
  const result = geometryAreas(before, after);
  assert.equal(result.total, 2);
  assert.equal(result.areas.length, 1);
  assert.equal(result.areas[0].added, 1);
  assert.equal(result.areas[0].removed, 1);
  assert.deepEqual(result.areas[0].bounds, {
    minX: 100,
    minY: 0,
    maxX: 120,
    maxY: 0,
  });
});
test("separate layers stay separate and overflow preserves all change counts", () => {
  const before = model([]);
  const after = model(
    Array.from({ length: 300 }, (_, i) => entity(String(i), 100, `Layer-${i}`)),
  );
  const result = geometryAreas(before, after);
  assert.equal(result.areas.length, 200);
  assert.equal(result.combined, true);
  assert.equal(result.total, 300);
  assert.equal(result.added, 300);
  assert.equal(result.removed, 0);
  assert.equal(result.areas.at(-1)?.added, 101);
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
