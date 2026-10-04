import { randomBytes, createHash, timingSafeEqual, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./errors";
import { cookies } from "next/headers";
import { db } from "./db";
import type { User } from "./types";
export const SESSION_COOKIE = "formiq_session";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function userForToken(token?: string): User | undefined {
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
export async function login(
  email: string,
  password: string,
): Promise<{ user: User; token: string } | undefined> {
  const key = email.trim().toLowerCase(),
    now = Date.now();
  // Reserve an attempt before the asynchronous password derivation. Parallel requests
  // must not all read the same count and bypass throttling.
  const attempt = db()
    .prepare(
      `INSERT INTO login_attempts (key,count,expires) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN login_attempts.expires>? THEN login_attempts.count+1 ELSE 1 END,
      expires=CASE WHEN login_attempts.expires>? THEN login_attempts.expires ELSE excluded.expires END
    RETURNING count,expires`,
    )
    .get(key, now + 15 * 60 * 1000, now, now) as {
    count: number;
    expires: number;
  };
  if (attempt.count > 10)
    throw new HttpError(
      "Too many login attempts. Try again in 15 minutes.",
      429,
    );
  db().prepare("DELETE FROM login_attempts WHERE expires<=?").run(now);
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
  db().prepare("DELETE FROM login_attempts WHERE key=?").run(key);
  db().prepare("DELETE FROM sessions WHERE expires<=?").run(now);
  const token = randomBytes(32).toString("hex");
  db()
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(digest(token), user.id, now + 7 * 24 * 60 * 60 * 1000);
  return { user: { id: user.id, name: user.name, email: user.email }, token };
}
export function logout(token?: string) {
  if (token)
    db().prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
}
export const secureCookie = () =>
  process.env.FORMIQ_SECURE_COOKIES === "true" ||
  (process.env.NODE_ENV === "production" &&
    process.env.FORMIQ_SECURE_COOKIES !== "false");
