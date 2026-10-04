import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const run = (args) =>
  spawnSync("docker", args, { stdio: "ignore", timeout: 10_000 });
const ready = () => run(["info"]).status === 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  if (run(["--version"]).status !== 0)
    throw new Error(
      "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/",
    );
  if (!existsSync(".env"))
    throw new Error(
      "Create .env from .env.example and set MONGODB_URI before starting.",
    );
  // Parse .env without printing the database credentials or shell-evaluating it.
  process.loadEnvFile(resolve(root, ".env"));
  if (!process.env.MONGODB_URI?.trim())
    throw new Error(
      "Set MONGODB_URI in .env. This command runs the real workspace, without demo data.",
    );
  if (!ready()) {
    console.log("Starting Docker…");
    const start =
      process.platform === "darwin"
        ? spawnSync("open", ["-a", "Docker"], { stdio: "ignore" })
        : process.platform === "win32"
          ? spawnSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-Command",
                "Start-Process -FilePath 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'",
              ],
              { stdio: "ignore" },
            )
          : spawnSync("systemctl", ["--user", "start", "docker"], {
              stdio: "ignore",
            });
    if (start.status !== 0)
      throw new Error(
        "Could not start Docker automatically. Start Docker Desktop (or your Docker service), then rerun this command.",
      );
    const deadline = Date.now() + 120_000;
    while (!ready() && Date.now() < deadline) {
      console.log("Waiting for Docker to be ready…");
      await sleep(5_000);
    }
    if (!ready())
      throw new Error(
        "Docker did not become ready within 2 minutes. Check Docker Desktop and rerun.",
      );
  }
  if (run(["compose", "version"]).status !== 0)
    throw new Error("Docker Compose v2 is required. Update Docker Desktop.");
  console.log(
    "Building and starting Kumkang Kind Ai'Tech with DWG conversion. Stop npm run dev first if it uses port 3000.",
  );
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "-f",
        "compose.local.yaml",
        "up",
        "-d",
        "--build",
        "--wait",
        "--wait-timeout",
        "180",
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0)
    throw new Error(
      "Docker startup failed. Check the build output, port 3000, and MongoDB access. Logs: npm run docker:logs",
    );
  console.log(
    "Kumkang Kind Ai'Tech is ready: http://localhost:3000\nRefresh Drawing library and click Retry on your saved DWG.\nStop the app: npm run docker:stop",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
