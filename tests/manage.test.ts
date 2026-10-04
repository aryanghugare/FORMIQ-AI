import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { db } from "../lib/db";
import { login, userForToken } from "../lib/auth";
const root = mkdtempSync(join(tmpdir(), "formiq-manage-"));
process.env.FORMIQ_DATA_DIR = join(root, "data");
process.env.FORMIQ_DEMO = "true";
delete process.env.FORMIQ_ADMIN_EMAIL;
delete process.env.FORMIQ_ADMIN_PASSWORD;
db();
after(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
function manage(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [resolve("scripts/manage.mjs"), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
test("operator account commands add individual logins, revoke sessions on reset, and protect the last account", async () => {
  const env = {
    FORMIQ_USER_EMAIL: "Member@Example.com",
    FORMIQ_USER_NAME: "Team Member",
    FORMIQ_USER_PASSWORD: "A-long-test-password",
  };
  assert.equal(manage(["add-user"], env).status, 0);
  assert.equal(manage(["add-user"], env).status, 1);
  const session = await login("member@example.com", env.FORMIQ_USER_PASSWORD);
  assert.ok(session);
  assert.ok(await userForToken(session.token));
  assert.equal(
    manage(["reset-password"], {
      ...env,
      FORMIQ_USER_PASSWORD: "A-new-test-password",
    }).status,
    0,
  );
  assert.equal(await userForToken(session.token), undefined);
  assert.equal(
    await login("member@example.com", env.FORMIQ_USER_PASSWORD),
    undefined,
  );
  assert.ok(await login("member@example.com", "A-new-test-password"));
  assert.equal(manage(["remove-user"], env).status, 0);
  assert.equal(
    await login("member@example.com", "A-new-test-password"),
    undefined,
  );
  assert.equal(
    manage(["remove-user"], { FORMIQ_USER_EMAIL: "designer@formiq.ai" }).status,
    1,
  );
});
test("online backup includes WAL transactions and originals, verifies recovery, and detects corruption", () => {
  db()
    .prepare(
      "INSERT INTO records (id,kind,projectId,data) VALUES ('backup-check','audit','',?)",
    )
    .run(JSON.stringify({ id: "backup-check" }));
  const target = join(root, "backup");
  const result = manage(["backup", target]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(manage(["verify-backup", target]).status, 0);
  assert.equal(manage(["backup", target]).status, 1);
  assert.equal(
    manage(["backup", join(process.env.FORMIQ_DATA_DIR!, "unsafe")]).status,
    1,
  );
  appendFileSync(join(target, "uploads", "demo-drawing-old.dxf"), "corruption");
  assert.equal(manage(["verify-backup", target]).status, 1);
  assert.ok(
    db().prepare("SELECT id FROM records WHERE id='backup-check'").get(),
  );
});
