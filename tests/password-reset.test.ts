import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../app/api/[...path]/route";
import { register, login, userForToken } from "../lib/auth";
import { db } from "../lib/db";
import { RESET_MESSAGE } from "../lib/password-reset";
import { smtpMailer, smtpSettings, type MailMessage } from "../lib/mail";

const directory = mkdtempSync(join(tmpdir(), "kumkang-reset-"));
process.env.FORMIQ_DATA_DIR = directory;
process.env.FORMIQ_DEMO = "true";
process.env.FORMIQ_APP_URL = "https://workspace.example.com";
process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_PORT = "587";
process.env.SMTP_SECURE = "false";
process.env.SMTP_USER = "reset@example.com";
process.env.SMTP_PASSWORD = "test-only-password";
process.env.PASSWORD_RESET_FROM = "Workspace <reset@example.com>";
delete process.env.MONGODB_URI;
const originalCreateTransport = smtpMailer.createTransport;
const sent: MailMessage[] = [];
let deliveryFails = false;
smtpMailer.createTransport = (options) => {
  assert.equal(options.host, "smtp.example.com");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  return {
    async sendMail(message) {
      sent.push(message);
      if (deliveryFails) throw new Error("Test SMTP delivery failure");
      return { messageId: "test-email" };
    },
  };
};
after(() => {
  smtpMailer.createTransport = originalCreateTransport;
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
const call = (
  path: string,
  body: unknown,
  origin = "https://workspace.example.com",
) =>
  POST(
    new NextRequest(`https://workspace.example.com/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: ["auth", path] }) },
  );
const latestToken = () => {
  const match = sent
    .at(-1)!
    .text.match(
      /https:\/\/workspace\.example\.com\/reset-password#token=([a-f0-9]{64})/,
    );
  assert.ok(match);
  return match[1];
};

test("reset links are hashed, one-time, revoke sessions and retain account identity", async () => {
  const account = await register(
    "Kiran",
    "kiran@example.com",
    "Original-password-123",
  );
  const response = await call("forgot-password", {
    email: "KIRAN@example.com",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message, RESET_MESSAGE);
  const token = latestToken(),
    hash = createHash("sha256").update(token).digest("hex");
  assert.ok(
    db().prepare("SELECT token FROM password_resets WHERE token=?").get(hash),
  );
  assert.equal(
    db().prepare("SELECT token FROM password_resets WHERE token=?").get(token),
    undefined,
  );
  assert.ok(await userForToken(account.token));
  const reset = await call("reset-password", {
    token,
    password: "New-password-456",
  });
  assert.equal(reset.status, 200);
  assert.match(reset.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(await userForToken(account.token), undefined);
  assert.equal(
    await login("kiran@example.com", "Original-password-123"),
    undefined,
  );
  assert.equal(
    (await login("kiran@example.com", "New-password-456"))?.user.id,
    account.user.id,
  );
  assert.equal(
    (await call("reset-password", { token, password: "Another-password-789" }))
      .status,
    400,
  );
});
test("unknown addresses receive the same response and no reset token", async () => {
  const count = sent.length;
  const response = await call("forgot-password", {
    email: "unknown@example.com",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message, RESET_MESSAGE);
  assert.equal(sent.length, count);
});
test("expired links and tokens invalidated by an operator password change are rejected", async () => {
  const account = await register(
    "Expiry",
    "expiry@example.com",
    "Original-password-123",
  );
  await call("forgot-password", { email: account.user.email });
  const expired = latestToken();
  db()
    .prepare("UPDATE password_resets SET expires=0 WHERE userId=?")
    .run(account.user.id);
  assert.equal(
    (
      await call("reset-password", {
        token: expired,
        password: "New-password-456",
      })
    ).status,
    400,
  );
  await call("forgot-password", { email: account.user.email });
  const stale = latestToken();
  db()
    .prepare("UPDATE users SET salt='operator-changed-salt' WHERE id=?")
    .run(account.user.id);
  assert.equal(
    (
      await call("reset-password", {
        token: stale,
        password: "New-password-456",
      })
    ).status,
    400,
  );
});
test("reset requests are throttled and failed delivery tokens are removed", async () => {
  const account = await register(
    "Limit",
    "limit@example.com",
    "Original-password-123",
  );
  const count = sent.length;
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await call("forgot-password", { email: account.user.email })).status,
      200,
    );
  assert.equal(sent.length - count, 3);
  deliveryFails = true;
  const failed = await register(
    "Failure",
    "failure@example.com",
    "Original-password-123",
  );
  assert.equal(
    (await call("forgot-password", { email: failed.user.email })).status,
    200,
  );
  assert.equal(
    db()
      .prepare("SELECT token FROM password_resets WHERE userId=?")
      .get(failed.user.id),
    undefined,
  );
  deliveryFails = false;
});
test("reset rejects cross-origin writes, invalid tokens and short passwords", async () => {
  assert.equal(
    (
      await call(
        "forgot-password",
        { email: "kiran@example.com" },
        "https://attacker.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("reset-password", {
        token: "bad",
        password: "New-password-456",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("reset-password", { token: "0".repeat(64), password: "short" }))
      .status,
    400,
  );
  delete process.env.SMTP_PASSWORD;
  assert.equal(
    (await call("forgot-password", { email: "kiran@example.com" })).status,
    503,
  );
  process.env.SMTP_PASSWORD = "test-only-password";
});

test("SMTP supports direct TLS and rejects incorrect TLS settings or sender injection", () => {
  const saved = {
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE,
    from: process.env.PASSWORD_RESET_FROM,
  };
  try {
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    assert.equal(smtpSettings()?.options.secure, true);
    process.env.SMTP_SECURE = "false";
    assert.equal(smtpSettings(), undefined);
    process.env.SMTP_PORT = "587";
    process.env.SMTP_SECURE = "true";
    assert.equal(smtpSettings(), undefined);
    process.env.SMTP_SECURE = "false";
    process.env.PASSWORD_RESET_FROM =
      "reset@example.com\r\nBcc: attacker@example.com";
    assert.equal(smtpSettings(), undefined);
    delete process.env.PASSWORD_RESET_FROM;
    assert.equal(smtpSettings()?.from, process.env.SMTP_USER);
  } finally {
    process.env.SMTP_PORT = saved.port;
    process.env.SMTP_SECURE = saved.secure;
    process.env.PASSWORD_RESET_FROM = saved.from;
  }
});
