import { defineConfig, devices } from "@playwright/test";

const PORT = 18790;
const URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  fullyParallel: false, // single shared server
  retries: 0,
  reporter: "list",
  timeout: 15_000,

  use: {
    baseURL: URL,
    headless: true,
    trace: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Playwright spawns this before tests and polls its url for readiness.
  webServer: {
    command: `../../snackpage demo --addr 127.0.0.1:${PORT} --log-level error`,
    url: `${URL}/healthz`,
    timeout: 30_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
