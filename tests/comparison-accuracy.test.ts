import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDxf } from "../lib/cad";
import { analyze } from "../lib/analysis";
import { compareGeometry } from "../lib/geometry-comparison";
import { matchDimensions } from "../lib/dimension-matching";
import { applyTransform } from "../lib/alignment";
import type { CadEntity, CadModel, Drawing, Measurement, Project, RigidTransform } from "../lib/types";
const identity = { rotation: 0, dx: 0, dy: 0 };
const line = (id: string, x = 0, y = 0, length = 100, layer = "WALL"): CadEntity => ({ id, type: "line", layer, points: [{ x, y }, { x: x + length, y }] });
const model = (entities: CadEntity[], measurements: Measurement[] = []): CadModel => ({ entities, measurements, layers: [], units: "mm", unitScale: 1, warnings: [], bounds: { minX: 0, minY: 0, maxX: 10000, maxY: 10000 }, entityCount: entities.length });
const measurement = (id: string, value = 100, end = value): Measurement => ({ tag: `DIM@${id}`, kind: "Dimension", value, point: { x: 0, y: 0 }, layer: "DIM", entityId: id, source: "dimension", axis: 0, dimType: "aligned", defPoints: [{ x: 0, y: 0 }, { x: end, y: 0 }], linePoint: { x: 0, y: 20 } });
const project: Project = { id: "p", name: "Test", code: "T", location: "", description: "", tolerance: 1, bomReleased: false, createdAt: "" };
const drawing = (id: string, m: CadModel): Drawing => ({ id, projectId: "p", name: id, revision: id, discipline: "architecture", format: "DXF", size: 1, uploadedAt: "", uploadedBy: "Test", status: "ready", model: m });

test("geometry is checked even when both drawings have unchanged dimensions", () => {
  const result = analyze(project, drawing("a", model([line("wall", 500)], [measurement("a")])), drawing("b", model([line("wall", 500, 0, 130)], [measurement("b")])), "Test");
  assert.ok(result.issues.some((i) => i.category === "geometry"));
  assert.equal(result.issues.filter((i) => i.rule === "REV-01").length, 0);
});
test("unchanged untagged features with reversed endpoints do not change", () => {
  const before = measurement("a"); const after = measurement("b");
  after.defPoints = [after.defPoints![1], after.defPoints![0]];
  assert.deepEqual(matchDimensions([before], [after], () => identity, 1, 1), []);
});
test("dimension annotation movement is separate from physical changes", () => {
  const after = measurement("b"); after.linePoint = { x: 0, y: 60 };
  const result = matchDimensions([measurement("a")], [after], () => identity, 1, 1);
  assert.equal(result.length, 1); assert.equal(result[0].type, "annotation");
});
test("duplicate reference dimensions report ambiguity rather than guessed numerical changes", () => {
  const result = matchDimensions([measurement("a"), measurement("b", 200, 100)], [measurement("c"), measurement("d", 300, 100)], () => identity, 1, 1);
  assert.equal(result.length, 1); assert.equal(result[0].type, "ambiguous");
});
test("one moved reference point is matched only with unique correspondence", () => {
  const result = matchDimensions([measurement("a")], [measurement("b", 130)], () => identity, 1, 1);
  assert.equal(result.length, 1); assert.equal(result[0].type, "changed");
});
test("equal values at unrelated reference locations are never paired", () => {
  const after = measurement("b"); after.defPoints = [{ x: 500, y: 500 }, { x: 600, y: 500 }];
  const result = matchDimensions([measurement("a")], [after], () => identity, 1, 1);
  assert.deepEqual(result.map((f) => f.type).sort(), ["added", "removed"]);
});
test("below-tolerance geometry is unchanged and larger edits remain visible", () => {
  assert.equal(compareGeometry(model([line("a")]), model([line("b", 0, 0, 100.5)]), 1).groups.length, 0);
  assert.ok(compareGeometry(model([line("a")]), model([line("b", 0, 0, 110)]), 1).groups.length);
});
test("equivalent line segmentation and reversed direction are unchanged", () => {
  const b = line("b", 50, 0, 50); b.points.reverse();
  assert.equal(compareGeometry(model([line("a")]), model([line("c", 0, 0, 50), b]), 1).groups.length, 0);
});
test("annotation geometry cannot conceal a removed physical entity", () => {
  const result = compareGeometry(model([line("a")]), model([line("b", 0, 0, 100, "DIM")]), 1);
  assert.ok(result.groups.some((g) => g.family === "geometry" && g.previous.length));
  assert.ok(result.groups.some((g) => g.family === "annotation" && g.latest.length));
});
test("line and straight polyline representations match without relying on layer names", () => {
  const b: CadEntity = { ...line("b", 0, 0, 100, "Renamed"), type: "polyline" };
  assert.equal(compareGeometry(model([line("a")]), model([b]), 1).groups.length, 0);
});
test("duplicated geometry is preserved as an additional instance", () => {
  const result = compareGeometry(model([line("a")]), model([line("b"), line("c")]), 1);
  assert.equal(result.groups.reduce((n, g) => n + g.latest.length, 0), 1);
});
const anchors = () => Array.from({ length: 12 }, (_, i) => line(`a${i}`, (i % 4) * 400, Math.floor(i / 4) * 300, 70 + i * 13));
const map = (entities: CadEntity[], t: RigidTransform) => entities.map((e) => ({ ...e, points: e.points.map((p) => applyTransform(t, p)) }));
test("strong translated or rotated geometry is aligned with explicit evidence", () => {
  for (const t of [{ rotation: 0, dx: 3500, dy: 2200 }, { rotation: 90, dx: 3500, dy: 2200 }]) {
    const result = compareGeometry(model(anchors()), model(map(anchors(), t)), 0.1);
    assert.equal(result.registration.alignment.global.status, "aligned");
    assert.equal(result.groups.length, 0);
  }
});
test("a minority matching fragment must not determine global alignment", () => {
  const before = anchors();
  const latest = [...map(before, { rotation: 0, dx: 3000, dy: 2000 }), ...Array.from({ length: 60 }, (_, i) => line(`extra${i}`, 9000 + i * 30, 9000 + i * 50, 300 + i * 7))];
  const result = compareGeometry(model(before), model(latest), 0.1);
  assert.notEqual(result.registration.alignment.global.status, "aligned");
});
test("local edits stay visible when the majority remains at its original placement", () => {
  const before = anchors(); const after = anchors(); after[0] = line("edited", 0, 0, 120);
  const result = compareGeometry(model(before), model(after), 1);
  assert.equal(result.registration.alignment.global.status, "identity");
  assert.ok(result.groups.length);
});
test("curved polyline bulges are compared as curves, not straight chords", () => {
  const curved: CadEntity = { ...line("a"), type: "polyline", bulges: [0.5, 0] };
  assert.equal(compareGeometry(model([curved]), model([{ ...curved, id: "b" }]), 0.1).groups.length, 0);
  assert.ok(compareGeometry(model([curved]), model([line("straight")]), 0.1).groups.length);
});
test("sample CAD self-comparison and entity order changes are stable", () => {
  const sample = parseDxf(readFileSync("public/samples/ARCH-L12-Rev-05.dxf", "utf8"));
  const result = analyze(project, drawing("a", sample), drawing("b", { ...sample, entities: [...sample.entities].reverse() }), "Test");
  assert.equal(result.issues.length, 0);
});

test("numeric override parsing respects units and ignores part identifiers", async () => {
  const { displayedDimensionValue } = await import("../lib/dimension-text");
  assert.equal(displayedDimensionValue("D14"), undefined);
  assert.equal(displayedDimensionValue("4 in"), 101.6);
  assert.equal(displayedDimensionValue("0.1", 1000), 100);
  assert.equal(displayedDimensionValue("<> mm"), undefined);
});
test("dense repeated dimensions are reported as ambiguity without unbounded guesses", () => {
  const dims = Array.from({ length: 300 }, (_, i) => measurement(String(i)));
  const result = matchDimensions(dims, dims.map((m) => ({ ...m, value: m.value + 50 })), () => identity, 1, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "ambiguous");
  assert.match(result[0].basis, /densely repeated/);
});

test("segmented annotation lines cannot conceal physical geometry", () => {
  const result = compareGeometry(model([line("a")]), model([line("b", 0, 0, 50, "DIM"), line("c", 50, 0, 50, "DIM")]), 1);
  assert.ok(result.groups.some((g) => g.family === "geometry" && g.previous.length));
});
test("curved polyline bounds include the curve outside its chord", async () => {
  const { cadEntityBounds } = await import("../lib/geometry");
  const curved: CadEntity = { ...line("a"), type: "polyline", bulges: [1, 0] };
  const bounds = cadEntityBounds(curved)!;
  assert.ok(Math.abs(bounds.minY + 50) < 1e-8);
  assert.ok(Math.abs(bounds.maxX - 100) < 1e-8);
});

test("partial extraction is visible as a quality finding even when supported geometry is identical", () => {
  const partial = { ...model([line("a")]), skippedCounts: { HATCH: 2 }, unsupported: [{ type: "HATCH", layer: "WALL", reason: "unsupported" }] };
  const result = analyze(project, drawing("a", partial), drawing("b", partial), "Test");
  assert.ok(result.issues.some((i) => i.rule === "QC-03" && i.change === "uncertain"));
  assert.equal(result.issues.filter((i) => i.category === "geometry").length, 0);
});

test("multiple tagged axes tolerate minor orientation noise without inventing added dimensions", () => {
  const dims = [ { ...measurement("a"), tag: "D14", axis: 0.49 }, { ...measurement("b"), tag: "D14", axis: 90 } ];
  const result = matchDimensions(dims, [ { ...dims[0], axis: 0.51 }, dims[1] ], () => identity, 1, 1);
  assert.deepEqual(result, []);
});
test("equivalent metre and millimetre exports compare identically", () => {
  const fixture = (units: number, length: number) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALL\n10\n0\n20\n0\n11\n${length}\n21\n0\n0\nENDSEC\n0\nEOF\n`;
  const result = compareGeometry(parseDxf(fixture(4, 1000)), parseDxf(fixture(6, 1)), 1);
  assert.equal(result.groups.length, 0);
});
