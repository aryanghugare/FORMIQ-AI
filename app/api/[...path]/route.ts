import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  audit,
  get,
  list,
  save,
  transaction,
  health,
  prepareDrawing,
  writeOriginal,
  readOriginal,
  removeOriginal,
  lockDrawing,
  updateDrawingInfo,
  removeDrawingRecord,
  removeDrawingFiles,
} from "@/lib/store";
import {
  userForToken,
  login,
  register,
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
import { withOwner } from "@/lib/ownership";
import { allowedWriteOrigin } from "@/lib/request-origin";
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
const drawingInfoInput = z
  .object({
    name: text,
    revision: text,
    discipline: z.enum(["architecture", "structure", "formwork"]),
  })
  .strict();
async function assertDrawingUnused(drawing: Drawing) {
  const runs = await list<AnalysisRun>("run", drawing.projectId);
  if (
    runs.some((run) =>
      [run.oldId, run.newId, run.formworkId].includes(drawing.id),
    )
  )
    throw new HttpError(
      "This drawing is used in an analysis. Upload a new revision to preserve the review history.",
      409,
    );
  if (activeRetries.has(drawing.id))
    throw new HttpError("Wait until this drawing finishes processing.", 409);
}
const projectFor = async (id: string) => {
  const p = await get<Project>("project", id);
  if (!p) throw new HttpError("Project not found.", 404);
  return p;
};
const drawingFor = async (id: string) => {
  const d = await get<Drawing>("drawing", id);
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
    if (route === "health" && method === "GET") {
      try {
        await health();
        return NextResponse.json(
          { status: "ready" },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch {
        return NextResponse.json(
          { status: "unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    if (method !== "GET") {
      if (!allowedWriteOrigin(request))
        throw new HttpError(
          "Cross-origin write requests are not allowed.",
          403,
        );
      if (request.headers.get("sec-fetch-site") === "cross-site")
        throw new HttpError("Cross-site request rejected.", 403);
    }
    if (
      (route === "auth/login" || route === "auth/register") &&
      method === "POST"
    ) {
      const signingUp = route === "auth/register";
      const input = z
        .object({
          name: signingUp
            ? z.string().trim().min(1).max(100)
            : z.string().optional(),
          email: z.string().trim().email().max(160),
          password: z
            .string()
            .min(signingUp ? 10 : 1)
            .max(200),
        })
        .parse(await readJson(request));
      const result = signingUp
        ? await register(input.name!, input.email, input.password)
        : await login(input.email, input.password);
      if (!result) throw new HttpError("Email or password is incorrect.", 401);
      const response = NextResponse.json(
        { user: result.user },
        { status: signingUp ? 201 : 200 },
      );
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
      await logout(request.cookies.get(SESSION_COOKIE)?.value);
      const response = NextResponse.json({ ok: true });
      response.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
      return response;
    }
    const user = await userForToken(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) throw new HttpError("Please sign in to continue.", 401);
    return await withOwner(user.id, async () => {
      if (route === "workspace" && method === "GET") {
        const data = await loadWorkspace(user);
        return NextResponse.json(data, {
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (route === "rules" && method === "GET")
        return NextResponse.json(RULES);
      if (route === "projects" && method === "POST") {
        const input = projectInput.parse(await readJson(request));
        if (
          (await list<Project>("project")).some(
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
        await transaction(async () => {
          await save("project", project);
          await audit(project.id, user.name, "Project created", project.name);
        });
        return NextResponse.json(project, { status: 201 });
      }
      if (path[0] === "projects" && path.length === 2 && method === "PATCH") {
        const project = await projectFor(path[1]);
        const input = z
          .object({
            tolerance: z.number().min(0).max(100),
            bomReleased: z.boolean(),
          })
          .parse(await readJson(request));
        await transaction(async () => {
          await save("project", { ...project, ...input });
          await audit(
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
        await projectFor(projectId);
        const discipline = z
          .enum(["architecture", "structure", "formwork"])
          .parse(form.get("discipline"));
        const revision = text.parse(form.get("revision"));
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (ext !== "dwg" && ext !== "dxf")
          throw new HttpError("Only .dwg and .dxf drawings are supported.");
        const buffer = Buffer.from(await file.arrayBuffer());
        if (
          ext === "dwg" &&
          !/^AC10\d{2}/.test(buffer.subarray(0, 6).toString())
        )
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
            "DWG saved. Start the Docker app with DWG conversion, then click Retry; or install a local converter.";
        } else {
          try {
            drawing.model = parseDxf(
              ext === "dxf"
                ? buffer.toString("utf8")
                : await convertDwg(buffer),
            );
          } catch (e) {
            drawing.status = "failed";
            drawing.error =
              e instanceof Error ? e.message : "CAD processing failed.";
          }
        }
        await writeOriginal(drawing, buffer);
        let prepared: Awaited<ReturnType<typeof prepareDrawing>> | undefined;
        try {
          prepared = await prepareDrawing(drawing);
          await transaction(async () => {
            await prepared!.save();
            await audit(
              projectId,
              user.name,
              "Drawing uploaded",
              `${drawing.name} · ${revision} · ${drawing.status}`,
            );
          });
        } catch (error) {
          // Keep files if a lost commit acknowledgement makes transaction outcome uncertain.
          const uncertain =
            error &&
            typeof error === "object" &&
            "hasErrorLabel" in error &&
            typeof error.hasErrorLabel === "function" &&
            error.hasErrorLabel("UnknownTransactionCommitResult");
          if (!uncertain) {
            await prepared?.discard();
            await removeOriginal(drawing).catch(() => {});
          }
          throw error;
        }
        return NextResponse.json(drawing, { status: 201 });
      }
      if (path[0] === "drawings" && path.length === 2 && method === "GET") {
        return NextResponse.json(await drawingFor(path[1]), {
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (path[0] === "drawings" && path.length === 2 && method === "PATCH") {
        const input = drawingInfoInput.parse(await readJson(request));
        await transaction(async () => {
          const drawing = await drawingFor(path[1]);
          await assertDrawingUnused(drawing);
          if (
            !input.name
              .toLowerCase()
              .endsWith(`.${drawing.format.toLowerCase()}`) ||
            /[\\/\x00-\x1f\x7f]/.test(input.name)
          )
            throw new HttpError(
              `Keep the .${drawing.format.toLowerCase()} extension and use a file name without slashes.`,
            );
          await updateDrawingInfo(drawing.id, input);
          await audit(
            drawing.projectId,
            user.name,
            "Drawing details updated",
            `${drawing.name} → ${input.name} / ${input.revision} / ${input.discipline}`,
          );
        });
        return NextResponse.json({ ok: true });
      }
      if (path[0] === "drawings" && path.length === 2 && method === "DELETE") {
        const removed = await transaction(async () => {
          const drawing = await drawingFor(path[1]);
          await assertDrawingUnused(drawing);
          const modelFileId = await removeDrawingRecord(drawing.id);
          await audit(
            drawing.projectId,
            user.name,
            "Drawing deleted",
            `${drawing.name} / ${drawing.revision}`,
          );
          return { drawing, modelFileId };
        });
        // GridFS cleanup runs only after metadata deletion commits.
        try {
          await removeDrawingFiles(removed.drawing, removed.modelFileId);
          return NextResponse.json({ ok: true });
        } catch {
          return NextResponse.json({
            ok: true,
            warning:
              "Drawing removed from the library, but stored file cleanup failed. Contact the administrator to clean up the retained storage.",
          });
        }
      }
      if (
        path[0] === "drawings" &&
        path.length === 3 &&
        path[2] === "file" &&
        method === "GET"
      ) {
        const drawing = await drawingFor(path[1]);
        const file = await readOriginal(drawing);
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
        const drawing = await drawingFor(path[1]);
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
            const buffer = await readOriginal(drawing);
            model = parseDxf(await convertDwg(buffer));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "CAD processing failed.";
            await transaction(async () => {
              // Another server may have completed processing during conversion.
              const current = await drawingFor(drawing.id);
              if (current.status === "ready")
                throw new HttpError(
                  "This drawing has already been processed.",
                  409,
                );
              await save("drawing", {
                ...current,
                status: "failed",
                error: message,
              });
              await audit(
                drawing.projectId,
                user.name,
                "DWG processing failed",
                drawing.name,
              );
            });
            throw new HttpError(message, 502);
          }
          const prepared = await prepareDrawing({
            ...drawing,
            model,
            status: "ready",
            error: undefined,
          });
          try {
            await transaction(async () => {
              const current = await drawingFor(drawing.id);
              if (current.status === "ready")
                throw new HttpError(
                  "This drawing has already been processed.",
                  409,
                );
              await prepared.save({
                name: current.name,
                revision: current.revision,
                discipline: current.discipline,
              });
              await audit(
                drawing.projectId,
                user.name,
                "DWG processed",
                drawing.name,
              );
            });
          } catch (error) {
            const uncertain =
              error &&
              typeof error === "object" &&
              "hasErrorLabel" in error &&
              typeof error.hasErrorLabel === "function" &&
              error.hasErrorLabel("UnknownTransactionCommitResult");
            if (!uncertain) await prepared.discard();
            throw error;
          }
        } finally {
          activeRetries.delete(drawing.id);
        }
        return NextResponse.json({ ok: true });
      }
      if (route === "analyze" && method === "POST") {
        const input = z
          .object({
            projectId: text,
            oldId: text,
            newId: text,
            formworkId: text,
          })
          .parse(await readJson(request));
        const result = await transaction(async () => {
          for (const id of new Set([
            input.oldId,
            input.newId,
            input.formworkId,
          ]))
            await lockDrawing(id);
          const project = await projectFor(input.projectId);
          const result = analyze(
            project,
            await drawingFor(input.oldId),
            await drawingFor(input.newId),
            await drawingFor(input.formworkId),
            user.name,
          );
          await save("run", result.run);
          for (const issue of result.issues) await save("issue", issue);
          await audit(
            project.id,
            user.name,
            "Analysis completed",
            `${result.issues.length} findings across ${result.run.checks} checks.`,
          );
          return result;
        });
        return NextResponse.json(result, { status: 201 });
      }
      if (path[0] === "issues" && path.length === 2 && method === "PATCH") {
        const issue = await get<Issue>("issue", path[1]);
        if (!issue) throw new HttpError("Issue not found.", 404);
        const input = reviewInput.parse(await readJson(request));
        if (input.status !== "open" && !input.notes)
          throw new HttpError(
            "Add a designer note to explain your review decision.",
          );
        const updated = await transaction(async () => {
          const latest = (await get<Issue>("issue", issue.id))!;
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
          await save("issue", updated);
          await audit(
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
            category: z.enum([
              "Openings",
              "Structure",
              "Fabrication",
              "General",
            ]),
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
        await transaction(async () => {
          await save("memory", memory);
          await audit("", user.name, "Approved reference added", memory.title);
        });
        return NextResponse.json(memory, { status: 201 });
      }
      if (route === "reports" && method === "GET") {
        const project = await projectFor(
            request.nextUrl.searchParams.get("projectId") ?? "",
          ),
          format = request.nextUrl.searchParams.get("format") ?? "html";
        if (format !== "csv" && format !== "html")
          throw new HttpError("Unsupported report format.");
        const runs = (await list<AnalysisRun>("run", project.id)).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        const runId = request.nextUrl.searchParams.get("runId"),
          run = runId ? runs.find((r) => r.id === runId) : runs[0];
        if (!run)
          throw new HttpError("Run an analysis before generating a report.");
        const issues = (await list<Issue>("issue", project.id))
          .filter((i) => i.runId === run.id)
          .sort((a, b) => a.number - b.number);
        await audit(
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
          reportHtml(
            project,
            run,
            await list<Drawing>("drawing", project.id),
            issues,
          ),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "private, no-store",
            },
          },
        );
      }
      throw new HttpError("Endpoint not found.", 404);
    });
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
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        (e.code === "ERR_SQLITE_ERROR" && "errcode" in e && e.errcode === 2067))
    )
      return NextResponse.json(
        {
          error: "An account with this email already exists. Sign in instead.",
        },
        { status: 409 },
      );
    if (e && typeof e === "object" && "code" in e && e.code === 11000)
      return NextResponse.json(
        {
          error: routeIsRegistration(request)
            ? "An account with this email already exists. Sign in instead."
            : "This record already exists.",
        },
        { status: 409 },
      );
    console.error(
      "[FORMIQ API] Request failed",
      e instanceof Error ? e.name : "Unknown",
    );
    return NextResponse.json(
      {
        error:
          "The request could not be completed. Check the server configuration and try again.",
      },
      { status: 500 },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
function routeIsRegistration(request: NextRequest) {
  return request.nextUrl.pathname === "/api/auth/register";
}
