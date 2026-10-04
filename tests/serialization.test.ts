import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { login, userForToken } from "../lib/auth";
import { db } from "../lib/db";
import { loadWorkspace } from "../lib/workspace";

const directory = mkdtempSync(join(tmpdir(), "formiq-serialization-"));
process.env.FORMIQ_DATA_DIR = directory;
process.env.FORMIQ_DEMO = "true";
process.env.FORMIQ_ADMIN_EMAIL = "";
process.env.FORMIQ_ADMIN_PASSWORD = "";
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

function assertPlainData(value: unknown, path = "initialData") {
  if (value === null || typeof value !== "object") return;
  assert.equal(
    Object.getPrototypeOf(value),
    Array.isArray(value) ? Array.prototype : Object.prototype,
    `${path} must be plain data at the Server-to-Client Component boundary`,
  );
  for (const [key, child] of Object.entries(value))
    assertPlainData(child, `${path}.${key}`);
}

test("authenticated workspace props contain no raw SQLite rows", async () => {
  const session = await login("designer@formiq.ai", "Formiq@2026");
  assert.ok(session);
  const user = await userForToken(session.token);
  assert.ok(user);
  // Check before JSON serialization, which hides null-prototype SQLite rows
  // and allowed the API tests to pass despite the page failing to render.
  const workspace = await loadWorkspace(user);
  assertPlainData(workspace);
  assert.deepEqual(workspace.user, session.user);
  assert.deepEqual(Object.keys(workspace.user).sort(), ["email", "id", "name"]);
  assert.equal(await userForToken("invalid-session"), undefined);
  assert.equal(await userForToken(), undefined);
});
