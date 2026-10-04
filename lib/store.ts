import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as local from "./db";
import {
  mongoEnabled,
  initializeMongo,
  mongoDatabase,
  mongoGet,
  mongoList,
  mongoSave,
  mongoTransaction,
  prepareMongoDrawing,
  uploadMongoFile,
  downloadMongoFile,
  deleteMongoFile,
  mongoOptions,
} from "./mongo";
import type { Drawing, AuditEvent } from "./types";
import { ownerId } from "./ownership";
import { HttpError } from "./errors";
import type { Document } from "mongodb";
function localScope() {
  const id = ownerId();
  return {
    sql: "ownerId=?",
    parameters: [id],
  };
}
export async function get<T>(kind: string, id: string): Promise<T | undefined> {
  if (mongoEnabled()) return mongoGet<T>(kind, id);
  const scope = localScope();
  const row = local
    .db()
    .prepare(`SELECT data FROM records WHERE kind=? AND id=? AND ${scope.sql}`)
    .get(kind, id, ...scope.parameters);
  return row ? (JSON.parse(row.data as string) as T) : undefined;
}
export async function list<T>(kind: string, projectId?: string): Promise<T[]> {
  if (mongoEnabled()) return mongoList<T>(kind, projectId);
  const scope = localScope();
  const rows = local
    .db()
    .prepare(
      `SELECT data FROM records WHERE kind=? AND ${scope.sql}${projectId === undefined ? "" : " AND projectId=?"} ORDER BY rowid DESC`,
    )
    .all(
      kind,
      ...scope.parameters,
      ...(projectId === undefined ? [] : [projectId]),
    );
  return rows.map((row) => JSON.parse(row.data as string) as T);
}
export async function drawingSummaries(): Promise<Drawing[]> {
  if (mongoEnabled()) return mongoList<Drawing>("drawing", undefined, true);
  const scope = localScope();
  return local
    .db()
    .prepare(
      `SELECT summary FROM records WHERE kind='drawing' AND ${scope.sql} ORDER BY rowid DESC`,
    )
    .all(...scope.parameters)
    .map((row) => JSON.parse(row.summary as string));
}
export async function save<T extends { id: string; projectId?: string }>(
  kind: string,
  data: T,
): Promise<T> {
  if (mongoEnabled()) {
    if (kind === "drawing" && (data as unknown as Drawing).model)
      throw new Error(
        "Use prepareDrawing before saving MongoDB drawing geometry.",
      );
    await mongoSave(kind, data);
  } else {
    const existing = local
      .db()
      .prepare("SELECT id FROM records WHERE id=?")
      .get(data.id);
    if (existing && !(await get(kind, data.id)))
      throw new HttpError("Record not found.", 404);
    local.save(kind, data);
    local
      .db()
      .prepare("UPDATE records SET ownerId=? WHERE id=?")
      .run(ownerId(), data.id);
  }
  return data;
}
// Serialize local async transactions so other requests cannot accidentally join one.
let localTail: Promise<unknown> = Promise.resolve();
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  if (mongoEnabled()) return mongoTransaction(work);
  const execute = async () => {
    local.db().exec("BEGIN IMMEDIATE");
    try {
      const result = await work();
      local.db().exec("COMMIT");
      return result;
    } catch (error) {
      local.db().exec("ROLLBACK");
      throw error;
    }
  };
  const result = localTail.then(execute, execute);
  localTail = result.catch(() => {});
  return result;
}
export async function audit(
  projectId: string,
  actor: string,
  action: string,
  detail: string,
) {
  await save<AuditEvent>("audit", {
    id: randomUUID(),
    projectId,
    actor,
    action,
    detail,
    createdAt: new Date().toISOString(),
  });
}
export async function health() {
  if (mongoEnabled()) {
    await initializeMongo();
    await (await mongoDatabase()).command({ ping: 1 });
  } else local.db().prepare("SELECT 1").get();
}
export async function prepareDrawing(drawing: Drawing) {
  const prepared = mongoEnabled()
    ? await prepareMongoDrawing(drawing)
    : { data: drawing, modelFileId: undefined };
  return {
    save: async (info?: Pick<Drawing, "name" | "revision" | "discipline">) => {
      if (mongoEnabled())
        await mongoSave(
          "drawing",
          { ...prepared.data, ...info },
          prepared.modelFileId,
        );
      else await save("drawing", { ...drawing, ...info });
    },
    discard: async () => {
      if (prepared.modelFileId)
        await deleteMongoFile(prepared.modelFileId).catch(() => {});
    },
  };
}
export async function writeOriginal(drawing: Drawing, buffer: Buffer) {
  if (mongoEnabled())
    drawing.fileId = await uploadMongoFile(drawing.name, buffer);
  else
    await writeFile(
      join(
        local.dataDir(),
        "uploads",
        `${drawing.id}.${drawing.format.toLowerCase()}`,
      ),
      buffer,
      { flag: "wx" },
    );
}
export async function readOriginal(drawing: Drawing): Promise<Buffer> {
  if (mongoEnabled()) {
    if (!drawing.fileId) throw new Error("Drawing original is missing.");
    return downloadMongoFile(drawing.fileId, 30 * 1024 * 1024);
  }
  return readFile(
    join(
      local.dataDir(),
      "uploads",
      `${drawing.id}.${drawing.format.toLowerCase()}`,
    ),
  );
}
export async function removeOriginal(drawing: Drawing) {
  if (mongoEnabled()) {
    if (drawing.fileId) await deleteMongoFile(drawing.fileId);
  } else
    await unlink(
      join(
        local.dataDir(),
        "uploads",
        `${drawing.id}.${drawing.format.toLowerCase()}`,
      ),
    );
}
// A write inside the analysis transaction prevents concurrent deletion or editing
// of a source from committing while a new analysis references it.
export async function lockDrawing(id: string) {
  if (mongoEnabled()) {
    const result = await (await mongoDatabase())
      .collection<Document & { _id: string }>("records")
      .updateOne(
        { _id: id, kind: "drawing", ownerId: ownerId() },
        { $inc: { sourceVersion: 1 } },
        mongoOptions(),
      );
    if (!result.matchedCount) throw new HttpError("Drawing not found.", 404);
  } else if (!(await get("drawing", id)))
    throw new HttpError("Drawing not found.", 404);
}
export async function updateDrawingInfo(
  id: string,
  input: Pick<Drawing, "name" | "revision" | "discipline">,
) {
  if (mongoEnabled()) {
    await (await mongoDatabase())
      .collection<Document & { _id: string }>("records")
      .updateOne(
        { _id: id, kind: "drawing", ownerId: ownerId() },
        {
          $set: {
            "data.name": input.name,
            "data.revision": input.revision,
            "data.discipline": input.discipline,
          },
        },
        mongoOptions(),
      );
  } else {
    const drawing = await get<Drawing>("drawing", id);
    if (!drawing) throw new HttpError("Drawing not found.", 404);
    await save("drawing", { ...drawing, ...input });
  }
}
export async function removeDrawingRecord(
  id: string,
): Promise<string | undefined> {
  if (mongoEnabled()) {
    const row = await (await mongoDatabase())
      .collection<Document & { _id: string }>("records")
      .findOneAndDelete(
        { _id: id, kind: "drawing", ownerId: ownerId() },
        mongoOptions(),
      );
    if (!row) throw new HttpError("Drawing not found.", 404);
    return row.modelFileId;
  }
  local
    .db()
    .prepare("DELETE FROM records WHERE id=? AND kind='drawing' AND ownerId=?")
    .run(id, ownerId());
}
export async function removeDrawingFiles(
  drawing: Drawing,
  modelFileId?: string,
) {
  const results = await Promise.allSettled([
    removeOriginal(drawing),
    ...(modelFileId ? [deleteMongoFile(modelFileId)] : []),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
