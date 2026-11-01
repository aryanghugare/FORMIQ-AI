import { demoEnabled } from "./db";
import {
  list,
  drawingSummaries,
  issuesForRuns,
  recentAudit,
  reviewCounts,
} from "./store";
import { configuredTimeZone } from "./format";
import { converterAvailable } from "./converter";
import { withOwner } from "./ownership";
import type {
  AnalysisRun,
  AuditEvent,
  Drawing,
  MemoryCase,
  Project,
  User,
  WorkspaceData,
} from "./types";
/** Audit events sent per project; the UI shows the most recent few. */
const AUDIT_PER_PROJECT = 20;
export async function loadWorkspace(user: User): Promise<WorkspaceData> {
  return withOwner(user.id, async () => {
    const drawings = (await drawingSummaries()).filter((drawing) =>
      ["architecture", "structure"].includes(drawing.discipline),
    );
    // Keep historical three-source reviews in storage, outside the current workflow.
    const runs = (await list<AnalysisRun>("run")).filter(
      (run) => !("formworkId" in run),
    );
    // Findings of older runs load on demand: GET /api/runs/:id/issues.
    const latest = new Map<string, AnalysisRun>();
    for (const run of runs) {
      const known = latest.get(run.projectId);
      if (!known || run.createdAt > known.createdAt)
        latest.set(run.projectId, run);
    }
    const projects = await list<Project>("project");
    const audit: AuditEvent[] = [];
    for (const project of projects)
      audit.push(...(await recentAudit(project.id, AUDIT_PER_PROJECT)));
    return {
      user,
      projects,
      drawings,
      issues: await issuesForRuns([...latest.values()].map((run) => run.id)),
      runs,
      memory: await list<MemoryCase>("memory"),
      audit,
      reviewCounts: await reviewCounts(),
      timeZone: configuredTimeZone(),
      converterAvailable: converterAvailable(),
      demoEnabled: demoEnabled(),
    };
  });
}
