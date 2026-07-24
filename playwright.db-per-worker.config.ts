import { defineConfig } from "@playwright/test";
import fs from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// SPIKE (reversible POC): DB-per-worker (server-per-worker) e2e isolation.
//
// This is an ALTERNATE, self-contained config — the main playwright.config.ts is
// untouched. It runs a HANDFUL of representative specs (copied into
// e2e/db-per-worker/*.poc.ts) with workers=2, where EACH worker boots its own seeded
// DB + `next start` server + admin session via the worker-scoped fixture in
// e2e/db-per-worker.fixture.ts. There is deliberately NO top-level `webServer` and NO
// `setup` project / shared `storageState`: the fixture owns booting and per-worker
// auth. Run CI-equivalent:
//
//   CI=1 npx playwright test --config playwright.db-per-worker.config.ts
//
// The `.poc.ts` suffix keeps these copies OUT of the main config's spec glob (which
// matches *.spec.ts), so the default suite never picks them up.
// ─────────────────────────────────────────────────────────────────────────────

function preinstalledChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined;
  const dir = fs
    .readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .at(-1);
  if (!dir) return undefined;
  const exe = `${base}/${dir}/chrome-linux/chrome`;
  return fs.existsSync(exe) ? exe : undefined;
}

const executablePath = preinstalledChromium();

export default defineConfig({
  testDir: "./e2e/db-per-worker",
  testMatch: /\.poc\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The POC point: real parallelism across isolated worker servers/DBs.
  workers: 2,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"]] : "list",
  use: {
    // baseURL + storageState are provided PER WORKER by the fixture
    // (e2e/db-per-worker.fixture.ts) — no static values here on purpose.
    trace: "off",
    viewport: { width: 1280, height: 900 },
    browserName: "chromium",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
