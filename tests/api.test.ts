import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { demoDxf } from "../lib/demo";
import { RULES } from "../lib/analysis";
import { POST, GET, PATCH, DELETE } from "../app/api/[...path]/route";
import { db, list } from "../lib/db";
import type {
  Drawing,
  Project,
  Issue,
  AnalysisRun,
  AuditEvent,
} from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "formiq-api-"));
process.env.FORMIQ_DATA_DIR = dir;
process.env.FORMIQ_DEMO = "true";
process.env.FORMIQ_SECURE_COOKIES = "false";
delete process.env.ODA_CONVERTER_PATH;
delete process.env.DWG_CONVERTER_PATH;
process.env.LIBREDWG_CONVERTER_PATH = join(dir, "missing-converter");
after(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
let cookie = "";
async function call(
  path: string,
  method = "GET",
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const options: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  };
  if (payload instanceof FormData) options.body = payload;
  else if (payload !== undefined) {
    options.body = JSON.stringify(payload);
    options.headers = {
      ...options.headers,
      "Content-Type": "application/json",
    };
  }
  const request = new NextRequest("http://localhost:3000/api/" + path, options);
  return (
    method === "GET"
      ? GET
      : method === "PATCH"
        ? PATCH
        : method === "DELETE"
          ? DELETE
          : POST
  )(request, {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  });
}
function upload(
  projectId: string,
  content: string,
  name: string,
  discipline = "architecture",
  revision = "Rev.01",
) {
  const form = new FormData();
  form.set("projectId", projectId);
  form.set("discipline", discipline);
  form.set("revision", revision);
  form.set("file", new File([content], name));
  return call("drawings", "POST", form);
}
test("full authenticated API workflow persists CAD analysis and designer review", async () => {
  assert.equal((await call("workspace")).status, 401);
  assert.equal(
    (
      await call("auth/login", "POST", {
        email: "designer@formiq.ai",
        password: "wrong",
      })
    ).status,
    401,
  );
  const signedIn = await call("auth/login", "POST", {
    email: "designer@formiq.ai",
    password: "Formiq@2026",
  });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get("set-cookie") ?? "", /HttpOnly/i);
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await call("projects", "POST", {
    name: "API test project",
    code: "API-01",
    location: "Mumbai",
    description: "Integration test",
  });
  assert.equal(created.status, 201);
  const project: Project = await created.json();
  const drawings: Drawing[] = [];
  const samples = {
    old: "ARCH-L12-Rev-05.dxf",
    new: "ARCH-L12-Rev-06.dxf",
  };
  for (const r of ["old", "new"] as const) {
    const response = await upload(
      project.id,
      readFileSync(join("public/samples", samples[r]), "utf8"),
      samples[r],
      "architecture",
      r,
    );
    assert.equal(response.status, 201);
    const d: Drawing = await response.json();
    assert.equal(d.status, "ready");
    drawings.push(d);
  }
  const input = {
    projectId: project.id,
    oldId: drawings[0].id,
    newId: drawings[1].id,
  };
  // An upload parsed by an older version may have geometry but no dimensions.
  // Analysis must re-extract its retained original without requiring re-upload.
  const { save: saveLegacy } = await import("../lib/db");
  saveLegacy("drawing", {
    ...drawings[0],
    model: { ...drawings[0].model!, parserVersion: "legacy", measurements: [] },
  });
  const response = await call("analyze", "POST", input);
  assert.equal(response.status, 201);
  const result: { run: AnalysisRun; issues: Issue[] } = await response.json();
  assert.equal(result.issues.filter((i: Issue) => i.category === "dimension").length, 4);
  const issue = result.issues.find(
    (i) => i.tag === "D14" && i.rule === "REV-01",
  )!;
  assert.equal(issue.current, 1000);
  assert.equal(issue.previous, 900);
  assert.equal(result.run.checks, RULES.length);
  const runModels = await call(`runs/${result.run.id}/models`);
  assert.equal(runModels.status, 200);
  const savedModels = await runModels.json();
  assert.equal(savedModels.legacy, false);
  assert.equal(savedModels.previous.model.measurements.find((m: { tag: string }) => m.tag === "D14").value, 900);
  assert.ok(result.run.sources?.every((source) => source.model === "snapshot"));
  // A future extraction update must not change the exact model used by a prior run.
  const originalDrawing = drawings[1];
  saveLegacy("drawing", { ...originalDrawing, model: { ...originalDrawing.model!, measurements: [] } });
  const retainedModels = await (await call(`runs/${result.run.id}/models`)).json();
  assert.deepEqual(retainedModels.latest.model, savedModels.latest.model);
  saveLegacy("drawing", originalDrawing);

  const structureResponse = await upload(
    project.id,
    readFileSync(join("public/samples", samples.new), "utf8"),
    "structure-reference.dxf",
    "structure",
  );
  assert.equal(structureResponse.status, 201);
  const structure: Drawing = await structureResponse.json();
  const structureOld: Drawing = await (
    await upload(
      project.id,
      readFileSync(join("public/samples", samples.old), "utf8"),
      "structure-previous.dxf",
      "structure",
      "Rev.01",
    )
  ).json();
  const structureComparison = await call("analyze", "POST", {
    projectId: project.id,
    oldId: structureOld.id,
    newId: structure.id,
  });
  assert.equal(structureComparison.status, 201);
  const structureResult = await structureComparison.json();
  assert.equal(structureResult.issues.filter((i: Issue) => i.category === "dimension").length, 4);
  assert.equal(structureResult.run.checks, RULES.length);
  assert.ok(
    structureResult.issues.every(
      (finding: Issue) => finding.drawingIds.length === 2,
    ),
  );
  assert.equal(
    (
      await upload(
        project.id,
        readFileSync(join("public/samples", samples.old), "utf8"),
        "unsupported.dxf",
        "formwork",
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("analyze", "POST", { ...input, newId: structure.id })).status,
    400,
  );
  assert.equal(
    (
      await call(`issues/${issue.id}`, "PATCH", {
        status: "accepted",
        notes: "",
      })
    ).status,
    400,
  );
  const reviewed = await call(`issues/${issue.id}`, "PATCH", {
    status: "accepted",
    notes: "Verified Rev.06; 100 mm mismatch. Update before release.",
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).reviewedBy, "Design Lead");
  const staleReview = await call(`issues/${issue.id}`, "PATCH", {
    status: "rejected",
    notes: "Stale tab decision.",
    expectedVersion: 0,
  });
  assert.equal(staleReview.status, 409);
  const workspace = await (await call("workspace")).json();
  assert.ok(workspace.drawings.every((d: Drawing) => d.model === undefined));
  const summary = workspace.drawings.find(
    (d: Drawing) => d.id === drawings[1].id,
  );
  assert.equal(summary.extraction.measurementCount, 6);
  const detail = await (await call(`drawings/${drawings[1].id}`)).json();
  assert.equal(
    detail.model.measurements.find((m: { tag: string }) => m.tag === "D14")
      .value,
    1000,
  );

  assert.equal(
    workspace.issues.find((i: Issue) => i.id === issue.id).status,
    "accepted",
  );
  // Route params supplied explicitly to mirror Next routing behavior.
  async function report(format: string) {
    const request = new NextRequest(
      `http://localhost:3000/api/reports?projectId=${project.id}&runId=${result.run.id}&format=${format}`,
      { headers: { Cookie: cookie } },
    );
    return GET(request, { params: Promise.resolve({ path: ["reports"] }) });
  }
  const reportResponse = await report("html");
  assert.equal(reportResponse.status, 200);
  const text = await reportResponse.text();
  assert.ok(text.includes("<svg"));
  assert.ok(text.includes("Verified Rev.06"));
  assert.ok(text.includes("1000"));
  const csv = await report("csv");
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes("accepted"));
  assert.equal(
    (await call("analyze", "POST", { ...input, newId: input.oldId })).status,
    400,
  );
  assert.equal(
    (await call("analyze", "POST", { ...input, projectId: "demo-project" }))
      .status,
    400,
  );
  const original = await call(`drawings/${drawings[0].id}/file`);
  assert.equal(original.status, 200);
  assert.equal(
    await original.text(),
    readFileSync(join("public/samples", samples.old), "utf8"),
  );
  const malformed = await upload(project.id, "not a DXF", "bad.dxf");
  assert.equal(malformed.status, 201);
  assert.equal((await malformed.json()).status, "failed");
  const dwg = await upload(
    project.id,
    "AC1032\0Test placeholder",
    "example.dwg",
  );
  assert.equal(dwg.status, 201);
  const saved: Drawing = await dwg.json();
  assert.equal(saved.status, "needs_conversion");
  assert.equal(saved.model, undefined);
  assert.equal(
    (await call(`drawings/${saved.id}/retry`, "POST", {})).status,
    503,
  );
  assert.equal(
    (await upload(project.id, "not a DWG", "invalid.dwg")).status,
    400,
  );
  assert.equal(
    (await upload(project.id, "not allowed", "notes.txt")).status,
    400,
  );
  assert.equal(
    (
      await call(
        "projects",
        "POST",
        { name: "Bad", code: "Bad", location: "Bad" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`projects/${project.id}`, "PATCH", {
        tolerance: 5,
        bomReleased: true,
      })
    ).status,
    200,
  );
  const rerun = await call("analyze", "POST", input);
  assert.equal(rerun.status, 201);
  const second = await rerun.json();
  assert.notEqual(second.run.id, result.run.id);
  assert.equal(
    list<Issue>("issue", project.id)
      .filter((i) => i.runId === result.run.id)
      .find((i) => i.id === issue.id)?.status,
    "accepted",
  );
  assert.ok(
    second.issues.every((i: Issue) =>
      i.impact.includes("Released BOM / fabrication items"),
    ),
  );
  const reference = await call("memory", "POST", {
    title: "Approved opening detail",
    category: "Openings",
    project: "KK-01",
    drawing: "FW-42",
    reference: "RFI-017",
    description: "Door changed by 100 mm during review.",
    resolution: "Revise adjacent panel arrangement before fabrication release.",
    tags: ["Door"],
    sourceUrl: "https://example.com/approved/rfi-017",
  });
  assert.equal(reference.status, 201);
  assert.equal((await reference.json()).approvedBy, "Design Lead");
  assert.ok(
    list<AuditEvent>("audit", project.id).some(
      (a) => a.action === "Issue reviewed",
    ),
  );
  assert.equal((await call("auth/logout", "POST", {})).status, 200);
  assert.equal((await call("workspace")).status, 401);
  cookie = "";
});
test("configured DWG adapter processes conversion output through the same CAD checks", async () => {
  const loginResponse = await call("auth/login", "POST", {
    email: "designer@formiq.ai",
    password: "Formiq@2026",
  });
  cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0];
  const wrapper = join(dir, "test-converter.cjs");
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[3],${JSON.stringify(demoDxf("new"))});\n`,
  );
  chmodSync(wrapper, 0o700);
  process.env.DWG_CONVERTER_PATH = wrapper;
  const response = await upload(
    "demo-project",
    "AC1032\0Adapter test fixture",
    "converted.dwg",
  );
  assert.equal(response.status, 201);
  const drawing: Drawing = await response.json();
  assert.equal(drawing.status, "ready");
  assert.equal(
    drawing.model?.measurements.find((m) => m.tag === "D14")?.value,
    1000,
  );
  assert.equal(
    (await call(`drawings/${drawing.id}/retry`, "POST", {})).status,
    409,
  );
  const failed = await upload(
    "demo-project",
    "AC1032\0Adapter fixture",
    "retry.dwg",
  );
  const failedDrawing: Drawing = await failed.json();
  // Create a retained drawing in the needs-conversion state, then retry with a failing executable.
  const { save } = await import("../lib/db");
  save("drawing", {
    ...failedDrawing,
    model: undefined,
    status: "needs_conversion",
  });
  writeFileSync(wrapper, `#!${process.execPath}\nprocess.exit(1);\n`);
  const retry = await call(`drawings/${failedDrawing.id}/retry`, "POST", {});
  assert.equal(retry.status, 502);
  const afterRetry = await (await call(`drawings/${failedDrawing.id}`)).json();
  assert.equal(afterRetry.status, "failed");
  assert.ok(afterRetry.error.includes("conversion failed"));
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nsetTimeout(() => require('node:fs').writeFileSync(process.argv[3],${JSON.stringify(demoDxf("new"))}),100);\n`,
  );
  const parallelRetries = await Promise.all([
    call(`drawings/${failedDrawing.id}/retry`, "POST", {}),
    call(`drawings/${failedDrawing.id}/retry`, "POST", {}),
  ]);
  assert.deepEqual(parallelRetries.map((r) => r.status).sort(), [200, 409]);
  const processed = await (await call(`drawings/${failedDrawing.id}`)).json();
  assert.equal(processed.status, "ready");
  assert.equal(processed.error, undefined);
  assert.equal(
    processed.model.measurements.find((m: { tag: string }) => m.tag === "D14")
      .value,
    1000,
  );
  delete process.env.DWG_CONVERTER_PATH;
});
test("parallel invalid login attempts cannot bypass the rate limit", async () => {
  const responses = await Promise.all(
    Array.from({ length: 13 }, () =>
      call("auth/login", "POST", {
        email: "parallel@example.com",
        password: "incorrect",
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 401).length, 10);
  assert.equal(responses.filter((r) => r.status === 429).length, 3);
  db()
    .prepare("UPDATE login_attempts SET expires=0 WHERE key=?")
    .run("parallel@example.com");
  assert.equal(
    (
      await call("auth/login", "POST", {
        email: "parallel@example.com",
        password: "incorrect",
      })
    ).status,
    401,
  );
});
test("login normalizes email and invalid report requests do not create success audit events", async () => {
  const response = await call("auth/login", "POST", {
    email: " DESIGNER@FORMIQ.AI ",
    password: "Formiq@2026",
  });
  assert.equal(response.status, 200);
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  const before = list<AuditEvent>("audit", "demo-project").filter(
    (a) => a.action === "Report generated",
  ).length;
  const req = new NextRequest(
    "http://localhost:3000/api/reports?projectId=demo-project&format=bad",
    { headers: { Cookie: cookie } },
  );
  assert.equal(
    (await GET(req, { params: Promise.resolve({ path: ["reports"] }) })).status,
    400,
  );
  assert.equal(
    list<AuditEvent>("audit", "demo-project").filter(
      (a) => a.action === "Report generated",
    ).length,
    before,
  );
});
test("public sign-up, login and logout keep projects, CAD files and reviews private to each account", async () => {
  cookie = "";
  const password = "A-public-signup-password";
  assert.equal(
    (
      await call("auth/register", "POST", {
        name: "User",
        email: "not-email",
        password,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("auth/register", "POST", {
        name: "User",
        email: "short@example.com",
        password: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("auth/register", "POST", {
        name: "",
        email: "empty@example.com",
        password,
      })
    ).status,
    400,
  );
  const signup = await call("auth/register", "POST", {
    name: "Alice",
    email: " ALICE@EXAMPLE.COM ",
    password,
  });
  assert.equal(signup.status, 201);
  assert.equal((await signup.json()).user.email, "alice@example.com");
  assert.match(signup.headers.get("set-cookie")!, /HttpOnly/);
  const aliceCookie = signup.headers.get("set-cookie")!.split(";")[0];
  cookie = aliceCookie;
  assert.deepEqual((await (await call("workspace")).json()).projects, []);
  assert.equal(
    (
      await call("auth/register", "POST", {
        name: "Duplicate",
        email: "alice@example.com",
        password,
      })
    ).status,
    409,
  );
  const created = await call("projects", "POST", {
    name: "Private project",
    code: "PRIVATE-01",
    location: "Mumbai",
  });
  assert.equal(created.status, 201);
  const project: Project = await created.json();
  const drawings: Drawing[] = [];
  for (const [name, discipline] of [
    ["ARCH-L12-Rev-05.dxf", "architecture"],
    ["ARCH-L12-Rev-06.dxf", "architecture"],
  ]) {
    const response = await upload(
      project.id,
      readFileSync(join("public/samples", name), "utf8"),
      name,
      discipline,
      name,
    );
    assert.equal(response.status, 201);
    drawings.push(await response.json());
  }
  const analysis = await call("analyze", "POST", {
    projectId: project.id,
    oldId: drawings[0].id,
    newId: drawings[1].id,
  });
  assert.equal(analysis.status, 201);
  const result = await analysis.json();
  assert.equal(result.issues.filter((i: Issue) => i.category === "dimension").length, 4);
  const memory = await call("memory", "POST", {
    title: "Alice's private reference",
    category: "Openings",
    project: "PRIVATE-01",
    drawing: "FW-L12",
    reference: "RFI-1",
    description: "The opening increased by 100 mm.",
    resolution: "Update formwork before release.",
    tags: ["Door"],
    sourceUrl: "https://example.com/reference",
  });
  assert.equal(memory.status, 201);
  const bob = await call("auth/register", "POST", {
    name: "Bob",
    email: "bob@example.com",
    password,
  });
  assert.equal(bob.status, 201);
  cookie = bob.headers.get("set-cookie")!.split(";")[0];
  const bobWorkspace = await (await call("workspace")).json();
  for (const section of [
    "projects",
    "drawings",
    "issues",
    "runs",
    "memory",
    "audit",
  ])
    assert.deepEqual(
      bobWorkspace[section],
      [],
      `Bob must not see Alice's ${section}`,
    );
  const [aliceParallel, bobParallel] = await Promise.all([
    call("workspace", "GET", undefined, { Cookie: aliceCookie }),
    call("workspace"),
  ]);
  assert.equal((await aliceParallel.json()).projects[0].id, project.id);
  assert.deepEqual((await bobParallel.json()).projects, []);
  assert.equal(
    (
      await call(`projects/${project.id}`, "PATCH", {
        tolerance: 5,
        bomReleased: true,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await upload(
        project.id,
        readFileSync(join("public/samples", "ARCH-L12-Rev-05.dxf"), "utf8"),
        "forbidden.dxf",
        "architecture",
      )
    ).status,
    404,
  );
  assert.equal((await call(`drawings/${drawings[0].id}`)).status, 404);
  assert.equal((await call(`drawings/${drawings[0].id}/file`)).status, 404);
  assert.equal(
    (await call(`drawings/${drawings[0].id}`, "DELETE")).status,
    404,
  );
  assert.equal(
    (
      await call(`drawings/${drawings[0].id}`, "PATCH", {
        name: "stolen.dxf",
        revision: "Rev.10",
        discipline: "structure",
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(`drawings/${drawings[0].id}/retry`, "POST", {})).status,
    404,
  );
  assert.equal(
    (
      await call(`issues/${result.issues[0].id}`, "PATCH", {
        status: "accepted",
        notes: "Unauthorized change",
        expectedVersion: 0,
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(`reports?projectId=${project.id}&format=html`)).status,
    404,
  );
  assert.equal(
    (
      await call("analyze", "POST", {
        projectId: project.id,
        oldId: drawings[0].id,
        newId: drawings[1].id,
      })
    ).status,
    404,
  );
  // Project identifiers can be reused by different accounts.
  assert.equal(
    (
      await call("projects", "POST", {
        name: "Bob's project",
        code: "PRIVATE-01",
        location: "Delhi",
      })
    ).status,
    201,
  );
  assert.equal((await call("auth/logout", "POST", {})).status, 200);
  assert.equal((await call("workspace")).status, 401);
  const signIn = await call("auth/login", "POST", {
    email: "alice@example.com",
    password,
  });
  assert.equal(signIn.status, 200);
  cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const alice = await (await call("workspace")).json();
  assert.deepEqual(
    alice.projects.map((p: Project) => p.id),
    [project.id],
  );
  assert.equal(alice.drawings.length, 2);
  assert.equal(alice.memory.length, 1);
  assert.equal(alice.issues.length, result.issues.length);
  assert.equal(
    (await call(`reports?projectId=${project.id}&format=csv`)).status,
    200,
  );
});
test("drawing metadata edits retain geometry; deletion removes originals and protects analysis sources", async () => {
  const workspace = await (await call("workspace")).json();
  const project = workspace.projects[0];
  const source = readFileSync(
    join("public/samples", "ARCH-L12-Rev-05.dxf"),
    "utf8",
  );
  const uploaded: Drawing = await (
    await upload(project.id, source, "editable.dxf")
  ).json();
  assert.equal(
    (
      await call(`drawings/${uploaded.id}`, "PATCH", {
        name: "renamed.dxf",
        revision: "Rev.07",
        discipline: "structure",
      })
    ).status,
    200,
  );
  const updated: Drawing = await (await call(`drawings/${uploaded.id}`)).json();
  assert.equal(updated.name, "renamed.dxf");
  assert.equal(updated.revision, "Rev.07");
  assert.equal(updated.discipline, "structure");
  assert.deepEqual(updated.model, uploaded.model);
  assert.equal(
    await (await call(`drawings/${uploaded.id}/file`)).text(),
    source,
  );
  for (const name of ["wrong.dwg", "../unsafe.dxf"]) {
    assert.equal(
      (
        await call(`drawings/${uploaded.id}`, "PATCH", {
          name,
          revision: "Rev.07",
          discipline: "structure",
        })
      ).status,
      400,
    );
  }
  const protectedSource: Drawing = workspace.drawings[0];
  assert.equal(
    (await call(`drawings/${protectedSource.id}`, "DELETE")).status,
    409,
  );
  assert.equal(
    (
      await call(`drawings/${protectedSource.id}`, "PATCH", {
        name: protectedSource.name,
        revision: "Rev.99",
        discipline: protectedSource.discipline,
      })
    ).status,
    409,
  );
  assert.equal((await call(`drawings/${uploaded.id}`, "DELETE")).status, 200);
  assert.equal((await call(`drawings/${uploaded.id}`)).status, 404);
  assert.equal((await call(`drawings/${uploaded.id}/file`)).status, 404);
  assert.equal(existsSync(join(dir, "uploads", `${uploaded.id}.dxf`)), false);
  const refreshed = await (await call("workspace")).json();
  assert.ok(
    refreshed.audit.some(
      (event: AuditEvent) => event.action === "Drawing deleted",
    ),
  );
});
