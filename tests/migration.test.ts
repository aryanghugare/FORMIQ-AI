import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDxf } from "../lib/cad";
import { demoDxf } from "../lib/demo";
import { db, get, listDrawingSummaries, save } from "../lib/db";
const directory = mkdtempSync(join(tmpdir(), "formiq-migration-"));
process.env.FORMIQ_DATA_DIR = directory;
process.env.FORMIQ_DEMO = "false";
process.env.FORMIQ_ADMIN_EMAIL = "migration@example.com";
process.env.FORMIQ_ADMIN_PASSWORD = "Migration@2026";
const legacy = new DatabaseSync(join(directory, "formiq.sqlite"));
legacy.exec(
  "CREATE TABLE records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,projectId TEXT NOT NULL DEFAULT '',data TEXT NOT NULL)",
);
const drawing = {
  id: "legacy",
  projectId: "old",
  name: "old.dxf",
  model: parseDxf(demoDxf("old")),
};
legacy
  .prepare("INSERT INTO records VALUES (?,?,?,?)")
  .run("legacy", "drawing", "old", JSON.stringify(drawing));
legacy.close();
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
test("older databases gain cached drawing summaries without losing geometry", () => {
  const summary = listDrawingSummaries()[0];
  assert.equal(summary.model, undefined);
  assert.equal(summary.extraction?.measurementCount, 5);
  assert.deepEqual(get("drawing", "legacy"), drawing);
  assert.ok(
    db()
      .prepare("PRAGMA table_info(records)")
      .all()
      .some((row) => row.name === "summary"),
  );
  const before = JSON.stringify(drawing).length,
    after = JSON.stringify(summary).length;
  assert.ok(after < before * 0.2);
});
test("summary cache is refreshed when a drawing changes", () => {
  const model = parseDxf(demoDxf("new"));
  save("drawing", { ...drawing, model });
  assert.equal(listDrawingSummaries()[0].extraction?.measurementCount, 6);
});
