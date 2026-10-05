import { createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import type { Document } from "mongodb";
import { db, transaction } from "./db";
import {
  initializeMongo,
  mongoDatabase,
  mongoEnabled,
  mongoOptions,
  mongoTransaction,
} from "./mongo";
import { HttpError } from "./errors";
import { smtpMailer, smtpSettings } from "./mail";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derive = promisify(scrypt);
export const RESET_MESSAGE =
  "If an account exists for this email, a password reset link has been sent. Check your inbox and spam folder.";
type ResetRecord = { userId: string; credentialVersion: string };

function emailSettings() {
  const smtp = smtpSettings();
  const origin =
    process.env.FORMIQ_APP_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim();
  if (!smtp || !origin)
    throw new HttpError(
      "Password reset email is not configured. Contact your workspace administrator.",
      503,
    );
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new HttpError(
      "Password reset email is not configured. Contact your workspace administrator.",
      503,
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        (process.env.NODE_ENV !== "production" ||
          process.env.FORMIQ_SECURE_COOKIES === "false") &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new HttpError(
      "Password reset requires a valid public application URL.",
      503,
    );
  return { ...smtp, origin: url.origin };
}

export async function requestPasswordReset(email: string) {
  const settings = emailSettings();
  const normalized = email.trim().toLowerCase();
  const now = Date.now(),
    attemptKey = `password-reset:${digest(normalized)}`;
  let account: { id: string; salt: string } | undefined;
  if (mongoEnabled()) {
    await initializeMongo();
    const store = await mongoDatabase();
    const expired = {
      $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, new Date(now)],
    };
    const attempt = await store
      .collection<Document & { _id: string }>("login_attempts")
      .findOneAndUpdate(
        { _id: attemptKey },
        [
          {
            $set: {
              count: {
                $cond: [expired, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }],
              },
              expiresAt: {
                $cond: [expired, new Date(now + 15 * 60000), "$expiresAt"],
              },
            },
          },
        ],
        { upsert: true, returnDocument: "after" },
      );
    // Return the same response for throttled, unknown and known accounts.
    if ((attempt?.count ?? 0) > 3) return;
    const user = await store
      .collection<Document & { _id: string }>("users")
      .findOne({ email: normalized });
    if (user) account = { id: user._id, salt: user.salt };
  } else {
    db().prepare("DELETE FROM password_resets WHERE expires<=?").run(now);
    db().prepare("DELETE FROM login_attempts WHERE expires<=?").run(now);
    const attempt = db()
      .prepare(
        `INSERT INTO login_attempts (key,count,expires) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.expires>? THEN login_attempts.count+1 ELSE 1 END,
      expires=CASE WHEN login_attempts.expires>? THEN login_attempts.expires ELSE excluded.expires END RETURNING count`,
      )
      .get(attemptKey, now + 15 * 60000, now, now);
    if (Number(attempt?.count) > 3) return;
    const user = db()
      .prepare("SELECT id,salt FROM users WHERE email=?")
      .get(normalized);
    if (user) account = { id: String(user.id), salt: String(user.salt) };
  }
  if (!account) return;
  const token = randomBytes(32).toString("hex"),
    tokenHash = digest(token);
  if (mongoEnabled()) {
    await (await mongoDatabase())
      .collection<Document & { _id: string }>("password_resets")
      .insertOne({
        _id: tokenHash,
        userId: account.id,
        credentialVersion: account.salt,
        expiresAt: new Date(now + 30 * 60000),
      });
  } else
    db()
      .prepare(
        "INSERT INTO password_resets (token,userId,credentialVersion,expires) VALUES (?,?,?,?)",
      )
      .run(tokenHash, account.id, account.salt, now + 30 * 60000);
  const link = `${settings.origin}/reset-password#token=${token}`;
  try {
    await smtpMailer.createTransport(settings.options).sendMail({
      from: settings.from,
      to: [normalized],
      subject: "Reset your Kumkang Kind Ai'Tech password",
      text: `Use this link to choose a new password:\n\n${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, ignore this email.`,
    });
  } catch {
    if (mongoEnabled())
      await (await mongoDatabase())
        .collection<Document & { _id: string }>("password_resets")
        .deleteOne({ _id: tokenHash });
    else
      db().prepare("DELETE FROM password_resets WHERE token=?").run(tokenHash);
    // Do not expose provider responses, tokens or account existence.
    console.error(
      "Password reset email delivery failed. Check the email provider configuration.",
    );
  }
}

export async function resetPassword(token: string, password: string) {
  const invalid = () =>
    new HttpError(
      "This reset link is invalid or expired. Request a new link.",
      400,
    );
  const tokenHash = digest(token),
    now = Date.now();
  let record: ResetRecord | undefined;
  if (mongoEnabled()) {
    await initializeMongo();
    const row = await (await mongoDatabase())
      .collection<Document & { _id: string }>("password_resets")
      .findOne({ _id: tokenHash, expiresAt: { $gt: new Date(now) } });
    if (row)
      record = { userId: row.userId, credentialVersion: row.credentialVersion };
  } else
    record = db()
      .prepare(
        "SELECT userId,credentialVersion FROM password_resets WHERE token=? AND expires>?",
      )
      .get(tokenHash, now) as ResetRecord | undefined;
  if (!record) throw invalid();
  const salt = randomBytes(16).toString("hex");
  const hash = ((await derive(password, salt, 64)) as Buffer).toString("hex");
  const found = record;
  if (mongoEnabled()) {
    await mongoTransaction(async () => {
      const store = await mongoDatabase(),
        options = mongoOptions();
      const removed = await store
        .collection<Document & { _id: string }>("password_resets")
        .deleteOne({ _id: tokenHash, expiresAt: { $gt: new Date() } }, options);
      if (!removed.deletedCount) throw invalid();
      const updated = await store
        .collection<Document & { _id: string }>("users")
        .updateOne(
          { _id: found.userId, salt: found.credentialVersion },
          { $set: { salt, hash } },
          options,
        );
      if (!updated.matchedCount) throw invalid();
      await store
        .collection("sessions")
        .deleteMany({ userId: found.userId }, options);
      await store
        .collection("password_resets")
        .deleteMany({ userId: found.userId }, options);
      await store
        .collection<Document & { _id: string }>("login_attempts")
        .deleteOne(
          {
            _id: digest(
              String(
                (await store
                  .collection<Document & { _id: string }>("users")
                  .findOne({ _id: found.userId }, options))!.email,
              ),
            ),
          },
          options,
        );
    });
  } else
    transaction(() => {
      const removed = db()
        .prepare("DELETE FROM password_resets WHERE token=? AND expires>?")
        .run(tokenHash, Date.now());
      if (!removed.changes) throw invalid();
      const updated = db()
        .prepare("UPDATE users SET salt=?,hash=? WHERE id=? AND salt=?")
        .run(salt, hash, found.userId, found.credentialVersion);
      if (!updated.changes) throw invalid();
      db().prepare("DELETE FROM sessions WHERE userId=?").run(found.userId);
      db()
        .prepare("DELETE FROM password_resets WHERE userId=?")
        .run(found.userId);
      db()
        .prepare(
          "DELETE FROM login_attempts WHERE key=(SELECT email FROM users WHERE id=?)",
        )
        .run(found.userId);
    });
}
