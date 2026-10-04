import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, randomBytes, scryptSync, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";

const source = resolve(process.env.FORMIQ_DATA_DIR || ".formiq");
function open(directory, readOnly = false) {
  const file = join(directory, "formiq.sqlite");
  if (!existsSync(file))
    throw new Error(
      "Workspace database not found. Start the application once with the correct FORMIQ_DATA_DIR.",
    );
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  return db;
}
function drawingFiles(db) {
  return db
    .prepare("SELECT data FROM records WHERE kind='drawing'")
    .all()
    .map((row) => {
      const drawing = JSON.parse(row.data);
      if (
        !/^[a-zA-Z0-9-]+$/.test(drawing.id) ||
        !["DWG", "DXF"].includes(drawing.format)
      )
        throw new Error("Invalid drawing reference in database.");
      return `${drawing.id}.${drawing.format.toLowerCase()}`;
    });
}
async function main() {
  const [command, argument] = process.argv.slice(2);
  if (process.env.MONGODB_URI?.trim()) {
    const { manageMongo } = await import("./manage-mongo.mjs");
    return manageMongo(command);
  }
  if (command === "backup") {
    if (!argument)
      throw new Error(
        "Usage: npm run workspace:manage -- backup /absolute/private/backup-directory",
      );
    const target = resolve(argument);
    if (
      target === source ||
      target.startsWith(source + sep) ||
      existsSync(target)
    )
      throw new Error("Choose a NEW backup directory outside FORMIQ_DATA_DIR.");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const db = open(source, true);
    let complete = false;
    try {
      // SQLite's online backup API includes committed WAL data.
      await backup(db, join(target, "formiq.sqlite"));
      const snapshot = open(target, true);
      let files;
      try {
        files = drawingFiles(snapshot);
      } finally {
        snapshot.close();
      }
      mkdirSync(join(target, "uploads"), { mode: 0o700 });
      for (const name of files)
        copyFileSync(
          join(source, "uploads", name),
          join(target, "uploads", name),
        );
      const names = [
        "formiq.sqlite",
        ...files.map((name) => `uploads/${name}`),
      ];
      const checksums = Object.fromEntries(
        names.map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(target, name)))
            .digest("hex"),
        ]),
      );
      writeFileSync(
        join(target, "manifest.json"),
        JSON.stringify(
          { createdAt: new Date().toISOString(), checksums },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      complete = true;
      console.log(
        `Backup created: ${target} (${files.length} drawings). Copy it to a separate secure machine.`,
      );
    } finally {
      db.close();
      if (!complete) rmSync(target, { recursive: true, force: true });
    }
    return;
  }
  if (command === "verify-backup") {
    if (!argument) throw new Error("Specify the backup directory.");
    const target = resolve(argument),
      manifest = JSON.parse(
        readFileSync(join(target, "manifest.json"), "utf8"),
      );
    const db = open(target, true);
    try {
      if (
        db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new Error("Database integrity check failed.");
      const names = [
        "formiq.sqlite",
        ...drawingFiles(db).map((name) => `uploads/${name}`),
      ];
      for (const name of names)
        if (
          manifest.checksums?.[name] !==
          createHash("sha256")
            .update(readFileSync(join(target, name)))
            .digest("hex")
        )
          throw new Error(`Backup integrity check failed: ${name}`);
      console.log(
        `Backup verified: database and ${names.length - 1} original drawings.`,
      );
    } finally {
      db.close();
    }
    return;
  }
  if (
    !["add-user", "reset-password", "remove-user", "list-users"].includes(
      command,
    )
  )
    throw new Error(
      "Commands: add-user, reset-password, remove-user, list-users, backup <directory>, verify-backup <directory>.",
    );
  const db = open(source);
  try {
    if (command === "list-users") {
      for (const user of db
        .prepare("SELECT name,email FROM users ORDER BY email")
        .all())
        console.log(`${user.name} <${user.email}>`);
      return;
    }
    const email = (process.env.FORMIQ_USER_EMAIL || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)
      throw new Error("Set FORMIQ_USER_EMAIL to a valid address.");
    const existing = db
      .prepare("SELECT id FROM users WHERE email=?")
      .get(email);
    if (command === "add-user" ? existing : !existing)
      throw new Error(
        command === "add-user"
          ? "Account already exists. Use reset-password explicitly."
          : "Account does not exist.",
      );
    let salt, hash;
    const name = (process.env.FORMIQ_USER_NAME || "Team member").trim();
    if (command !== "remove-user") {
      const password = process.env.FORMIQ_USER_PASSWORD || "";
      if (password.length < 12 || password.length > 200)
        throw new Error("Set FORMIQ_USER_PASSWORD to 12–200 characters.");
      if (!name || name.length > 100)
        throw new Error("Use a name of 1–100 characters.");
      salt = randomBytes(16).toString("hex");
      hash = scryptSync(password, salt, 64).toString("hex");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const accountId = existing?.id ?? randomUUID();
      if (command === "add-user")
        db.prepare(
          "INSERT INTO users (id,name,email,salt,hash) VALUES (?,?,?,?,?)",
        ).run(accountId, name, email, salt, hash);
      else {
        if (
          command === "remove-user" &&
          db.prepare("SELECT COUNT(*) AS count FROM users").get().count <= 1
        )
          throw new Error("Cannot remove the last account.");
        db.prepare("DELETE FROM sessions WHERE userId=?").run(existing.id);
        if (command === "reset-password")
          db.prepare("UPDATE users SET salt=?,hash=? WHERE id=?").run(
            salt,
            hash,
            existing.id,
          );
        else db.prepare("DELETE FROM users WHERE id=?").run(existing.id);
      }
      db.prepare("DELETE FROM login_attempts WHERE key=?").run(email);
      const event = {
        id: randomUUID(),
        projectId: "",
        actor: "Workspace administrator (CLI)",
        action: command,
        detail: email,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO records (id,kind,projectId,data,ownerId) VALUES (?,'audit','',?,?)",
      ).run(event.id, JSON.stringify(event), accountId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`Completed ${command} for ${email}.`);
  } finally {
    db.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Workspace command failed.",
  );
  process.exitCode = 1;
});
