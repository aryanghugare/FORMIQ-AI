import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const suffix = Date.now().toString();
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Enter workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
}
test("unauthenticated API access is rejected", async ({ request }) => {
  const r = await request.get("/api/workspace");
  expect(r.status()).toBe(401);
});
test("upload → CAD analysis → designer review → reports and persistence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text()))
      errors.push(message.text());
  });
  await signIn(page);
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByLabel("Project name").fill("E2E Meridian " + suffix);
  await projectDialog.getByLabel("Project code").fill("E2E-" + suffix);
  await projectDialog.getByLabel("Location").fill("Mumbai, India");
  await projectDialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [file, discipline, revision] of [
    ["ARCH-L12-Rev-05.dxf", "architecture", "Rev.05"],
    ["ARCH-L12-Rev-06.dxf", "architecture", "Rev.06"],
  ]) {
    await page
      .locator(".heading-actions")
      .getByRole("button", { name: "Upload drawings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Drawing file")
      .setInputFiles(resolve("public/samples", file));
    await dialog.getByLabel("Drawing discipline").selectOption(discipline);
    await dialog.getByLabel("Revision identifier").fill(revision);
    await dialog
      .getByRole("button", { name: "Upload drawing", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Analyze drawing set" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Drawing comparison" }),
  ).toBeVisible();
  await expect(
    page.getByText("5 checks · 4 findings · Tolerance 1 mm"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/review-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Overlay", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("140%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fit drawing", exact: true }).click();
  await page
    .getByRole("button", { name: "Issue register", exact: false })
    .click();
  await page
    .getByRole("button", {
      name: "Review Door D14 revised",
      exact: true,
    })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Review Door D14 revised",
  });
  await drawer.getByLabel("Finding status").selectOption("accepted");
  await expect(
    drawer.getByRole("button", { name: "Save decision" }),
  ).toBeDisabled();
  await expect(
    drawer.getByText("Add a designer note to save this decision.", {
      exact: false,
    }),
  ).toBeVisible();
  await drawer
    .getByLabel("Designer notes")
    .fill(
      "Confirmed 100 mm discrepancy against Rev.06. Update opening panels before release.",
    );
  await drawer.getByRole("button", { name: "Save decision" }).click();
  await expect(
    drawer.getByText("Add a designer note to save this decision.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByText("Designer decision saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  const workspace = await (await page.request.get("/api/workspace")).json();
  const project = workspace.projects.find(
    (p: { code: string }) => p.code === "E2E-" + suffix,
  );
  const run = workspace.runs.find(
    (r: { projectId: string }) => r.projectId === project.id,
  );
  const report = await page.request.get(
    `/api/reports?projectId=${project.id}&runId=${run.id}&format=html`,
  );
  expect(report.status()).toBe(200);
  expect(await report.text()).toContain("Confirmed 100 mm discrepancy");
  expect(await report.text()).toContain("<svg");
  const csv = await page.request.get(
    `/api/reports?projectId=${project.id}&runId=${run.id}&format=csv`,
  );
  expect(await csv.text()).toContain("1000");
  expect(await csv.text()).toContain("accepted");
  const crossSite = await page.request.post("/api/projects", {
    headers: { Origin: "https://untrusted.example" },
    data: { name: "Unauthorized", code: "x", location: "x" },
  });
  expect(crossSite.status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.screenshot({
    path: "test-results/issues-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("DWG upload is retained and reports conversion requirement honestly", async ({
  page,
}) => {
  await signIn(page);
  const workspace = await (await page.request.get("/api/workspace")).json();
  const response = await page.request.post("/api/drawings", {
    multipart: {
      projectId: workspace.projects[0].id,
      discipline: "architecture",
      revision: "DWG-test",
      file: {
        name: "converter-required.dwg",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(
          "AC1032\0Test fixture — converter pipeline placeholder",
        ),
      },
    },
  });
  expect(response.status()).toBe(201);
  const d = await response.json();
  expect(d.status).toBe("needs_conversion");
  expect(d.model).toBeUndefined();
  const original = await page.request.get(`/api/drawings/${d.id}/file`);
  expect((await original.body()).toString()).toContain("AC1032");
  const invalid = await page.request.post("/api/drawings", {
    multipart: {
      projectId: workspace.projects[0].id,
      discipline: "architecture",
      revision: "bad",
      file: {
        name: "bad.dwg",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("not a drawing"),
      },
    },
  });
  expect(invalid.status()).toBe(400);
});
test("Design Memory stores an approved source and supports search", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole("button", { name: "Design memory", exact: true })
    .click();
  await page.getByRole("button", { name: "Add approved reference" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Reference title").fill("Opening coordination " + suffix);
  await d.getByLabel("Source project").fill("KK-TEST");
  await d.getByLabel("Drawing reference").fill("FW-42 Rev.03");
  await d.getByLabel("RFI / NCR / standard").fill("RFI-017");
  await d
    .getByLabel("Condition", { exact: true })
    .fill("Door width increased by 100 mm during revision.");
  await d
    .getByLabel("Approved solution")
    .fill("Verify adjacent panels and amend the opening configuration.");
  await d
    .getByLabel("Controlled source link")
    .fill("https://example.com/approved/rfi-017");
  await d.getByLabel("Search tags").fill("Door, Opening");
  await d.getByRole("checkbox").check();
  await d.getByRole("button", { name: "Add approved reference" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("textbox", {
      name: "Search conditions, tags, projects, or RFIs…",
    })
    .fill(suffix);
  await expect(
    page.getByRole("heading", { name: "Opening coordination " + suffix }),
  ).toBeVisible();
});
test("users can create an account, sign out on a short screen, and log in to a private workspace", async ({
  page,
}) => {
  const email = `browser-${suffix}@example.com`,
    password = "A-browser-test-password";
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account." }),
  ).toBeVisible();
  await page.getByLabel("Full name").fill("Browser User");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  const workspace = await (await page.request.get("/api/workspace")).json();
  expect(workspace.user.email).toBe(email);
  expect(workspace.projects).toEqual([]);
  expect(workspace.drawings).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 600 });
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(signOut).toBeInViewport();
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Enter workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace overview" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/workspace")).json()).projects,
  ).toEqual([]);
});
