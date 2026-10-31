import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDxf, cleanText } from "../lib/cad";
import { decodeDxf } from "../lib/dxf-encoding";
import { primitives } from "../lib/primitives";
import type { Point } from "../lib/types";

const dxf = (entities: string, blocks = "", header = "9\n$INSUNITS\n70\n4\n") =>
  `0\nSECTION\n2\nHEADER\n${header}0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n${blocks}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
const block = (name: string, body: string) => `0\nBLOCK\n2\n${name}\n10\n0\n20\n0\n${body}0\nENDBLK\n`;
const near = (a: Point, b: Point, eps = 1e-6) =>
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= eps, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const s45 = Math.SQRT1_2;

test("mirrored arcs (extrusion 0,0,-1) are read in world coordinates instead of skipped", () => {
  const model = parseDxf(dxf("0\nARC\n8\nDOOR\n10\n100\n20\n0\n40\n100\n50\n0\n51\n90\n210\n0\n220\n0\n230\n-1\n"));
  assert.equal(model.entities.length, 1);
  const arc = model.entities[0];
  near(arc.points[0], { x: -100, y: 0 });
  assert.equal(arc.startAngle, 90);
  assert.equal(arc.endAngle, 180);
  near(primitives(model.entities)[0].mid, { x: -100 - 100 * s45, y: 100 * s45 });
  assert.equal(model.skippedCounts?.["non-planar extrusion"], undefined);
});

test("lines keep world coordinates whatever their extrusion direction", () => {
  const model = parseDxf(dxf("0\nLINE\n8\nWALL\n10\n10\n20\n0\n11\n20\n21\n0\n210\n0\n220\n0\n230\n-1\n"));
  assert.deepEqual(model.entities[0].points, [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
});

test("tilted entities are still reported as unsupported", () => {
  const model = parseDxf(dxf("0\nCIRCLE\n8\nX\n10\n0\n20\n0\n40\n5\n210\n1\n220\n0\n230\n0\n"));
  assert.equal(model.entities.length, 0);
  assert.equal(model.skippedCounts?.["non-planar extrusion"], 1);
});

test("negatively scaled (mirrored) blocks keep the true door-swing arc", () => {
  const blocks = block("SWING", "0\nARC\n8\n0\n10\n0\n20\n0\n40\n900\n50\n0\n51\n90\n");
  const model = parseDxf(dxf("0\nINSERT\n2\nSWING\n8\nDOOR\n10\n0\n20\n0\n41\n-1\n42\n1\n", blocks));
  const arc = model.entities[0];
  assert.equal(arc.startAngle, 90);
  assert.equal(arc.endAngle, 180);
  near(primitives(model.entities)[0].mid, { x: -900 * s45, y: 900 * s45 });
});

test("mirrored polyline bulges turn the opposite way", () => {
  const blocks = block("CURVE", "0\nLWPOLYLINE\n8\n0\n90\n2\n70\n0\n10\n0\n20\n0\n42\n1\n10\n100\n20\n0\n");
  const plain = parseDxf(dxf("0\nINSERT\n2\nCURVE\n8\nWALL\n10\n0\n20\n0\n", blocks));
  const mirrored = parseDxf(dxf("0\nINSERT\n2\nCURVE\n8\nWALL\n10\n0\n20\n0\n41\n-1\n", blocks));
  near(primitives(plain.entities)[0].mid, { x: 50, y: -50 });
  near(primitives(mirrored.entities)[0].mid, { x: -50, y: -50 });
});

test("MINSERT arrays expand every copy", () => {
  const blocks = block("TICK", "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n");
  const model = parseDxf(dxf("0\nINSERT\n2\nTICK\n8\nGRIDMARK\n10\n0\n20\n0\n70\n3\n71\n2\n44\n100\n45\n50\n", blocks));
  assert.equal(model.entities.length, 6);
  assert.ok(model.entities.some((e) => e.points[0].x === 200 && e.points[0].y === 50));
  assert.equal(new Set(model.entities.map((e) => e.block)).size, 6);
});

test("non-uniformly scaled blocks keep their geometry: circles become sampled ellipses", () => {
  const blocks = block(
    "WIN",
    "0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n10\n0\nDIMENSION\n8\n0\n70\n33\n13\n0\n23\n0\n14\n100\n24\n0\n42\n100\n",
  );
  const model = parseDxf(dxf("0\nINSERT\n2\nWIN\n8\nWINDOW\n10\n0\n20\n0\n41\n2\n42\n1\n", blocks));
  const outline = model.entities.find((e) => e.type === "polyline")!;
  assert.ok(outline.closed);
  const xs = outline.points.map((p) => p.x), ys = outline.points.map((p) => p.y);
  assert.ok(Math.abs(Math.max(...xs) - 20) < 1e-9 && Math.abs(Math.min(...xs) + 20) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - 10) < 0.01);
  // The stored 100 cannot be rescaled non-uniformly; the measured reference points give 200.
  assert.equal(model.measurements[0].value, 200);
  assert.equal(model.measurements[0].valueSource, "computed");
});

test("ellipses are sampled, including partial and mirrored ones", () => {
  const full = parseDxf(dxf("0\nELLIPSE\n8\nX\n10\n0\n20\n0\n11\n100\n21\n0\n40\n0.5\n41\n0\n42\n6.283185307179586\n"));
  const outline = full.entities[0];
  assert.equal(outline.type, "polyline");
  assert.ok(outline.closed);
  assert.ok(Math.abs(Math.max(...outline.points.map((p) => p.y)) - 50) < 0.1);
  const half = parseDxf(dxf("0\nELLIPSE\n8\nX\n10\n0\n20\n0\n11\n100\n21\n0\n40\n0.5\n41\n0\n42\n3.141592653589793\n"));
  near(half.entities[0].points[0], { x: 100, y: 0 });
  near(half.entities[0].points.at(-1)!, { x: -100, y: 0 }, 1e-9);
  const flipped = parseDxf(dxf("0\nELLIPSE\n8\nX\n10\n0\n20\n0\n11\n100\n21\n0\n40\n0.5\n41\n0\n42\n1.5707963267948966\n210\n0\n220\n0\n230\n-1\n"));
  near(flipped.entities[0].points.at(-1)!, { x: 0, y: -50 }, 1e-9);
});

test("splines are evaluated from control points and knots", () => {
  const corner = parseDxf(dxf("0\nSPLINE\n8\nX\n70\n8\n71\n1\n72\n5\n73\n3\n40\n0\n40\n0\n40\n1\n40\n2\n40\n2\n10\n0\n20\n0\n10\n100\n20\n0\n10\n100\n20\n100\n"));
  const pts = corner.entities[0].points;
  near(pts[0], { x: 0, y: 0 });
  near(pts.at(-1)!, { x: 100, y: 100 });
  assert.ok(pts.some((p) => Math.hypot(p.x - 100, p.y) < 1e-9));
  const quadratic = parseDxf(dxf("0\nSPLINE\n8\nX\n70\n8\n71\n2\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n10\n0\n20\n0\n10\n50\n20\n100\n10\n100\n20\n0\n"));
  near(quadratic.entities[0].points[8], { x: 50, y: 50 });
});

test("splines with only fit points fall back to the fit polyline with a warning", () => {
  const model = parseDxf(dxf("0\nSPLINE\n8\nX\n71\n3\n11\n0\n21\n0\n11\n50\n21\n10\n11\n100\n21\n0\n"));
  assert.equal(model.entities[0].points.length, 3);
  assert.ok(model.warnings.some((w) => w.includes("fit points")));
});

test("text special characters and MTEXT formatting are decoded", () => {
  assert.equal(cleanText("\\U+AC00\\U+B098"), "가나");
  assert.equal(cleanText("\\M+3B0A1"), "가");
  assert.equal(cleanText("90%%d %%p5 %%c20"), "90° ±5 Ø20");
  assert.equal(cleanText("{\\fArial|b0|i0;Hello}\\PWorld"), "Hello World");
  assert.equal(cleanText("\\S1/2;\" \\LUnder\\l"), "1/2\" Under");
  assert.equal(cleanText("a\\\\b \\{x\\}"), "a\\b {x}");
  // Formatting removal must not swallow Unicode escapes followed by later codes.
  assert.equal(cleanText("\\U+D1B5\\U+B85C;\\H2.5;Text"), "통로;Text");
});

test("legacy DXF files are decoded with their declared code page", () => {
  const header = "9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\nANSI_949\n9\n$INSUNITS\n70\n4\n";
  const [before, after] = dxf("0\nTEXT\n8\nNOTE\n10\n0\n20\n0\n40\n100\n1\n@@\n", "", header).split("@@");
  const korean = Buffer.concat([Buffer.from(before, "latin1"), Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), Buffer.from(after, "latin1")]);
  assert.equal(parseDxf(decodeDxf(korean)).entities[0].text, "가나");
  const western = Buffer.from(dxf("0\nTEXT\n8\nNOTE\n10\n0\n20\n0\n40\n100\n1\ncaf\u00e9\n", "", header.replace("ANSI_949", "ANSI_1252")), "latin1");
  assert.equal(parseDxf(decodeDxf(western)).entities[0].text, "café");
  const modern = Buffer.from(dxf("0\nTEXT\n8\nNOTE\n10\n0\n20\n0\n40\n100\n1\n가나\n", "", "9\n$ACADVER\n1\nAC1032\n9\n$INSUNITS\n70\n4\n"), "utf8");
  assert.equal(parseDxf(decodeDxf(modern)).entities[0].text, "가나");
});
