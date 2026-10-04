import { spawnSync } from "node:child_process";

const uri = process.env.FORMIQ_MONGO_TEST_URI || process.env.MONGODB_URI;
if (!uri?.trim()) {
  console.error(
    "Set FORMIQ_MONGO_TEST_URI or MONGODB_URI before running the MongoDB verification.",
  );
  process.exitCode = 1;
} else {
  // The integration test uses a fresh formiq_test_* database and removes only that database.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "tests/mongo-integration.test.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, FORMIQ_MONGO_TEST_URI: uri },
    },
  );
  if (result.error) console.error("Could not start MongoDB verification.");
  process.exitCode = result.status ?? 1;
}
