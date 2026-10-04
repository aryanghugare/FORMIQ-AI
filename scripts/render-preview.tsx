import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Workspace from "../components/workspace";
import Login from "../components/login";
import { loadWorkspace } from "../lib/workspace";
import { db } from "../lib/db";
process.env.FORMIQ_DEMO = "true";
process.env.FORMIQ_DATA_DIR = mkdtempSync(
  join(tmpdir(), "formiq-preview-data-"),
);
const css = readFileSync("app/globals.css", "utf8");
const user = db()
  .prepare("SELECT id,name,email FROM users LIMIT 1")
  .get() as unknown as import("../lib/types").User;
for (const [name, component] of [
  ["overview", <Workspace initialData={loadWorkspace(user)} />],
  ["login", <Login demo />],
] as const) {
  writeFileSync(
    join(tmpdir(), `formiq-${name}.html`),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${renderToStaticMarkup(component)}</body></html>`,
  );
}
db().close();
console.log("Static previews written to " + tmpdir());
