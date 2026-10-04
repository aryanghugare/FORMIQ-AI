import { demoEnabled, list, listDrawingSummaries } from "./db";
import { converterAvailable } from "./converter";
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
export function loadWorkspace(user: User): WorkspaceData {
  return {
    user,
    projects: list<Project>("project"),
    drawings: listDrawingSummaries(),
    issues: list<Issue>("issue"),
    runs: list<AnalysisRun>("run"),
    memory: list<MemoryCase>("memory"),
    audit: list<AuditEvent>("audit"),
    converterAvailable: converterAvailable(),
    demoEnabled: demoEnabled(),
  };
}
