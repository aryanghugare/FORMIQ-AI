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
const execute = promisify(execFile);
export const converterAvailable = () =>
  Boolean(process.env.ODA_CONVERTER_PATH || process.env.DWG_CONVERTER_PATH);
export async function convertDwg(buffer: Buffer): Promise<string> {
  if (!converterAvailable())
    throw new Error(
      "DWG conversion is not configured. Configure ODA_CONVERTER_PATH or export an ASCII DXF from AutoCAD.",
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
    if (process.env.ODA_CONVERTER_PATH)
      await execute(
        process.env.ODA_CONVERTER_PATH,
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
      await execute(process.env.DWG_CONVERTER_PATH!, [source, target], {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
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
