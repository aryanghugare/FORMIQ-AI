import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { audit, dataDir, get, list, save, transaction } from "@/lib/db";
import {
  userForToken,
  login,
  logout,
  SESSION_COOKIE,
  secureCookie,
} from "@/lib/auth";
import { convertDwg, converterAvailable } from "@/lib/converter";
import { HttpError } from "@/lib/errors";
import { readJson, readMultipart } from "@/lib/request-body";
import { parseDxf } from "@/lib/cad";
import { loadWorkspace } from "@/lib/workspace";
import { analyze, RULES } from "@/lib/analysis";
import { issueCsv, reportHtml } from "@/lib/reports";
import type {
  AnalysisRun,
  Drawing,
  Issue,
  MemoryCase,
  Project,
} from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const text = z.string().trim().min(1).max(160);
const projectInput = z.object({
  name: text,
  code: text,
  location: text,
  description: z.string().max(2000).default(""),
});
const reviewInput = z.object({
  status: z.enum(["open", "accepted", "rejected", "investigating"]),
  notes: z.string().trim().max(4000).default(""),
  expectedVersion: z.number().int().nonnegative().default(0),
});
const activeRetries = new Set<string>();
const projectFor = (id: string) => {
  const p = get<Project>("project", id);
  if (!p) throw new HttpError("Project not found.", 404);
  return p;
};
const drawingFor = (id: string) => {
  const d = get<Drawing>("drawing", id);
  if (!d) throw new HttpError("Drawing not found.", 404);
  return d;
};
async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const route = path.join("/"),
      method = request.method;
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== request.nextUrl.origin)
        throw new HttpError(
          "Cross-origin write requests are not allowed.",
          403,
        );
      if (request.headers.get("sec-fetch-site") === "cross-site")
        throw new HttpError("Cross-site request rejected.", 403);
    }
    if (route === "auth/login" && method === "POST") {
      const input = z
        .object({
          email: z.string().trim().email().max(160),
          password: z.string().min(1).max(200),
        })
        .parse(await readJson(request));
      const result = await login(input.email, input.password);
      if (!result) throw new HttpError("Email or password is incorrect.", 401);
      const response = NextResponse.json({ user: result.user });
      response.cookies.set(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie(),
        path: "/",
        maxAge: 604800,
      });
      return response;
    }
    if (route === "auth/logout" && method === "POST") {
      logout(request.cookies.get(SESSION_COOKIE)?.value);
      const response = NextResponse.json({ ok: true });
      response.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
      return response;
    }
    const user = userForToken(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) throw new HttpError("Please sign in to continue.", 401);
    if (route === "workspace" && method === "GET") {
      const data = loadWorkspace(user);
      return NextResponse.json(data, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (route === "rules" && method === "GET") return NextResponse.json(RULES);
    if (route === "projects" && method === "POST") {
      const input = projectInput.parse(await readJson(request));
      if (
        list<Project>("project").some(
          (p) => p.code.toLowerCase() === input.code.toLowerCase(),
        )
      )
        throw new HttpError("A project with this code already exists.", 409);
      const project: Project = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        tolerance: 1,
        bomReleased: false,
      };
      transaction(() => {
        save("project", project);
        audit(project.id, user.name, "Project created", project.name);
      });
      return NextResponse.json(project, { status: 201 });
    }
    if (path[0] === "projects" && path.length === 2 && method === "PATCH") {
      const project = projectFor(path[1]);
      const input = z
        .object({
          tolerance: z.number().min(0).max(100),
          bomReleased: z.boolean(),
        })
        .parse(await readJson(request));
      transaction(() => {
        save("project", { ...project, ...input });
        audit(
          project.id,
          user.name,
          "Project settings updated",
          `Tolerance ${input.tolerance} mm; fabrication released: ${input.bomReleased}`,
        );
      });
      return NextResponse.json({ ok: true });
    }
    if (route === "drawings" && method === "POST") {
      const form = await readMultipart(request);
      const file = form.get("file");
      if (!(file instanceof File) || !file.size)
        throw new HttpError("Select a drawing file.");
      if (file.size > 30 * 1024 * 1024)
        throw new HttpError("Maximum upload size is 30 MB.", 413);
      const projectId = text.parse(form.get("projectId"));
      projectFor(projectId);
      const discipline = z
        .enum(["architecture", "structure", "formwork"])
        .parse(form.get("discipline"));
      const revision = text.parse(form.get("revision"));
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext !== "dwg" && ext !== "dxf")
        throw new HttpError("Only .dwg and .dxf drawings are supported.");
      const buffer = Buffer.from(await file.arrayBuffer());
      if (ext === "dwg" && !/^AC10\d{2}/.test(buffer.subarray(0, 6).toString()))
        throw new HttpError(
          "This file does not have a valid AutoCAD DWG header.",
        );
      const drawing: Drawing = {
        id: randomUUID(),
        projectId,
        name: file.name.replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 200),
        discipline,
        revision,
        format: ext.toUpperCase() as "DWG" | "DXF",
        size: file.size,
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.name,
        status: "ready",
      };
      if (ext === "dwg" && !converterAvailable()) {
        drawing.status = "needs_conversion";
        drawing.error =
          "DWG saved. Configure a converter, then retry processing; or upload an ASCII DXF export.";
      } else {
        try {
          drawing.model = parseDxf(
            ext === "dxf" ? buffer.toString("utf8") : await convertDwg(buffer),
          );
        } catch (e) {
          drawing.status = "failed";
          drawing.error =
            e instanceof Error ? e.message : "CAD processing failed.";
        }
      }
      const originalPath = join(dataDir(), "uploads", `${drawing.id}.${ext}`);
      await writeFile(originalPath, buffer, { flag: "wx" });
      try {
        transaction(() => {
          save("drawing", drawing);
          audit(
            projectId,
            user.name,
            "Drawing uploaded",
            `${drawing.name} · ${revision} · ${drawing.status}`,
          );
        });
      } catch (error) {
        await unlink(originalPath).catch(() => {});
        throw error;
      }
      return NextResponse.json(drawing, { status: 201 });
    }
    if (path[0] === "drawings" && path.length === 2 && method === "GET") {
      return NextResponse.json(drawingFor(path[1]), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (
      path[0] === "drawings" &&
      path.length === 3 &&
      path[2] === "file" &&
      method === "GET"
    ) {
      const drawing = drawingFor(path[1]),
        ext = drawing.format.toLowerCase();
      const file = await readFile(
        join(dataDir(), "uploads", `${drawing.id}.${ext}`),
      );
      return new NextResponse(new Uint8Array(file), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(drawing.name)}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    if (
      path[0] === "drawings" &&
      path.length === 3 &&
      path[2] === "retry" &&
      method === "POST"
    ) {
      const drawing = drawingFor(path[1]);
      if (drawing.format !== "DWG")
        throw new HttpError("Only DWG drawings need converter retries.");
      if (!converterAvailable())
        throw new HttpError(
          "Configure the DWG converter before retrying.",
          503,
        );
      if (drawing.status === "ready")
        throw new HttpError(
          "This drawing is already processed. Upload a new revision to preserve analysis history.",
          409,
        );
      if (activeRetries.has(drawing.id))
        throw new HttpError("This drawing is already being processed.", 409);
      activeRetries.add(drawing.id);
      try {
        let model: Drawing["model"];
        try {
          const buffer = await readFile(
            join(dataDir(), "uploads", `${drawing.id}.dwg`),
          );
          model = parseDxf(await convertDwg(buffer));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "CAD processing failed.";
          transaction(() => {
            // Another server may have completed processing during conversion.
            if (drawingFor(drawing.id).status === "ready")
              throw new HttpError(
                "This drawing has already been processed.",
                409,
              );
            save("drawing", { ...drawing, status: "failed", error: message });
            audit(
              drawing.projectId,
              user.name,
              "DWG processing failed",
              drawing.name,
            );
          });
          throw new HttpError(message, 502);
        }
        transaction(() => {
          if (drawingFor(drawing.id).status === "ready")
            throw new HttpError(
              "This drawing has already been processed.",
              409,
            );
          save("drawing", {
            ...drawing,
            model,
            status: "ready",
            error: undefined,
          });
          audit(drawing.projectId, user.name, "DWG processed", drawing.name);
        });
      } finally {
        activeRetries.delete(drawing.id);
      }
      return NextResponse.json({ ok: true });
    }
    if (route === "analyze" && method === "POST") {
      const input = z
        .object({ projectId: text, oldId: text, newId: text, formworkId: text })
        .parse(await readJson(request));
      const project = projectFor(input.projectId),
        result = analyze(
          project,
          drawingFor(input.oldId),
          drawingFor(input.newId),
          drawingFor(input.formworkId),
          user.name,
        );
      transaction(() => {
        save("run", result.run);
        result.issues.forEach((i) => save("issue", i));
        audit(
          project.id,
          user.name,
          "Analysis completed",
          `${result.issues.length} findings across ${result.run.checks} checks.`,
        );
      });
      return NextResponse.json(result, { status: 201 });
    }
    if (path[0] === "issues" && path.length === 2 && method === "PATCH") {
      const issue = get<Issue>("issue", path[1]);
      if (!issue) throw new HttpError("Issue not found.", 404);
      const input = reviewInput.parse(await readJson(request));
      if (input.status !== "open" && !input.notes)
        throw new HttpError(
          "Add a designer note to explain your review decision.",
        );
      const updated = transaction(() => {
        const latest = get<Issue>("issue", issue.id)!;
        if ((latest.version ?? 0) !== input.expectedVersion)
          throw new HttpError(
            "This finding was reviewed in another tab. Reload before saving your decision.",
            409,
          );
        const updated = {
          ...latest,
          status: input.status,
          notes: input.notes,
          version: (latest.version ?? 0) + 1,
          reviewedBy: input.status === "open" ? undefined : user.name,
          reviewedAt:
            input.status === "open" ? undefined : new Date().toISOString(),
        };
        save("issue", updated);
        audit(
          issue.projectId,
          user.name,
          "Issue reviewed",
          `${issue.tag} / #${issue.number}: ${input.status}. ${input.notes}`,
        );
        return updated;
      });
      return NextResponse.json(updated);
    }
    if (route === "memory" && method === "POST") {
      const input = z
        .object({
          title: text,
          category: z.enum(["Openings", "Structure", "Fabrication", "General"]),
          project: text,
          drawing: text,
          reference: text,
          description: z.string().trim().min(10).max(2000),
          resolution: z.string().trim().min(10).max(4000),
          tags: z.array(text).max(20),
          sourceUrl: z
            .url()
            .refine(
              (s) => s.startsWith("https://"),
              "Use an HTTPS source URL.",
            ),
        })
        .parse(await readJson(request));
      const memory: MemoryCase = {
        ...input,
        id: randomUUID(),
        approvedBy: user.name,
        approvedAt: new Date().toISOString(),
      };
      transaction(() => {
        save("memory", memory);
        audit("", user.name, "Approved reference added", memory.title);
      });
      return NextResponse.json(memory, { status: 201 });
    }
    if (route === "reports" && method === "GET") {
      const project = projectFor(
          request.nextUrl.searchParams.get("projectId") ?? "",
        ),
        format = request.nextUrl.searchParams.get("format") ?? "html";
      if (format !== "csv" && format !== "html")
        throw new HttpError("Unsupported report format.");
      const runs = list<AnalysisRun>("run", project.id).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const runId = request.nextUrl.searchParams.get("runId"),
        run = runId ? runs.find((r) => r.id === runId) : runs[0];
      if (!run)
        throw new HttpError("Run an analysis before generating a report.");
      const issues = list<Issue>("issue", project.id)
        .filter((i) => i.runId === run.id)
        .sort((a, b) => a.number - b.number);
      audit(
        project.id,
        user.name,
        "Report generated",
        `${format.toUpperCase()} · ${issues.length} findings`,
      );
      if (format === "csv")
        return new NextResponse(issueCsv(issues), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="formiq-review.csv"`,
            "Cache-Control": "private, no-store",
          },
        });
      return new NextResponse(
        reportHtml(project, run, list<Drawing>("drawing", project.id), issues),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, no-store",
          },
        },
      );
    }
    throw new HttpError("Endpoint not found.", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return NextResponse.json(
        {
          error: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        { status: 400 },
      );
    if (e instanceof HttpError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[FORMIQ API]", e);
    return NextResponse.json(
      {
        error:
          "The request could not be completed. Check the server configuration and try again.",
      },
      { status: 500 },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH };
