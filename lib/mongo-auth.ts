import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import type { Document } from "mongodb";
import {
  initializeMongo,
  mongoDatabase,
  mongoOptions,
  mongoTransaction,
} from "./mongo";
import { HttpError } from "./errors";
import type { User } from "./types";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derive = promisify(scrypt);
export async function mongoRegister(
  name: string,
  email: string,
  password: string,
): Promise<{ user: User; token: string }> {
  await initializeMongo();
  const db = await mongoDatabase(),
    salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 64)) as Buffer;
  const user = {
    id: randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
  };
  const token = randomBytes(32).toString("hex");
  await mongoTransaction(async () => {
    await db
      .collection<Document & { _id: string }>("users")
      .insertOne(
        {
          _id: user.id,
          name: user.name,
          email: user.email,
          salt,
          hash: hash.toString("hex"),
        },
        mongoOptions(),
      );
    await db
      .collection<Document & { _id: string }>("sessions")
      .insertOne(
        {
          _id: digest(token),
          userId: user.id,
          credentialVersion: salt,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
        mongoOptions(),
      );
  });
  return { user, token };
}
export async function mongoUserForToken(
  token?: string,
): Promise<User | undefined> {
  if (!token) return;
  await initializeMongo();
  const db = await mongoDatabase();
  const session = await db
    .collection<Document & { _id: string }>("sessions")
    .findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
  if (!session) return;
  const user = await db
    .collection<Document & { _id: string }>("users")
    .findOne({ _id: session.userId });
  return user && user.salt === session.credentialVersion
    ? { id: String(user._id), name: user.name, email: user.email }
    : undefined;
}
export async function mongoLogin(
  email: string,
  password: string,
): Promise<{ user: User; token: string } | undefined> {
  await initializeMongo();
  const db = await mongoDatabase(),
    key = email.trim().toLowerCase(),
    now = new Date();
  const attempts = db.collection<Document & { _id: string }>("login_attempts");
  const expired = { $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, now] };
  const attempt = await attempts.findOneAndUpdate(
    { _id: digest(key) },
    [
      {
        $set: {
          count: {
            $cond: [expired, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }],
          },
          expiresAt: {
            $cond: [
              expired,
              new Date(now.getTime() + 15 * 60000),
              "$expiresAt",
            ],
          },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  if ((attempt?.count ?? 0) > 10)
    throw new HttpError(
      "Too many login attempts. Try again in 15 minutes.",
      429,
    );
  const account = await db
    .collection<Document & { _id: string }>("users")
    .findOne({ email: key });
  const hash = (await derive(
    password,
    account?.salt ?? "formiq-unknown-account",
    64,
  )) as Buffer;
  const expected = Buffer.from(account?.hash ?? "", "hex");
  if (
    !account ||
    expected.length !== hash.length ||
    !timingSafeEqual(hash, expected)
  )
    return;
  const token = randomBytes(32).toString("hex");
  await db.collection<Document & { _id: string }>("sessions").insertOne({
    _id: digest(token),
    userId: account._id,
    credentialVersion: account.salt,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  await attempts.deleteOne({ _id: digest(key) });
  return {
    token,
    user: { id: String(account._id), name: account.name, email: account.email },
  };
}
export async function mongoLogout(token?: string) {
  if (token)
    await (await mongoDatabase())
      .collection<Document & { _id: string }>("sessions")
      .deleteOne({ _id: digest(token) });
}
