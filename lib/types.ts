export type Discipline = "architecture" | "structure";
export type ReviewStatus = "open" | "accepted" | "rejected" | "investigating";
export type Severity = "high" | "medium" | "low";
export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
  /** Bulge of the segment starting at each vertex (polylines only). */
  bulges?: number[];
  /** Original DXF handle of the source record. */
  handle?: string;
  /** Block insert path for geometry expanded from blocks. */
  block?: string;
  /** Lines drawn between dimension definition points are annotation, not physical geometry. */
  role?: "dimension";
  height?: number;
  rotation?: number;
}
export interface Measurement {
  tag: string;
  kind: string;
  value: number;
  point: Point;
  layer: string;
  entityId: string;
  source: "dimension" | "annotation";
  dimType?: "rotated" | "aligned";
  /** Measured feature reference points (DXF 13/14), normalized to millimetres. */
  defPoints?: [Point, Point];
  /** Measured axis in degrees, [0, 180). */
  axis?: number;
  /** Dimension line location (DXF 10); annotation placement only. */
  linePoint?: Point;
  valueSource?: "stored" | "computed";
  /** Distance computed from the reference points along the measured axis. */
  geometricValue?: number;
  /** Explicit displayed text that replaces the measured value. */
  displayText?: string;
  handle?: string;
}
export interface UnsupportedContent {
  type: string;
  layer: string;
  bounds?: Bounds;
  reason: string;
}
export interface CadModel {
  entities: CadEntity[];
  measurements: Measurement[];
  layers: string[];
  units: string;
  unitScale: number | null;
  warnings: string[];
  bounds: Bounds;
  entityCount: number;
  parserVersion?: string;
  converter?: string;
  /** Skipped or unsupported content with location where available (capped). */
  unsupported?: UnsupportedContent[];
  skippedCounts?: Record<string, number>;
}
/** Rigid transform from previous-revision coordinates to latest coordinates. */
export interface RigidTransform {
  rotation: number;
  dx: number;
  dy: number;
}
export interface ViewAlignment {
  id: string;
  previousBounds?: Bounds;
  latestBounds?: Bounds;
  transform: RigidTransform;
  status: "unchanged" | "aligned" | "ambiguous" | "added" | "removed";
  matched: number;
  total: number;
  basis: string;
}
export interface AlignmentRecord {
  global: RigidTransform & {
    status: "identity" | "aligned" | "ambiguous";
    support: number;
    alternative?: number;
    basis: string;
  };
  views: ViewAlignment[];
}
export interface ChangeItem {
  change: "added" | "removed" | "modified" | "moved" | "uncertain";
  previousIds: string[];
  latestIds: string[];
  /** Latest-revision coordinates (previous geometry is mapped through the alignment). */
  bounds: Bounds;
  previousBounds?: Bounds;
  basis: string;
  delta?: { dx?: number; dy?: number; length?: number; radius?: number };
}
export interface FindingEvidence {
  basis: string;
  /** Heuristic label, not a calibrated probability. */
  confidence: "high" | "medium" | "low";
  tolerance: number;
  previousIds: string[];
  latestIds: string[];
  previousHandles?: string[];
  latestHandles?: string[];
  previousBounds?: Bounds;
  latestBounds?: Bounds;
  previousPoint?: Point;
  delta?: {
    value?: number;
    dx?: number;
    dy?: number;
    rotation?: number;
    length?: number;
    radius?: number;
    units: "mm" | "deg";
  };
  items?: ChangeItem[];
  omittedItems?: number;
  view?: string;
  layerClass?: string;
  warnings?: string[];
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
  /** SHA-256 of the retained original file. */
  sha256?: string;
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
  category?: "dimension" | "geometry" | "annotation" | "layout" | "quality";
  change?:
    | "added"
    | "removed"
    | "modified"
    | "moved"
    | "annotation"
    | "uncertain"
    | "aligned";
  evidence?: FindingEvidence;
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
  engineVersion?: string;
  config?: {
    dimensionTolerance: number;
    geometryTolerance: number;
    alignment: "automatic-with-evidence";
    annotationFilter: "classify-only";
  };
  sources?: RunSource[];
  alignment?: AlignmentRecord;
  stats?: Record<string, number>;
}
export interface RunSource {
  drawingId: string;
  role: "previous" | "latest";
  name: string;
  revision: string;
  sha256?: string;
  modelSha256: string;
  parserVersion?: string;
  converter?: string;
  /** "snapshot" when the run stored the re-extracted model it analyzed. */
  model: "drawing" | "snapshot";
  snapshotId?: string;
  reextracted: boolean;
}
export interface ModelSnapshot {
  id: string;
  projectId: string;
  runId: string;
  drawingId: string;
  model: CadModel;
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
