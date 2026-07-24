import { defineConfig, devices } from "@playwright/test";
import { spawnSync } from "node:child_process";

function parsePort(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `SNACKPAGE_PLAYWRIGHT_PORT must be an integer from 1024 to 65535; got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

function portIsFree(port: number): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      [
        'const net = require("node:net");',
        "const server = net.createServer();",
        'server.once("error", () => process.exit(1));',
        'server.listen(Number(process.argv[1]), "127.0.0.1", () => {',
        "  server.close(() => process.exit(0));",
        "});",
      ].join("\n"),
      String(port),
    ],
    { timeout: 2_000 },
  );
  return probe.status === 0;
}

function choosePort(): number {
  const configured = parsePort(process.env.SNACKPAGE_PLAYWRIGHT_PORT);
  if (configured !== null) return configured;

  const first = 20_000 + ((process.pid * 7_919) % 30_000);
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = 20_000 + ((first - 20_000 + offset) % 30_000);
    if (portIsFree(candidate)) return candidate;
  }
  throw new Error("could not find a free Playwright server port");
}

const PORT = choosePort();
// Playwright evaluates the config in its worker processes too. Persist the
// main process's choice into the environment so every worker, baseURL, and
// webServer command in this invocation reuses the same port.
process.env.SNACKPAGE_PLAYWRIGHT_PORT ??= String(PORT);
const RUN_ID = process.env.SNACKPAGE_PLAYWRIGHT_RUN_ID || String(process.pid);
process.env.SNACKPAGE_PLAYWRIGHT_RUN_ID ??= RUN_ID;
const URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  outputDir: `test-results/${RUN_ID}`,
  fullyParallel: false, // single shared server
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 15_000,

  use: {
    baseURL: URL,
    headless: true,
    trace: "off",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox-smoke",
      grep: /@smoke/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-smoke",
      grep: /@smoke/,
      use: { ...devices["Desktop Safari"] },
    },
  ],

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
