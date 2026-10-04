import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "../app/api/[...path]/route";
import {
  closeMongo,
  mongoDatabase,
  uploadMongoFile,
  downloadMongoFile,
} from "../lib/mongo";
const uri = process.env.FORMIQ_MONGO_TEST_URI;
test(
  "MongoDB: accounts, GridFS >16 MB, CAD workflow, review conflicts and logout",
  {
    skip: uri
      ? false
      : "Set FORMIQ_MONGO_TEST_URI to a test replica set; this creates and drops only a unique formiq_test_* database.",
  },
  async () => {
    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DB = `formiq_test_${randomUUID().replaceAll("-", "")}`;
    process.env.FORMIQ_ADMIN_EMAIL = "owner@example.com";
    process.env.FORMIQ_ADMIN_PASSWORD = "Integration-test-password";
    process.env.FORMIQ_DEMO = "false";
    let cookie = "";
    let connected = false;
    const call = async (path: string, method = "GET", body?: unknown) => {
      const request = new NextRequest(`http://localhost/api/${path}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body && !(body instanceof FormData)
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body:
          body instanceof FormData
            ? body
            : body === undefined
              ? undefined
              : JSON.stringify(body),
      });
      return (method === "GET" ? GET : method === "PATCH" ? PATCH : POST)(
        request,
        { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
      );
    };
    try {
      const health = await call("health");
      assert.equal(
        health.status,
        200,
        "MongoDB health check must succeed before testing workflows.",
      );
      connected = true;
      assert.equal((await call("workspace")).status, 401);
      assert.equal(
        (
          await call("auth/login", "POST", {
            email: "owner@example.com",
            password: "incorrect",
          })
        ).status,
        401,
      );
      const login = await call("auth/login", "POST", {
        email: "owner@example.com",
        password: "Integration-test-password",
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];
      const empty = await (await call("workspace")).json();
      assert.deepEqual(empty.projects, []);
      assert.equal(empty.demoEnabled, false);
      const large = Buffer.alloc(17 * 1024 * 1024, 91);
      const fileId = await uploadMongoFile("large-test.dxf", large);
      assert.deepEqual(await downloadMongoFile(fileId), large);
      const projectResponse = await call("projects", "POST", {
        name: "Mongo test",
        code: "M-1",
        location: "Test",
        description: "",
      });
      assert.equal(projectResponse.status, 201);
      const project = await projectResponse.json();
      assert.equal(
        (
          await call("projects", "POST", {
            name: "Duplicate",
            code: "m-1",
            location: "Test",
          })
        ).status,
        409,
      );
      const ids: string[] = [];
      const samples = {
        old: "ARCH-L12-Rev-05.dxf",
        new: "ARCH-L12-Rev-06.dxf",
        formwork: "FW-L12.dxf",
      };
      for (const variant of ["old", "new", "formwork"] as const) {
        const form = new FormData(),
          content = readFileSync(
            join("public/samples", samples[variant]),
            "utf8",
          );
        form.set("projectId", project.id);
        form.set("revision", variant);
        form.set(
          "discipline",
          variant === "formwork" ? "formwork" : "architecture",
        );
        form.set("file", new File([content], samples[variant]));
        const response = await call("drawings", "POST", form);
        assert.equal(response.status, 201);
        const drawing = await response.json();
        ids.push(drawing.id);
        assert.equal(drawing.status, "ready");
        assert.equal(
          await (await call(`drawings/${drawing.id}/file`)).text(),
          content,
        );
        const stored = await (await mongoDatabase())
          .collection("records")
          .findOne({ "data.id": drawing.id });
        assert.ok(stored?.modelFileId);
        assert.equal(stored?.data.model, undefined);
      }
      const analysis = await call("analyze", "POST", {
        projectId: project.id,
        oldId: ids[0],
        newId: ids[1],
        formworkId: ids[2],
      });
      assert.equal(analysis.status, 201);
      const result = await analysis.json();
      assert.equal(result.run.checks, 8);
      assert.equal(result.issues.length, 7);
      const mismatch = result.issues.find(
        (issue: { tag: string; rule: string }) =>
          issue.tag === "D14" && issue.rule === "FW-01",
      );
      assert.equal(mismatch.current, 1000);
      assert.equal(mismatch.formwork, 900);
      assert.equal(
        (
          await call(`issues/${mismatch.id}`, "PATCH", {
            status: "accepted",
            notes: "",
            expectedVersion: 0,
          })
        ).status,
        400,
      );
      const patch = {
        status: "accepted",
        notes: "Checked against source.",
        expectedVersion: 0,
      };
      assert.equal(
        (await call(`issues/${mismatch.id}`, "PATCH", patch)).status,
        200,
      );
      assert.equal(
        (await call(`issues/${mismatch.id}`, "PATCH", patch)).status,
        409,
      );
      assert.equal(
        (await call(`reports?projectId=${project.id}&format=csv`)).status,
        200,
      );
      const html = await call(
        `reports?projectId=${project.id}&runId=${result.run.id}&format=html`,
      );
      assert.equal(html.status, 200);
      assert.match(await html.text(), /Checked against source\./);
      assert.equal(
        (
          await call(`projects/${project.id}`, "PATCH", {
            tolerance: 5,
            bomReleased: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call("memory", "POST", {
            title: "Verified opening detail",
            category: "Openings",
            project: "M-1",
            drawing: samples.formwork,
            reference: "RFI-017",
            description: "Opening changed from 900 mm to 1000 mm.",
            resolution: "Update formwork panels before fabrication release.",
            tags: ["Door"],
            sourceUrl: "https://example.com/rfi-017",
          })
        ).status,
        201,
      );
      // Reconnect so persistence is checked independently of the connection pool.
      await closeMongo();
      const persisted = await (await call("workspace")).json();
      assert.equal(persisted.projects[0].tolerance, 5);
      assert.equal(
        persisted.issues.find(
          (issue: { id: string }) => issue.id === mismatch.id,
        ).status,
        "accepted",
      );
      assert.equal(persisted.memory.length, 1);
      assert.ok(
        persisted.drawings.every(
          (drawing: { model?: unknown }) => drawing.model === undefined,
        ),
      );
      const signup = await call("auth/register", "POST", {
        name: "New user",
        email: "NEW@example.com",
        password: "Another-test-password",
      });
      assert.equal(signup.status, 201);
      assert.equal((await signup.json()).user.email, "new@example.com");
      cookie = signup.headers.get("set-cookie")!.split(";")[0];
      const privateWorkspace = await (await call("workspace")).json();
      for (const section of [
        "projects",
        "drawings",
        "issues",
        "runs",
        "memory",
        "audit",
      ])
        assert.deepEqual(privateWorkspace[section], []);
      assert.equal(
        (
          await call("auth/register", "POST", {
            name: "Duplicate",
            email: "new@example.com",
            password: "Another-test-password",
          })
        ).status,
        409,
      );
      assert.equal((await call(`drawings/${ids[0]}/file`)).status, 404);
      assert.equal(
        (
          await call(`projects/${project.id}`, "PATCH", {
            tolerance: 10,
            bomReleased: false,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call(`issues/${mismatch.id}`, "PATCH", {
            status: "rejected",
            notes: "Cannot edit another user's finding",
            expectedVersion: 1,
          })
        ).status,
        404,
      );
      assert.equal(
        (await call(`reports?projectId=${project.id}&format=csv`)).status,
        404,
      );
      assert.equal(
        (
          await call("projects", "POST", {
            name: "Independent project",
            code: "M-1",
            location: "Test",
          })
        ).status,
        201,
      );
      assert.equal((await call("auth/logout", "POST", {})).status, 200);
      assert.equal((await call("workspace")).status, 401);
    } finally {
      if (connected) await (await mongoDatabase()).dropDatabase();
      await closeMongo();
    }
  },
);
