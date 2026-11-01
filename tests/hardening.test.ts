import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "formiq-hardening-"));
process.env.FORMIQ_DATA_DIR = dir;
process.env.FORMIQ_DEMO = "true";
delete process.env.MONGODB_URI;
delete process.env.FORMIQ_ADMIN_EMAIL;
delete process.env.FORMIQ_ADMIN_PASSWORD;
import { db, publicDemoCredentials } from "../lib/db";
import { login, register, reserveRegistration } from "../lib/auth";
import { clientIp } from "../lib/client-ip";
import { analyzeInWorker, parseInWorker } from "../lib/cad-tasks";
import { HttpError } from "../lib/errors";
import { demoDxf } from "../lib/demo";
import { parseDxf } from "../lib/cad";
import { runMutationTrials } from "../lib/accuracy-mutation";
import type { Drawing, Project } from "../lib/types";
after(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
const headers = (values: Record<string, string>) => new Headers(values);
const withEnv = (env: Record<string, string | undefined>, work: () => void) => {
  const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    work();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("client address comes only from the declared source and cannot be chosen by the client", () => {
  const spoofed = { "x-forwarded-for": "6.6.6.6, 203.0.113.9", "true-client-ip": "198.51.100.7" };
  withEnv({ FORMIQ_CLIENT_IP_HEADER: undefined, FORMIQ_TRUSTED_PROXY_HOPS: undefined }, () =>
    assert.equal(clientIp(headers(spoofed)), undefined),
  );
  withEnv({ FORMIQ_CLIENT_IP_HEADER: undefined, FORMIQ_TRUSTED_PROXY_HOPS: "1" }, () => {
    assert.equal(clientIp(headers(spoofed)), "203.0.113.9");
    assert.equal(clientIp(headers({ "x-forwarded-for": "not-an-address" })), undefined);
    assert.equal(clientIp(headers({})), undefined);
  });
  withEnv({ FORMIQ_CLIENT_IP_HEADER: undefined, FORMIQ_TRUSTED_PROXY_HOPS: "2" }, () =>
    assert.equal(clientIp(headers(spoofed)), "6.6.6.6"),
  );
  withEnv({ FORMIQ_CLIENT_IP_HEADER: "true-client-ip", FORMIQ_TRUSTED_PROXY_HOPS: "1" }, () =>
    assert.equal(clientIp(headers(spoofed)), "198.51.100.7"),
  );
});

test("bad logins from one address do not lock the account for another address", async () => {
  const { user } = await register("Victim", "victim@example.com", "A-correct-password");
  assert.ok(user.id);
  const attempt = (password: string, ip?: string) => login("victim@example.com", password, ip);
  for (let i = 0; i < 10; i++) assert.equal(await attempt("wrong", "203.0.113.1"), undefined);
  await assert.rejects(attempt("wrong", "203.0.113.1"), /Too many/);
  // The attacker's address is blocked even with the right password; everyone else is not.
  await assert.rejects(attempt("A-correct-password", "203.0.113.1"), /Too many/);
  assert.ok(await attempt("A-correct-password", "203.0.113.2"));
});

test("a blocked address stops counting against the account, and many addresses hit the account limit", async () => {
  await register("Target", "target@example.com", "A-correct-password");
  for (let i = 0; i < 50; i++) await login("target@example.com", "wrong", "203.0.113.50").catch(() => {});
  assert.ok(await login("target@example.com", "A-correct-password", "203.0.113.51"));
  for (let a = 0; a < 10; a++)
    for (let i = 0; i < 10; i++) await login("target@example.com", "wrong", `198.51.100.${a}`);
  await assert.rejects(login("target@example.com", "wrong", "198.51.100.200"), /Too many/);
});

test("without a known address the strict per-account limit still applies", async () => {
  for (let i = 0; i < 10; i++) assert.equal(await login("noip@example.com", "wrong"), undefined);
  await assert.rejects(login("noip@example.com", "wrong"), /Too many/);
});

test("sign-ups are limited per address", async () => {
  for (let i = 0; i < 10; i++) await reserveRegistration("203.0.113.77");
  await assert.rejects(
    reserveRegistration("203.0.113.77"),
    (e: HttpError) => e.status === 429,
  );
  await reserveRegistration("203.0.113.78");
});

test("CAD work runs off the database transaction, returns results and keeps HTTP errors", async () => {
  const content = demoDxf("old");
  const model = await parseInWorker(content);
  assert.deepEqual(model.bounds, parseDxf(content).bounds);
  const project: Project = { id: "p", name: "", code: "", location: "", description: "", tolerance: 1, bomReleased: false, createdAt: "" };
  const drawing = (id: string, unitScale: number | null): Drawing => ({
    id, projectId: "p", name: id, revision: id, discipline: "architecture", format: "DXF", size: 0,
    uploadedAt: "", uploadedBy: "", status: "ready", model: { ...model, unitScale },
  });
  const result = await analyzeInWorker(project, drawing("a", 1), drawing("b", 1), "Test");
  assert.equal(result.issues.filter((i) => i.category !== "quality").length, 0);
  await assert.rejects(
    analyzeInWorker(project, drawing("a", null), drawing("b", 1), "Test"),
    (e: HttpError) => e instanceof HttpError && e.status === 400,
  );
  await assert.rejects(parseInWorker("not a drawing"), /Invalid DXF/);
});

test("injected edits on a drawing are found at their location with no extra findings", () => {
  const results = runMutationTrials(parseDxf(demoDxf("new")), { trials: 8, seed: 3 });
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.equal(r.detected, r.trials, r.kind);
    assert.equal(r.extraFindings, 0, r.kind);
  }
});

test("the built-in demo login is shown and accepted only outside production", async () => {
  withEnv({ NODE_ENV: "development", FORMIQ_DEMO_PASSWORD: undefined }, () =>
    assert.equal(publicDemoCredentials()?.email, "designer@formiq.ai"),
  );
  withEnv({ NODE_ENV: "development", FORMIQ_DEMO_PASSWORD: "A-chosen-password" }, () =>
    assert.equal(publicDemoCredentials(), undefined),
  );
  withEnv({ NODE_ENV: "production", FORMIQ_DEMO_PASSWORD: undefined }, () =>
    assert.equal(publicDemoCredentials(), undefined),
  );
  const run = (data: string, env: Record<string, string>, code: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "-e", code], {
      env: { ...process.env, FORMIQ_DATA_DIR: data, ...env },
      encoding: "utf8",
    }).trim();
  const attempt = (password: string) =>
    `const a=require('./lib/auth.ts');a.login('designer@formiq.ai','${password}').then(s=>console.log(s?'accepted':'refused'))`;
  const dev = { NODE_ENV: "development", FORMIQ_DEMO: "true" };
  const prod = { NODE_ENV: "production", FORMIQ_DEMO: "true" };

  const data = mkdtempSync(join(tmpdir(), "formiq-demo-"));
  try {
    assert.equal(run(data, dev, attempt("Formiq@2026")), "accepted");
    // Existing production data: the published password stops working as soon as the app opens it.
    assert.equal(run(data, { ...prod, FORMIQ_DEMO_PASSWORD: "A-chosen-demo-password" }, attempt("Formiq@2026")), "refused");
    assert.equal(run(data, { ...prod, FORMIQ_DEMO_PASSWORD: "A-chosen-demo-password" }, attempt("A-chosen-demo-password")), "accepted");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  const fresh = mkdtempSync(join(tmpdir(), "formiq-demo-"));
  try {
    // A new production demo without a password refuses to start instead of using the published one.
    assert.throws(() => run(fresh, prod, attempt("Formiq@2026")), /FORMIQ_DEMO_PASSWORD/);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("display time zone is configurable, and an invalid value falls back to the default", () => {
  const render = (zone: string) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", "const f=require('./lib/format.ts');console.log(f.formatTimestamp('2026-10-04T20:30:00Z'))"],
      { env: { ...process.env, FORMIQ_TIME_ZONE: zone }, encoding: "utf8" },
    ).trim();
  assert.match(render("America/New_York"), /4 Oct 2026, 16:30/);
  assert.match(render("Not/AZone"), /5 Oct 2026, 02:00/);
  assert.match(render(""), /5 Oct 2026, 02:00/);
});

test("password rules match in the app and the operator scripts", () => {
  for (const script of ["scripts/manage.mjs", "scripts/manage-mongo.mjs"])
    assert.match(readFileSync(script, "utf8"), /password\.length < 12/);
});
