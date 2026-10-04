import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "formiq-test-"));
process.env.FORMIQ_DATA_DIR = dir;
process.env.FORMIQ_DEMO = "true";
import { db, get, list, save, transaction } from "../lib/db";
after(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
test("demo seed is deterministic and persists its parsed drawings and analysis", () => {
  assert.equal(list("project").length, 1);
  assert.equal(list("drawing").length, 2);
  assert.equal(list("issue").length, 4);
  db();
  assert.equal(list("issue").length, 4);
});
test("failed transactions do not leave partial review records", () => {
  assert.throws(() =>
    transaction(() => {
      save("test", { id: "rollback", value: "x" });
      throw new Error("rollback");
    }),
  );
  assert.equal(get("test", "rollback"), undefined);
});
test("updates retain original record rather than creating duplicates", () => {
  save("test", { id: "persistent", projectId: "p", value: 1 });
  save("test", { id: "persistent", projectId: "p", value: 2 });
  assert.equal(list("test", "p").length, 1);
  assert.deepEqual(get("test", "persistent"), {
    id: "persistent",
    projectId: "p",
    value: 2,
  });
});
test("record metadata and SQL project lookup stay consistent after an update", () => {
  save("test", { id: "moved", projectId: "old-project" });
  save("test", { id: "moved", projectId: "new-project" });
  assert.equal(list("test", "old-project").length, 0);
  assert.equal(list("test", "new-project").length, 1);
});
