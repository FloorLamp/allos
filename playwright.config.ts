import { defineConfig } from "@playwright/test";
import fs from "node:fs";

// Browser end-to-end tier (issue: always browser-test UI features). Separate
// from the pure unit suite (`npm test`, lib/** only) and the DB tier
// (`npm run test:db`): this boots the real Next app against an isolated, seeded
// SQLite DB and drives it in Chromium. Run with `npm run test:e2e`.

// In managed dev environments Chromium is pre-installed and PLAYWRIGHT_BROWSERS_PATH
// points at it (e.g. /opt/pw-browsers); use that binary directly so we don't
// re-download. In CI we run `npx playwright install chromium`, so this returns
// undefined and Playwright falls back to its own managed browser.
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

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Isolated throwaway DB (ALLOS_DB_PATH is the app's test override in lib/db.ts),
// so e2e never touches a developer's data/allos.db.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const executablePath = preinstalledChromium();

// A SECOND app instance booted with ALLOS_DEMO_MODE=1 (#181), on its own port +
// isolated DB, so the demo-mode surfaces (banner, credentials card, disabled
// upload) can be asserted against a real demo boot WITHOUT running the whole suite
// in demo mode — the default-instance specs keep their normal, non-demo server.
const DEMO_PORT = Number(process.env.E2E_DEMO_PORT ?? 3101);
const DEMO_DB_PATH =
  process.env.ALLOS_DEMO_DB_PATH ?? "./e2e/.data/e2e-demo.db";

// Local uses `next dev` (compiles on demand — no prior build needed); CI runs an
// explicit `next build` step first, then `next start` for a production-like run.
const startCmd = process.env.CI
  ? `next start -p ${PORT}`
  : `next dev -p ${PORT}`;
const demoStartCmd = process.env.CI
  ? `next start -p ${DEMO_PORT}`
  : `next dev -p ${DEMO_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // The "github" reporter emits one workflow annotation per failure, so a red CI
  // run names its failing tests in the check-run annotations (readable via API)
  // instead of only inside the job log.
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    // A dependency project that logs in once and saves the session cookie, so
    // the actual specs start authenticated (no per-test login round-trip).
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      // Exclude the demo spec (it targets the separate demo server/baseURL below).
      testIgnore: [/auth\.setup\.ts/, /demo\.spec\.ts/],
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
        storageState: "e2e/.auth/state.json",
      },
    },
    // Demo-mode specs run against the demo webServer (ALLOS_DEMO_MODE=1) on its own
    // baseURL, unauthenticated (they drive the demo login flow themselves).
    {
      name: "demo",
      testMatch: /demo\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
        baseURL: `http://localhost:${DEMO_PORT}`,
      },
    },
  ],
  // Reset + seed the isolated DB, then boot the app against it. seed.ts imports
  // lib/db, which bootstraps the admin login from ADMIN_USERNAME/ADMIN_PASSWORD.
  webServer: [
    {
      command: `rm -f "${DB_PATH}" "${DB_PATH}-shm" "${DB_PATH}-wal" && tsx scripts/seed.ts && tsx e2e/seed-events.ts && ${startCmd}`,
      url: `http://localhost:${PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: {
        ALLOS_DB_PATH: DB_PATH,
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "e2e-admin-pass",
        NODE_ENV: process.env.CI ? "production" : "development",
      },
    },
    // Demo instance (#181): same seed + image, booted with ALLOS_DEMO_MODE=1 so the
    // seed also creates the read-only demo login. Isolated DB + port.
    {
      command: `rm -f "${DEMO_DB_PATH}" "${DEMO_DB_PATH}-shm" "${DEMO_DB_PATH}-wal" && tsx scripts/seed.ts && ${demoStartCmd}`,
      url: `http://localhost:${DEMO_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: {
        ALLOS_DB_PATH: DEMO_DB_PATH,
        ALLOS_DEMO_MODE: "1",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "e2e-admin-pass",
        NODE_ENV: process.env.CI ? "production" : "development",
        // Next 16 dev takes a per-project single-instance lock, so the demo dev
        // server needs its own distDir (see next.config.js). CI runs `next start`
        // (no lock) off the one shared .next build, so this stays dev-only.
        ...(process.env.CI ? {} : { NEXT_DIST_DIR: ".next-demo" }),
      },
    },
  ],
});
