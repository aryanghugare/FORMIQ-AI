import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, scryptSync, randomBytes } from "node:crypto";
import { parseDxf } from "./cad";
import { analyze } from "./analysis";
import { demoDxf, demoMemory } from "./demo";
import { z } from "zod";
import type { AuditEvent, Drawing, Project } from "./types";
export const demoEnabled = () =>
  !process.env.MONGODB_URI?.trim() &&
  (process.env.FORMIQ_DEMO === "true" ||
    (process.env.NODE_ENV !== "production" &&
      process.env.FORMIQ_DEMO !== "false"));
export const dataDir = () => resolve(process.env.FORMIQ_DATA_DIR || ".formiq");
let instance: DatabaseSync | undefined;
export function db() {
  if (instance) return instance;
  mkdirSync(join(dataDir(), "uploads"), { recursive: true });
  instance = new DatabaseSync(join(dataDir(), "formiq.sqlite"));
  try {
    instance.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, projectId TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, summary TEXT);
    CREATE INDEX IF NOT EXISTS records_kind_project ON records(kind,projectId);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
    // Backfill metadata once for databases created before geometry was loaded on demand.
    instance.exec("BEGIN IMMEDIATE");
    try {
      const columns = instance.prepare("PRAGMA table_info(records)").all();
      if (!columns.some((c) => c.name === "ownerId"))
        instance.exec(
          "ALTER TABLE records ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''",
        );
      if (!columns.some((c) => c.name === "summary"))
        instance.exec("ALTER TABLE records ADD COLUMN summary TEXT");
      const legacy = instance
        .prepare(
          "SELECT id,data FROM records WHERE kind='drawing' AND summary IS NULL",
        )
        .all();
      const update = instance.prepare(
        "UPDATE records SET summary=? WHERE id=?",
      );
      for (const row of legacy)
        update.run(
          JSON.stringify(summarizeDrawing(JSON.parse(row.data as string))),
          row.id as string,
        );
      instance.exec("COMMIT");
    } catch (error) {
      instance.exec("ROLLBACK");
      throw error;
    }
    const count = instance
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as { count: number };
    if (!count.count) {
      const email =
        process.env.FORMIQ_ADMIN_EMAIL ||
        (demoEnabled() ? "designer@formiq.ai" : "");
      const password =
        process.env.FORMIQ_ADMIN_PASSWORD ||
        (demoEnabled() ? "Formiq@2026" : "");
      if (
        !z.email().max(160).safeParse(email.trim()).success ||
        password.length < 10 ||
        password.length > 200
      )
        throw new Error(
          "Set FORMIQ_ADMIN_EMAIL and FORMIQ_ADMIN_PASSWORD (10–200 characters), or enable FORMIQ_DEMO.",
        );
      const salt = randomBytes(16).toString("hex");
      instance
        .prepare("INSERT INTO users VALUES (?,?,?,?,?)")
        .run(
          randomUUID(),
          "Design Lead",
          email.trim().toLowerCase(),
          salt,
          scryptSync(password, salt, 64).toString("hex"),
        );
    }
    if (
      demoEnabled() &&
      !instance.prepare("SELECT id FROM records WHERE id='demo-project'").get()
    )
      seedDemo();
    // Legacy records stay with their original account, even if that user is removed later.
    instance
      .prepare(
        "UPDATE records SET ownerId=(SELECT id FROM users ORDER BY rowid LIMIT 1) WHERE ownerId=''",
      )
      .run();
    instance.exec(
      "CREATE INDEX IF NOT EXISTS records_owner_kind_project ON records(ownerId,kind,projectId)",
    );
    return instance;
  } catch (error) {
    instance.close();
    instance = undefined;
    throw error;
  }
}
export function list<T>(kind: string, projectId?: string): T[] {
  const rows =
    projectId === undefined
      ? db()
          .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC")
          .all(kind)
      : db()
          .prepare(
            "SELECT data FROM records WHERE kind=? AND projectId=? ORDER BY rowid DESC",
          )
          .all(kind, projectId);
  return rows.map((r) => JSON.parse(r.data as string) as T);
}
function summarizeDrawing(drawing: Drawing): Drawing {
  const { model, ...metadata } = drawing;
  return {
    ...metadata,
    ...(model
      ? {
          extraction: {
            entityCount: model.entityCount,
            measurementCount: model.measurements.length,
            warnings: model.warnings,
            units: model.units,
          },
        }
      : {}),
  };
}
export function listDrawingSummaries(): Drawing[] {
  return db()
    .prepare(
      "SELECT summary FROM records WHERE kind='drawing' ORDER BY rowid DESC",
    )
    .all()
    .map((row) => JSON.parse(row.summary as string));
}
export function get<T>(kind: string, id: string): T | undefined {
  const row = db()
    .prepare("SELECT data FROM records WHERE kind=? AND id=?")
    .get(kind, id);
  return row ? JSON.parse(row.data as string) : undefined;
}
export function save<T extends { id: string; projectId?: string }>(
  kind: string,
  data: T,
) {
  db()
    .prepare(
      "INSERT INTO records (id,kind,projectId,data,summary,ownerId) VALUES (?,?,?,?,?,(SELECT id FROM users ORDER BY rowid LIMIT 1)) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,projectId=excluded.projectId,data=excluded.data,summary=excluded.summary",
    )
    .run(
      data.id,
      kind,
      data.projectId ?? "",
      JSON.stringify(data),
      kind === "drawing"
        ? JSON.stringify(summarizeDrawing(data as unknown as Drawing))
        : null,
    );
  return data;
}
export function transaction<T>(fn: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db().exec("COMMIT");
    return v;
  } catch (e) {
    db().exec("ROLLBACK");
    throw e;
  }
}
export function audit(
  projectId: string,
  actor: string,
  action: string,
  detail: string,
) {
  save<AuditEvent>("audit", {
    id: randomUUID(),
    projectId,
    actor,
    action,
    detail,
    createdAt: new Date().toISOString(),
  });
}
function seedDemo() {
  const project: Project = {
    id: "demo-project",
    name: "The Meridian Residences",
    code: "KK-2026-014",
    location: "Mumbai, India",
    description:
      "Illustrative Level 12 drawing set based on the FORMIQ presentation.",
    createdAt: new Date().toISOString(),
    demo: true,
    tolerance: 1,
    bomReleased: false,
  };
  transaction(() => {
    save("project", project);
    const user = db().prepare("SELECT name FROM users LIMIT 1").get() as {
      name: string;
    };
    const drawings = (["old", "new", "formwork"] as const).map((r, i) => {
      const content = demoDxf(r),
        id = `demo-drawing-${r}`,
        name =
          r === "formwork"
            ? "FW-L12.dxf"
            : `ARCH-L12-Rev-${i === 0 ? "05" : "06"}.dxf`;
      writeFileSync(join(dataDir(), "uploads", `${id}.dxf`), content);
      const drawing: Drawing = {
        id,
        projectId: project.id,
        name,
        revision: r === "old" ? "Rev.05" : r === "new" ? "Rev.06" : "Rev.03",
        discipline: r === "formwork" ? "formwork" : "architecture",
        format: "DXF",
        size: Buffer.byteLength(content),
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.name,
        status: "ready",
        model: parseDxf(content),
      };
      return save("drawing", drawing);
    });
    const result = analyze(
      project,
      drawings[0],
      drawings[1],
      drawings[2],
      user.name,
    );
    save("run", result.run);
    result.issues.forEach((i) => save("issue", i));
    demoMemory.forEach((m) => save("memory", m));
    audit(
      project.id,
      "FORMIQ",
      "Demo workspace created",
      "Three illustrative CAD drawings were parsed and compared.",
    );
  });
}
