import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { formatTimestamp, formatNumber } from "../lib/format";
test("server and browser formatting does not depend on runtime locale or time zone", () => {
  const code = `const f=require('./lib/format.ts');console.log(JSON.stringify([f.formatTimestamp('2026-10-04T20:30:00Z'),f.formatDate('2026-10-04T20:30:00Z'),f.formatNumber(1000.123)]))`;
  const render = (tz: string, lang: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "-e", code], {
      env: { ...process.env, TZ: tz, LANG: lang },
      encoding: "utf8",
    }).trim();
  assert.equal(
    render("UTC", "en_US.UTF-8"),
    render("America/Los_Angeles", "de_DE.UTF-8"),
  );
  assert.ok(formatTimestamp("2026-10-04T20:30:00Z").includes("5 Oct 2026"));
  assert.equal(formatNumber(1000.123), "1,000.123");
});
