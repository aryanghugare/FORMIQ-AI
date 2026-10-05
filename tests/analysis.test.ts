import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDxf } from "../lib/cad";
import { demoDxf } from "../lib/demo";
import { analyze, RULES } from "../lib/analysis";
import { issueCsv, reportHtml, cadSvg } from "../lib/reports";
import type { Drawing, Project } from "../lib/types";
const project: Project = {
  id: "p1",
  name: "Test project",
  code: "T01",
  location: "Mumbai",
  description: "",
  tolerance: 1,
  bomReleased: false,
  createdAt: new Date().toISOString(),
};
const drawing = (r: "old" | "new"): Drawing => ({
  id: r,
  projectId: "p1",
  name: r + ".dxf",
  revision: r,
  discipline: "architecture",
  format: "DXF",
  size: 100,
  uploadedAt: new Date().toISOString(),
  uploadedBy: "Tester",
  status: "ready",
  model: parseDxf(demoDxf(r)),
});
test("presentation D14 discrepancy is computed from real DXF entities", () => {
  const old = drawing("old"),
    latest = drawing("new");
  assert.equal(
    old.model!.measurements.find((m) => m.tag === "D14")?.value,
    900,
  );
  assert.equal(
    latest.model!.measurements.find((m) => m.tag === "D14")?.value,
    1000,
  );
  const result = analyze(project, old, latest, "Tester");
  assert.equal(result.issues.filter((i) => i.category === "dimension").length, 4);
  const mismatch = result.issues.find(
    (i) => i.tag === "D14" && i.rule === "REV-01",
  );
  assert.ok(mismatch);
  assert.equal(mismatch.current, 1000);
  assert.equal(mismatch.previous, 900);
  assert.equal(mismatch.severity, "high");
  assert.equal(mismatch.status, "open");
  assert.equal(
    mismatch.impact.includes("Released BOM / fabrication items"),
    false,
  );
});
test("Structure revisions compare directly; mixed disciplines are rejected", () => {
  const old = { ...drawing("old"), discipline: "structure" as const };
  const latest = { ...drawing("new"), discipline: "structure" as const };
  const result = analyze(project, old, latest, "Tester");
  assert.equal(result.issues.filter((i) => i.category === "dimension").length, 4);
  assert.equal(result.run.checks, RULES.length);
  assert.ok(result.issues.every((issue) => issue.drawingIds.length === 2));
  assert.equal("formworkId" in result.run, false);
  assert.throws(
    () => analyze(project, drawing("old"), latest, "Tester"),
    /Architecture with Architecture or Structure with Structure/,
  );
});
test("BOM impact requires explicitly confirmed release", () => {
  const result = analyze(
    { ...project, bomReleased: true },
    drawing("old"),
    drawing("new"),
    "Tester",
  );
  assert.ok(
    result.issues.every((i) =>
      i.impact.includes("Released BOM / fabrication items"),
    ),
  );
});
test("tolerance suppresses numerical findings without concealing new tags", () => {
  const result = analyze(
    { ...project, tolerance: 300 },
    drawing("old"),
    drawing("new"),
    "Tester",
  );
  assert.deepEqual(
    result.issues.filter((i) => i.category === "dimension").map((i) => i.rule),
    ["REV-02"],
  );
});
test("cross-project drawings and identical revisions are rejected", () => {
  assert.throws(
    () =>
      analyze(
        project,
        drawing("old"),
        { ...drawing("new"), projectId: "p2" },
        "T",
      ),
    /belong/,
  );
  assert.throws(
    () => analyze(project, drawing("old"), drawing("old"), "T"),
    /different/,
  );
});
test("ambiguous tags create a mapping issue, never a guessed mismatch", () => {
  const d = drawing("new");
  d.model!.measurements.push({ ...d.model!.measurements[0], value: 700 });
  const result = analyze(project, drawing("old"), d, "T");
  assert.equal(result.issues.filter((i) => i.tag === "D14").length, 1);
  assert.equal(result.issues.find((i) => i.tag === "D14")?.rule, "QC-02");
});
test("unknown drawing units block dimensional analysis", () => {
  const d = drawing("new");
  d.model = parseDxf(
    demoDxf("new").replace("$INSUNITS\n70\n4", "$INSUNITS\n70\n0"),
  );
  assert.equal(d.model.unitScale, null);
  assert.throws(
    () => analyze(project, drawing("old"), d, "T"),
    /unknown units/,
  );
});
test("malformed and binary DXF inputs fail explicitly", () => {
  assert.throws(() => parseDxf("not a drawing"), /Invalid DXF/);
  assert.throws(() => parseDxf("AutoCAD Binary DXF\x00"), /Binary DXF/);
});
test("metre units normalize measurements to millimetres", () => {
  const model = parseDxf(
    "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n8\nDOOR_D14\n70\n32\n13\n0\n23\n0\n14\n1\n24\n0\n42\n1\n0\nENDSEC\n0\nEOF\n",
  );
  assert.equal(model.measurements[0].value, 1000);
  assert.equal(model.entities[0].points[1].x, 1000);
});
test("angular dimensions are excluded from linear checks", () => {
  const model = parseDxf(demoDxf("new").replace(/70\n32/g, "70\n34"));
  assert.equal(model.measurements.length, 0);
  assert.ok(model.warnings.some((w) => w.includes("Angular")));
});
test("removed elements are detected between revisions", () => {
  const d = drawing("new");
  d.model!.measurements = d.model!.measurements.filter((m) => m.tag !== "D08");
  const result = analyze(project, drawing("old"), d, "T");
  assert.equal(result.issues.find((i) => i.tag === "D08")?.rule, "REV-03");
  assert.equal(result.issues.find((i) => i.tag === "D08")?.severity, "medium");
});
test("report escapes source text, marks geometry, and neutralizes CSV formulas", () => {
  const ds = [drawing("old"), drawing("new")],
    result = analyze(project, ...(ds as [Drawing, Drawing]), "Tester");
  result.issues[0].notes = "<script>alert(1)</script>";
  result.issues[0].title = '=HYPERLINK("evil")';
  const html = reportHtml(
    { ...project, name: "<script>evil</script>" },
    result.run,
    ds,
    result.issues,
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("does not approve"));
  result.issues[0].notes = '=HYPERLINK("evil")';
  assert.ok(issueCsv(result.issues).includes(`"'=HYPERLINK(""evil"")"`));
});
test("invalid numeric coordinates are rejected rather than silently replaced", () => {
  assert.throws(
    () => parseDxf(demoDxf("old").replace("10\n0\n20", "10\ninvalid\n20")),
    /Invalid numeric/,
  );
});
test("uniform block inserts apply translation, scale, and stable layer tags", () => {
  const content =
    "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nOPENING\n10\n0\n20\n0\n0\nDIMENSION\n8\n0\n70\n32\n13\n0\n23\n0\n14\n900\n24\n0\n42\n900\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nOPENING\n8\nDOOR_D14\n10\n5000\n20\n2000\n41\n2\n42\n2\n0\nENDSEC\n0\nEOF\n";
  const model = parseDxf(content);
  assert.equal(model.measurements[0].tag, "D14");
  assert.equal(model.measurements[0].value, 1800);
  assert.deepEqual(model.measurements[0].point, { x: 5000, y: 2000 });
});
function fixture(entities: string) {
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}
test("incomplete dimension endpoints never produce an invented distance to origin", () => {
  const model = parseDxf(
    fixture("0\nDIMENSION\n8\nDOOR_D14\n70\n32\n13\n900\n23\n0\n"),
  );
  assert.equal(model.measurements.length, 0);
  assert.ok(model.warnings.some((w) => w.includes("complete endpoints")));
});
test("3D lines and elevated inserts are excluded from planar review", () => {
  const model = parseDxf(
    fixture(
      "0\nLINE\n8\nWALLS\n10\n0\n20\n0\n30\n20\n11\n500\n21\n0\n31\n20\n",
    ),
  );
  assert.equal(model.entities.length, 0);
  assert.ok(model.warnings.some((w) => w.includes("Z coordinates")));
});
test("invalid and overflowing radii cannot reach the SVG renderer", () => {
  assert.throws(
    () => parseDxf(fixture("0\nCIRCLE\n10\n0\n20\n0\n40\n-1\n")),
    /radius/,
  );
  assert.throws(
    () => parseDxf(fixture("0\nCIRCLE\n10\n0\n20\n0\n40\n1e300\n")),
    /coordinates/,
  );
});
test("rotated block arcs preserve their orientation and appear in reports", () => {
  const content =
    "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nSWING\n10\n0\n20\n0\n0\nARC\n8\n0\n10\n0\n20\n0\n40\n900\n50\n0\n51\n90\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nSWING\n8\nDOOR_D14\n10\n0\n20\n0\n50\n90\n0\nENDSEC\n0\nEOF\n";
  const model = parseDxf(content);
  assert.equal(model.entities[0].startAngle, 90);
  assert.equal(model.entities[0].endAngle, 180);
  assert.match(cadSvg(model, []), /<path d="M /);
});
test("dimension tolerance handles floating-point boundaries consistently", () => {
  const ds = [drawing("old"), drawing("new")];
  ds[0].model!.measurements = [{ ...ds[0].model!.measurements[0], value: 0.2 }];
  ds[1].model!.measurements = [{ ...ds[1].model!.measurements[0], value: 0.3 }];
  assert.equal(
    analyze(
      { ...project, tolerance: 0.1 },
      ...(ds as [Drawing, Drawing]),
      "Tester",
    ).issues.filter((i) => i.category === "dimension").length,
    0,
  );
});
test("large repeated tag sets produce one ambiguity finding per tag", () => {
  const d = drawing("new");
  d.model!.measurements = Array.from({ length: 10000 }, () => ({
    ...d.model!.measurements[0],
  }));
  assert.equal(
    analyze(project, drawing("old"), d, "Tester").issues.filter(
      (i) => i.tag === "D14",
    ).length,
    1,
  );
});
test("a single massive polyline is bounded even though its vertices share one entity", () => {
  const content = fixture(
    "0\nLWPOLYLINE\n8\nWALLS\n" +
      Array.from({ length: 200001 }, (_, i) => `10\n${i}\n20\n0\n`).join(""),
  );
  assert.throws(() => parseDxf(content), /vertex limit/);
});
test("CSV neutralizes formulas hidden behind leading spaces", () => {
  const result = analyze(project, drawing("old"), drawing("new"), "Tester");
  result.issues[0].notes = '  =HYPERLINK("evil")';
  assert.ok(issueCsv(result.issues).includes(`"'  =HYPERLINK(""evil"")"`));
});

test("ordinary untagged dimensions compare by reference and direction", () => {
  const dim = (value: number) =>
    fixture(
      `0\nDIMENSION\n8\nDIMENSIONS\n70\n32\n13\n0\n23\n0\n14\n${value}\n24\n0\n42\n${value}\n50\n0\n`,
    );
  const previous = { ...drawing("old"), model: parseDxf(dim(900)) };
  const latest = { ...drawing("new"), model: parseDxf(dim(1000)) };
  const result = analyze(project, previous, latest, "Tester");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].rule, "REV-01");
  assert.equal(result.issues[0].previous, 900);
  assert.equal(result.issues[0].current, 1000);
  assert.ok(result.run.warnings.some((w) => w.includes("Untagged")));
  const duplicate = {
    ...latest,
    model: parseDxf(
      dim(1000).replace(
        "0\nENDSEC\n0\nEOF",
        "0\nDIMENSION\n8\nDIMENSIONS\n70\n32\n13\n0\n23\n0\n14\n1200\n24\n0\n42\n1200\n0\nENDSEC\n0\nEOF",
      ),
    ),
  };
  assert.equal(
    analyze(project, previous, duplicate, "Tester").issues[0].rule,
    "QC-02",
  );
});

test("geometry-only revisions produce honest geometry findings", () => {
  const line = (length: number) =>
    fixture(`0\nLINE\n8\nWALLS\n10\n0\n20\n0\n11\n${length}\n21\n0\n`);
  const previous = { ...drawing("old"), model: parseDxf(line(900)) };
  const latest = { ...drawing("new"), model: parseDxf(line(1000)) };
  const result = analyze(project, previous, latest, "Tester");
  assert.deepEqual(
    result.issues.map((i) => i.rule),
    ["GEO-04"],
  );
  assert.equal(result.issues[0].evidence?.delta?.length, 100);
  assert.ok(
    result.issues.every(
      (i) => i.previous === undefined && i.current === undefined,
    ),
  );
  assert.ok(
    result.run.warnings.some((w) => w.includes("do not infer dimensions")),
  );
  const reversed = {
    ...latest,
    model: parseDxf(
      fixture("0\nLINE\n8\nWALLS\n10\n900\n20\n0\n11\n0\n21\n0\n"),
    ),
  };
  assert.equal(analyze(project, previous, reversed, "Tester").issues.length, 0);
  const unknown = {
    ...previous,
    model: { ...previous.model, unitScale: null },
  };
  assert.throws(
    () => analyze(project, unknown, latest, "Tester"),
    /unknown units/,
  );
});

test("tagged checks remain active alongside geometry fallback", () => {
  const previous = drawing("old");
  const latest = {
    ...drawing("new"),
    model: parseDxf(
      fixture("0\nLINE\n8\nWALLS\n10\n0\n20\n0\n11\n1000\n21\n0\n"),
    ),
  };
  const result = analyze(project, previous, latest, "Tester");
  assert.ok(result.issues.some((i) => i.rule === "REV-03" && i.tag === "D14"));
  assert.ok(result.issues.some((i) => i.rule === "GEO-01"));
});

test("geometry areas preserve all duplicate counts without flooding the review", () => {
  const line = "0\nLINE\n8\nWALLS\n10\n0\n20\n0\n11\n1000\n21\n0\n";
  const previous = { ...drawing("old"), model: parseDxf(fixture(line)) };
  const latest = {
    ...drawing("new"),
    model: parseDxf(fixture(line.repeat(502))),
  };
  const result = analyze(project, previous, latest, "Tester");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].geometry?.added, 501);
  assert.equal(result.issues[0].geometry?.removed, 0);
  assert.ok(result.issues.every((i) => i.rule === "GEO-01"));
  assert.ok(
    result.run.warnings.some((w) => w.includes("501 changed CAD entities")),
  );
});
