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
  return withOwner(user.id, async () => ({
    user,
    projects: await list<Project>("project"),
    drawings: await drawingSummaries(),
    issues: await list<Issue>("issue"),
    runs: await list<AnalysisRun>("run"),
    memory: await list<MemoryCase>("memory"),
    audit: await list<AuditEvent>("audit"),
    converterAvailable: converterAvailable(),
    demoEnabled: demoEnabled(),
  }));
}
