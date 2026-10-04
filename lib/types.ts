export type Discipline = "architecture" | "structure";
export type ReviewStatus = "open" | "accepted" | "rejected" | "investigating";
export type Severity = "high" | "medium" | "low";
export interface Point {
  x: number;
  y: number;
}
export interface CadEntity {
  id: string;
  type: "line" | "polyline" | "circle" | "arc" | "text";
  layer: string;
  points: Point[];
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  text?: string;
  closed?: boolean;
}
export interface Measurement {
  tag: string;
  kind: string;
  value: number;
  point: Point;
  layer: string;
  entityId: string;
  source: "dimension" | "annotation";
}
export interface CadModel {
  entities: CadEntity[];
  measurements: Measurement[];
  layers: string[];
  units: string;
  unitScale: number | null;
  warnings: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  entityCount: number;
}
export interface Project {
  id: string;
  name: string;
  code: string;
  location: string;
  description: string;
  createdAt: string;
  demo?: boolean;
  tolerance: number;
  bomReleased: boolean;
}
export interface Drawing {
  fileId?: string;
  id: string;
  projectId: string;
  name: string;
  revision: string;
  discipline: Discipline;
  format: "DWG" | "DXF";
  size: number;
  uploadedAt: string;
  uploadedBy: string;
  status: "ready" | "needs_conversion" | "failed";
  error?: string;
  model?: CadModel;
  extraction?: {
    entityCount: number;
    measurementCount: number;
    warnings: string[];
    units: string;
  };
}
export interface Issue {
  id: string;
  projectId: string;
  runId: string;
  number: number;
  title: string;
  tag: string;
  kind: string;
  rule: string;
  severity: Severity;
  status: ReviewStatus;
  description: string;
  previous?: number;
  current?: number;
  point: Point;
  geometry?: {
    added: number;
    removed: number;
    layer: string;
    bounds: CadModel["bounds"];
  };
  impact: string[];
  drawingIds: string[];
  createdAt: string;
  notes: string;
  reviewedBy?: string;
  reviewedAt?: string;
  version?: number;
}
export interface AnalysisRun {
  id: string;
  projectId: string;
  createdAt: string;
  createdBy: string;
  oldId: string;
  newId: string;
  issueCount: number;
  durationMs: number;
  checks: number;
  warnings: string[];
  tolerance: number;
}
export interface MemoryCase {
  id: string;
  title: string;
  category: string;
  project: string;
  drawing: string;
  reference: string;
  description: string;
  resolution: string;
  tags: string[];
  sourceUrl?: string;
  approvedBy: string;
  approvedAt: string;
  demo?: boolean;
}
export interface AuditEvent {
  id: string;
  projectId: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}
export interface User {
  id: string;
  name: string;
  email: string;
}
export interface WorkspaceData {
  user: User;
  projects: Project[];
  drawings: Drawing[];
  issues: Issue[];
  runs: AnalysisRun[];
  memory: MemoryCase[];
  audit: AuditEvent[];
  converterAvailable: boolean;
  demoEnabled: boolean;
}
