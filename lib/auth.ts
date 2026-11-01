import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./errors";
import { cookies } from "next/headers";
import { db, transaction } from "./db";
import { mongoEnabled } from "./mongo";
import {
  mongoClearLimits,
  mongoConsumeLimit,
  mongoLogin,
  mongoLogout,
  mongoUserForToken,
  mongoRegister,
} from "./mongo-auth";
import type { User } from "./types";
export const SESSION_COOKIE = "formiq_session";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function userForToken(token?: string): Promise<User | undefined> {
  if (mongoEnabled()) return mongoUserForToken(token);
  if (!token) return;
  const row = db()
    .prepare(
      "SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.userId WHERE s.token=? AND s.expires>?",
    )
    .get(digest(token), Date.now());
  if (!row) return;
  // node:sqlite rows have null prototypes, which React Server Components
  // cannot serialize as client props. Return an explicit public user object.
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
  };
}
export async function currentUser() {
  return userForToken((await cookies()).get(SESSION_COOKIE)?.value);
}
const deriveKey = promisify(scrypt);
export async function register(
  name: string,
  email: string,
  password: string,
): Promise<{ user: User; token: string }> {
  if (mongoEnabled()) return mongoRegister(name, email, password);
  const salt = randomBytes(16).toString("hex"),
    hash = (await deriveKey(password, salt, 64)) as Buffer;
  const user = {
    id: randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
  };
  const token = randomBytes(32).toString("hex");
  transaction(() => {
    db()
      .prepare("INSERT INTO users (id,name,email,salt,hash) VALUES (?,?,?,?,?)")
      .run(user.id, user.name, user.email, salt, hash.toString("hex"));
    db()
      .prepare("INSERT INTO sessions (token,userId,expires) VALUES (?,?,?)")
      .run(digest(token), user.id, Date.now() + 7 * 86400000);
  });
  return { user, token };
}
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
/**
 * With a known client address, failures from one address cannot lock the account for anyone else;
 * the larger account-wide limit still bounds guessing from many addresses. Checks stop at the first
 * limit reached, so an address already blocked no longer counts against the account. Without an
 * address, only the strict account limit is possible.
 */
function attemptLimits(account: string, ip?: string): [string, number][] {
  return ip
    ? [
        [`ip:${ip}`, 200],
        [`${account}|${ip}`, 10],
        [account, 100],
      ]
    : [[account, 10]];
}
/** Counts one attempt against a key; false once the limit is exceeded within the window. */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  if (mongoEnabled()) return mongoConsumeLimit(key, limit, windowMs);
  const now = Date.now();
  const attempt = db()
    .prepare(
      `INSERT INTO login_attempts (key,count,expires) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN login_attempts.expires>? THEN login_attempts.count+1 ELSE 1 END,
      expires=CASE WHEN login_attempts.expires>? THEN login_attempts.expires ELSE excluded.expires END
    RETURNING count`,
    )
    .get(key, now + windowMs, now, now) as { count: number };
  db().prepare("DELETE FROM login_attempts WHERE expires<=?").run(now);
  return attempt.count <= limit;
}
/** 10 accounts per address per hour; a shared budget when the address is unknown. */
export async function reserveRegistration(ip?: string) {
  const allowed = await consumeRateLimit(
    `register:${ip ?? "unknown"}`,
    ip ? 10 : 100,
    REGISTRATION_WINDOW_MS,
  );
  if (!allowed)
    throw new HttpError("Too many new accounts. Try again later.", 429);
}
export async function login(
  email: string,
  password: string,
  ip?: string,
): Promise<{ user: User; token: string } | undefined> {
  const account = email.trim().toLowerCase();
  // Reserve attempts before the asynchronous password derivation. Parallel requests
  // must not all read the same count and bypass throttling.
  const limits = attemptLimits(account, ip);
  for (const [limitKey, limit] of limits)
    if (!(await consumeRateLimit(limitKey, limit, LOGIN_WINDOW_MS)))
      throw new HttpError(
        "Too many login attempts. Try again in 15 minutes.",
        429,
      );
  const session = mongoEnabled()
    ? await mongoLogin(email, password)
    : await localLogin(email, password);
  if (session) {
    const cleared = limits.map(([limitKey]) => limitKey).filter((k) => !k.startsWith("ip:"));
    if (mongoEnabled()) await mongoClearLimits(cleared);
    else
      for (const limitKey of cleared)
        db().prepare("DELETE FROM login_attempts WHERE key=?").run(limitKey);
  }
  return session;
}
async function localLogin(
  email: string,
  password: string,
): Promise<{ user: User; token: string } | undefined> {
  const key = email.trim().toLowerCase(),
    now = Date.now();
  const user = db()
    .prepare("SELECT * FROM users WHERE email=?")
    .get(key) as unknown as (User & { salt: string; hash: string }) | undefined;
  // Always do a password derivation, including unknown accounts.
  const hash = (await deriveKey(
    password,
    user?.salt ?? "formiq-unknown-account",
    64,
  )) as Buffer;
  if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, "hex"))) {
    return;
  }
  // An operator password reset may have completed while scrypt was running.
  if (
    db().prepare("SELECT salt FROM users WHERE id=?").get(user.id)?.salt !==
    user.salt
  )
    return;
  db().prepare("DELETE FROM sessions WHERE expires<=?").run(now);
  const token = randomBytes(32).toString("hex");
  db()
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(digest(token), user.id, now + 7 * 24 * 60 * 60 * 1000);
  return { user: { id: user.id, name: user.name, email: user.email }, token };
}
export async function logout(token?: string) {
  if (mongoEnabled()) return mongoLogout(token);
  if (token)
    db().prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
}
export const secureCookie = () =>
  process.env.FORMIQ_SECURE_COOKIES === "true" ||
  (process.env.NODE_ENV === "production" &&
    process.env.FORMIQ_SECURE_COOKIES !== "false");
