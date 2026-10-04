import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDxf } from "../lib/cad";
import { demoDxf } from "../lib/demo";
import { analyze } from "../lib/analysis";
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
const drawing = (r: "old" | "new" | "formwork"): Drawing => ({
  id: r,
  projectId: "p1",
  name: r + ".dxf",
  revision: r,
  discipline: r === "formwork" ? "formwork" : "architecture",
  format: "DXF",
  size: 100,
  uploadedAt: new Date().toISOString(),
  uploadedBy: "Tester",
  status: "ready",
  model: parseDxf(demoDxf(r)),
});
test("presentation D14 discrepancy is computed from real DXF entities", () => {
  const old = drawing("old"),
    latest = drawing("new"),
    fw = drawing("formwork");
  assert.equal(
    old.model!.measurements.find((m) => m.tag === "D14")?.value,
    900,
  );
  assert.equal(
    latest.model!.measurements.find((m) => m.tag === "D14")?.value,
    1000,
  );
  const result = analyze(project, old, latest, fw, "Tester");
  assert.equal(result.issues.length, 7);
  const mismatch = result.issues.find(
    (i) => i.tag === "D14" && i.rule === "FW-01",
  );
  assert.ok(mismatch);
  assert.equal(mismatch.current, 1000);
  assert.equal(mismatch.formwork, 900);
  assert.equal(mismatch.severity, "high");
  assert.equal(mismatch.status, "open");
  assert.equal(
    mismatch.impact.includes("Released BOM / fabrication items"),
    false,
  );
});
test("BOM impact requires explicitly confirmed release", () => {
  const result = analyze(
    { ...project, bomReleased: true },
    drawing("old"),
    drawing("new"),
    drawing("formwork"),
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
    drawing("formwork"),
    "Tester",
  );
  assert.deepEqual(
    result.issues.map((i) => i.rule),
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
        drawing("formwork"),
        "T",
      ),
    /belong/,
  );
  assert.throws(
    () =>
      analyze(
        project,
        drawing("old"),
        drawing("old"),
        drawing("formwork"),
        "T",
      ),
    /different/,
  );
});
test("ambiguous tags create a mapping issue, never a guessed mismatch", () => {
  const d = drawing("new");
  d.model!.measurements.push({ ...d.model!.measurements[0], value: 700 });
  const result = analyze(project, drawing("old"), d, drawing("formwork"), "T");
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
    () => analyze(project, drawing("old"), d, drawing("formwork"), "T"),
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
test("removed elements retained in formwork are flagged", () => {
  const d = drawing("new");
  d.model!.measurements = d.model!.measurements.filter((m) => m.tag !== "D08");
  const result = analyze(project, drawing("old"), d, drawing("formwork"), "T");
  assert.equal(result.issues.find((i) => i.tag === "D08")?.rule, "REV-03");
  assert.equal(result.issues.find((i) => i.tag === "D08")?.severity, "high");
});
test("report escapes source text, marks geometry, and neutralizes CSV formulas", () => {
  const ds = [drawing("old"), drawing("new"), drawing("formwork")],
    result = analyze(project, ...(ds as [Drawing, Drawing, Drawing]), "Tester");
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
  const ds = [drawing("old"), drawing("new"), drawing("formwork")];
  ds[0].model!.measurements = [{ ...ds[0].model!.measurements[0], value: 0.2 }];
  ds[1].model!.measurements = [{ ...ds[1].model!.measurements[0], value: 0.3 }];
  ds[2].model!.measurements = [{ ...ds[2].model!.measurements[0], value: 0.2 }];
  assert.equal(
    analyze(
      { ...project, tolerance: 0.1 },
      ...(ds as [Drawing, Drawing, Drawing]),
      "Tester",
    ).issues.length,
    0,
  );
});
test("large repeated tag sets produce one ambiguity finding per tag", () => {
  const d = drawing("new");
  d.model!.measurements = Array.from({ length: 10000 }, () => ({
    ...d.model!.measurements[0],
  }));
  assert.equal(
    analyze(
      project,
      drawing("old"),
      d,
      drawing("formwork"),
      "Tester",
    ).issues.filter((i) => i.tag === "D14").length,
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
  const result = analyze(
    project,
    drawing("old"),
    drawing("new"),
    drawing("formwork"),
    "Tester",
  );
  result.issues[0].notes = '  =HYPERLINK("evil")';
  assert.ok(issueCsv(result.issues).includes(`"'  =HYPERLINK(""evil"")"`));
});
