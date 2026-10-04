import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3011",
    headless: true,
    timezoneId: "America/Los_Angeles",
    locale: "de-DE",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROME_PATH ||
        (existsSync(
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined),
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3011",
    url: "http://localhost:3011/login",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      FORMIQ_DEMO: "true",
      FORMIQ_SECURE_COOKIES: "false",
      FORMIQ_DATA_DIR: ".formiq-e2e",
      FORMIQ_BUILD_DIR: ".next-e2e",
      FORMIQ_ADMIN_EMAIL: "",
      FORMIQ_ADMIN_PASSWORD: "",
    },
  },
});
