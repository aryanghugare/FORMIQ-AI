import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { converterAvailable, convertDwg } from "../lib/converter";
import { parseDxf } from "../lib/cad";
import { demoDxf } from "../lib/demo";

test("LibreDWG adapter checks executable availability, passes native CLI arguments and cleans temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "formiq-converter-"));
  const previous = { ...process.env };
  try {
    delete process.env.ODA_CONVERTER_PATH;
    delete process.env.DWG_CONVERTER_PATH;
    const binary = join(dir, "dwg2dxf");
    process.env.LIBREDWG_CONVERTER_PATH = binary;
    assert.equal(converterAvailable(), false);
    writeFileSync(
      binary,
      `#!${process.execPath}\nconst fs=require('node:fs'); const assert=require('node:assert/strict'); const args=process.argv.slice(2); assert.deepEqual(args.slice(0,3),['-v0','-y','-o']); assert.equal(args.length,5); assert.equal(fs.readFileSync(args[4]).toString(),'AC1032 test'); fs.writeFileSync(${JSON.stringify(join(dir, "source-path"))},args[4]); fs.writeFileSync(args[3],${JSON.stringify(demoDxf("new"))});`,
    );
    chmodSync(binary, 0o600);
    assert.equal(converterAvailable(), false);
    chmodSync(binary, 0o700);
    assert.equal(converterAvailable(), true);
    const dxf = await convertDwg(Buffer.from("AC1032 test"));
    assert.equal(
      parseDxf(dxf).measurements.find((m) => m.tag === "D14")?.value,
      1000,
    );
    const { readFileSync } = await import("node:fs");
    assert.equal(
      existsSync(readFileSync(join(dir, "source-path"), "utf8")),
      false,
    );
    writeFileSync(binary, `#!${process.execPath}\nprocess.exit(0);`);
    await assert.rejects(
      convertDwg(Buffer.from("AC1032 test")),
      /produced no DXF/,
    );
    process.env.ODA_CONVERTER_PATH = join(dir, "invalid-explicit-override");
    assert.equal(converterAvailable(), false);
  } finally {
    for (const name of [
      "ODA_CONVERTER_PATH",
      "DWG_CONVERTER_PATH",
      "LIBREDWG_CONVERTER_PATH",
    ]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
