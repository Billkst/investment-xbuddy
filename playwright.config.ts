import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 12000 },
  reporter: "list",
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://127.0.0.1:5173",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
