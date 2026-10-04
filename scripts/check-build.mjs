import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Next.js rewrites generated types and tsconfig during builds. A different
// distDir alone cannot protect a concurrently running development server.
const source = fileURLToPath(new URL("../", import.meta.url));
const staging = await mkdtemp(path.join(tmpdir(), "formiq-build-check-"));
let status = 1;
try {
  const entries = [
    "app",
    "components",
    "lib",
    "public",
    "tests",
    "scripts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
    "playwright.config.ts",
  ];
  await Promise.all(
    entries.map((entry) =>
      cp(path.join(source, entry), path.join(staging, entry), {
        recursive: true,
      }),
    ),
  );
  // Keep dependencies within the tracing root: a symlink outside it causes
  // standalone output tracing to copy files outside the staging directory.
  await cp(
    path.join(source, "node_modules"),
    path.join(staging, "node_modules"),
    {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    },
  );
  const configPath = path.join(staging, "tsconfig.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.compilerOptions.incremental = false;
  config.include = config.include.filter((entry) => !entry.startsWith(".next"));
  config.include.push(".next/types/**/*.ts", ".next/dev/types/**/*.ts");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(
    "Checking a production build in an isolated temporary workspace.",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(staging, "node_modules/next/dist/bin/next"),
      "build",
      "--webpack",
    ],
    {
      cwd: staging,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        FORMIQ_BUILD_DIR: ".next",
        FORMIQ_DATA_DIR: path.join(staging, ".formiq"),
        FORMIQ_DEMO: "true",
        FORMIQ_ADMIN_EMAIL: "",
        FORMIQ_ADMIN_PASSWORD: "",
        ODA_CONVERTER_PATH: "",
        DWG_CONVERTER_PATH: "",
      },
    },
  );
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
process.exitCode = status;
