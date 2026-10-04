import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
const execute = promisify(execFile);
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function findExecutable(path: string): string | undefined {
  const paths =
    path.includes("/") || path.includes("\\")
      ? [resolve(path)]
      : (process.env.PATH || "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, path));
  return paths.find(executable);
}
function converter():
  | { kind: "oda" | "custom" | "libredwg"; path: string }
  | undefined {
  // Explicit settings take precedence; an invalid path must not appear configured.
  for (const [key, kind] of [
    ["ODA_CONVERTER_PATH", "oda"],
    ["DWG_CONVERTER_PATH", "custom"],
    ["LIBREDWG_CONVERTER_PATH", "libredwg"],
  ] as const) {
    const configured = process.env[key]?.trim();
    if (configured) {
      const path = findExecutable(configured);
      return path ? { kind, path } : undefined;
    }
  }
  const native = [
    "dwg2dxf",
    "/opt/homebrew/bin/dwg2dxf",
    "/usr/local/bin/dwg2dxf",
  ]
    .map(findExecutable)
    .find(Boolean);
  if (native) return { kind: "libredwg", path: native };
  const oda =
    "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter";
  return executable(oda) ? { kind: "oda", path: oda } : undefined;
}
export const converterAvailable = () => Boolean(converter());
export async function convertDwg(buffer: Buffer): Promise<string> {
  const selected = converter();
  if (!selected)
    throw new Error(
      "No executable DWG converter found. Use the Docker app (converter included), install LibreDWG, or configure ODA_CONVERTER_PATH.",
    );
  const dir = await mkdtemp(join(tmpdir(), "formiq-dwg-"));
  try {
    const input = join(dir, "input"),
      output = join(dir, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(input);
    await mkdir(output);
    const source = join(input, "drawing.dwg"),
      target = join(output, "drawing.dxf");
    await writeFile(source, buffer);
    if (selected.kind === "oda")
      await execute(
        selected.path,
        [input, output, "ACAD2018", "DXF", "0", "1", "*.dwg"],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM || "offscreen",
          },
        },
      );
    else
      await execute(
        selected.path,
        selected.kind === "libredwg"
          ? ["-v0", "-y", "-o", target, source]
          : [source, target],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      );
    const filename = (await readdir(output)).find((f) =>
      f.toLowerCase().endsWith(".dxf"),
    );
    if (!filename)
      throw new Error(
        "Converter produced no DXF. Verify the converter installation.",
      );
    const outputPath = join(output, filename);
    if ((await stat(outputPath)).size > 50 * 1024 * 1024)
      throw new Error("Converted DXF exceeds the 50 MB processing limit.");
    return await readFile(outputPath, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e)
      throw new Error(
        "DWG conversion failed. Check the converter path, executable permissions and DWG compatibility.",
      );
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
