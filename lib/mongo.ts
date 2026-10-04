import {
  MongoClient,
  GridFSBucket,
  ObjectId,
  type ClientSession,
  type Document,
} from "mongodb";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { HttpError } from "./errors";
import type { Drawing } from "./types";
import { ownerId } from "./ownership";
export const mongoEnabled = () => Boolean(process.env.MONGODB_URI?.trim());
const state = globalThis as typeof globalThis & {
  formiqMongo?: Promise<MongoClient>;
  formiqMongoInit?: Promise<void>;
};
export async function mongoClient() {
  if (!state.formiqMongo) {
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) throw new Error("MONGODB_URI is required.");
    state.formiqMongo = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    })
      .connect()
      .catch(() => {
        state.formiqMongo = undefined;
        throw new Error(
          "MongoDB connection failed. Check credentials and Atlas network access.",
        );
      });
  }
  return state.formiqMongo;
}
export async function mongoDatabase() {
  return (await mongoClient()).db(process.env.MONGODB_DB || "formiq");
}
export async function initializeMongo() {
  if (!state.formiqMongoInit)
    state.formiqMongoInit = (async () => {
      const db = await mongoDatabase();
      await Promise.all([
        db
          .collection("records")
          .createIndex({ kind: 1, projectId: 1, createdAt: -1 }),
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
        db
          .collection("sessions")
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db
          .collection("login_attempts")
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ]);
      // The earlier single-workspace index must allow the same code in different accounts.
      await db
        .collection("records")
        .dropIndex("projectCode_1")
        .catch((error) => {
          if (error.code !== 27 && error.code !== 26) throw error;
        });
      await db
        .collection("records")
        .createIndex(
          { ownerId: 1, projectCode: 1 },
          { unique: true, partialFilterExpression: { kind: "project" } },
        );
      await db
        .collection("records")
        .createIndex({ ownerId: 1, kind: 1, projectId: 1 });
      if (
        (await db.collection("users").countDocuments({}, { limit: 1 })) === 0
      ) {
        const email = (process.env.FORMIQ_ADMIN_EMAIL || "")
            .trim()
            .toLowerCase(),
          password = process.env.FORMIQ_ADMIN_PASSWORD || "";
        // Public registration can provision the first account without an administrator.
        if (!email && !password) return;
        if (
          !z.email().max(160).safeParse(email).success ||
          password.length < 10 ||
          password.length > 200
        )
          throw new Error(
            "Configure FORMIQ_ADMIN_EMAIL and FORMIQ_ADMIN_PASSWORD (10–200 characters) for the first MongoDB account.",
          );
        const salt = randomBytes(16).toString("hex");
        await db.collection<Document & { _id: string }>("users").updateOne(
          { _id: "initial-admin" },
          {
            $setOnInsert: {
              name: "Design Lead",
              email,
              salt,
              hash: scryptSync(password, salt, 64).toString("hex"),
            },
          },
          { upsert: true },
        );
      }
      const firstUser =
        (await db
          .collection("users")
          .findOne({ _id: "initial-admin" } as Document)) ??
        (await db.collection("users").findOne({}, { sort: { _id: 1 } }));
      if (firstUser)
        await db
          .collection("records")
          .updateMany(
            { ownerId: { $exists: false } },
            { $set: { ownerId: String(firstUser._id) } },
          );
    })().catch((error) => {
      state.formiqMongoInit = undefined;
      throw error;
    });
  await state.formiqMongoInit;
}
const context = new AsyncLocalStorage<ClientSession>();
export const mongoOptions = () => ({ session: context.getStore() });
export async function mongoTransaction<T>(work: () => Promise<T>): Promise<T> {
  await initializeMongo();
  const session = (await mongoClient()).startSession();
  try {
    return (await session.withTransaction(() =>
      context.run(session, work),
    )) as T;
  } finally {
    await session.endSession();
  }
}
async function bucket() {
  return new GridFSBucket(await mongoDatabase(), { bucketName: "drawings" });
}
export async function uploadMongoFile(
  name: string,
  bytes: Buffer,
): Promise<string> {
  const stream = (await bucket()).openUploadStream(name);
  try {
    await pipeline(Readable.from([bytes]), stream);
    return stream.id.toHexString();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}
export async function downloadMongoFile(
  id: string,
  maximum = 80 * 1024 * 1024,
): Promise<Buffer> {
  if (!ObjectId.isValid(id)) throw new HttpError("File not found.", 404);
  const store = await bucket(),
    fileId = new ObjectId(id);
  const metadata = await store.find({ _id: fileId }).next();
  if (!metadata) throw new HttpError("File not found.", 404);
  if (metadata.length > maximum)
    throw new HttpError("Stored file exceeds the processing limit.", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of store.openDownloadStream(fileId)) {
    size += chunk.length;
    if (size > maximum)
      throw new HttpError("Stored file exceeds the processing limit.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
export async function deleteMongoFile(id: string) {
  await (await bucket()).delete(new ObjectId(id));
}
export async function mongoGet<T>(
  kind: string,
  id: string,
): Promise<T | undefined> {
  await initializeMongo();
  const row = await (await mongoDatabase())
    .collection<Document & { _id: string }>("records")
    .findOne({ _id: id, kind, ownerId: ownerId() }, mongoOptions());
  if (!row) return;
  const data = row.data;
  if (kind === "drawing" && row.modelFileId)
    data.model = JSON.parse(
      (await downloadMongoFile(row.modelFileId)).toString(),
    );
  return data as T;
}
export async function mongoList<T>(
  kind: string,
  projectId?: string,
  summaries = false,
): Promise<T[]> {
  await initializeMongo();
  const rows = await (
    await mongoDatabase()
  )
    .collection("records")
    .find(
      {
        kind,
        ownerId: ownerId(),
        ...(projectId === undefined ? {} : { projectId }),
      },
      mongoOptions(),
    )
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  const result: T[] = [];
  for (const row of rows) {
    if (kind === "drawing" && row.modelFileId && !summaries)
      row.data.model = JSON.parse(
        (await downloadMongoFile(row.modelFileId)).toString(),
      );
    result.push(row.data as T);
  }
  return result;
}
/** GridFS writes happen BEFORE transactions; MongoDB does not support GridFS inside a transaction. */
export async function prepareMongoDrawing(
  drawing: Drawing,
): Promise<{ data: Drawing; modelFileId?: string }> {
  const { model, ...metadata } = drawing;
  if (!model) return { data: metadata };
  const bytes = Buffer.from(JSON.stringify(model));
  if (bytes.length > 80 * 1024 * 1024)
    throw new HttpError("Parsed drawing exceeds the 80 MB model limit.", 413);
  const modelFileId = await uploadMongoFile(`${drawing.id}.model.json`, bytes);
  return {
    data: {
      ...metadata,
      extraction: {
        entityCount: model.entityCount,
        measurementCount: model.measurements.length,
        warnings: model.warnings,
        units: model.units,
      },
    },
    modelFileId,
  };
}
export async function mongoSave(
  kind: string,
  data: { id: string; projectId?: string },
  modelFileId?: string,
) {
  await initializeMongo();
  const value = JSON.parse(JSON.stringify(data));
  await (await mongoDatabase())
    .collection<Document & { _id: string }>("records")
    .updateOne(
      { _id: data.id, ownerId: ownerId() },
      {
        $set: {
          kind,
          ownerId: ownerId(),
          projectId: data.projectId ?? "",
          data: value,
          ...(kind === "project"
            ? { projectCode: String(value.code).toLowerCase() }
            : {}),
          ...(modelFileId ? { modelFileId } : {}),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, ...mongoOptions() },
    );
  return data;
}
export async function closeMongo() {
  const client = await state.formiqMongo;
  await client?.close();
  state.formiqMongo = undefined;
  state.formiqMongoInit = undefined;
}
