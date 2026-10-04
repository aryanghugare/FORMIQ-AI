import { demoEnabled } from "./db";
import { list, drawingSummaries } from "./store";
import { converterAvailable } from "./converter";
import { withOwner } from "./ownership";
import type {
  AnalysisRun,
  AuditEvent,
  Drawing,
  Issue,
  MemoryCase,
  Project,
  User,
  WorkspaceData,
} from "./types";
export async function loadWorkspace(user: User): Promise<WorkspaceData> {
  return withOwner(user.id, async () => {
    const drawings = (await drawingSummaries()).filter((drawing) =>
      ["architecture", "structure"].includes(drawing.discipline),
    );
    // Keep historical three-source reviews in storage, outside the current workflow.
    const runs = (await list<AnalysisRun>("run")).filter(
      (run) => !("formworkId" in run),
    );
    const runIds = new Set(runs.map((run) => run.id));
    return {
      user,
      projects: await list<Project>("project"),
      drawings,
      issues: (await list<Issue>("issue")).filter((issue) =>
        runIds.has(issue.runId),
      ),
      runs,
      memory: await list<MemoryCase>("memory"),
      audit: await list<AuditEvent>("audit"),
      converterAvailable: converterAvailable(),
      demoEnabled: demoEnabled(),
    };
  });
}
