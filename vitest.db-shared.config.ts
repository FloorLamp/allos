import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// SPIKE: the shared-module-registry half of the DB tier.
//
// The isolated tier (vitest.db.config.ts) pays a large fixed cost per test file:
// importing lib/db.ts pulls the 178 migration modules and boots a database as a
// module side effect, and with `isolate: true` that happens once for EVERY file.
// Measured on this suite it dominates the run — actual test execution is a
// minority of the wall clock.
//
// This config runs the mock-free specs with `isolate: false`, so a worker imports
// that graph ONCE and reuses it. Per-file database isolation is preserved by
// lib/__db_tests__/setup-shared.ts, which reseeds from a pre-migrated template
// and rebinds the singleton before each file.
//
// It is deliberately a SEPARATE config rather than a replacement: files that call
// vi.mock() cannot run under a shared registry (a module another file already
// evaluated cannot be re-mocked), and every lib/__action_tests__ spec depends on
// the global auth / next-cache mocks in its setup file. Those keep running on the
// isolated config. Together the two configs cover the same specs as `test:db`.
const root = fileURLToPath(new URL(".", import.meta.url));
const specDir = path.join(root, "lib", "__db_tests__");

// Files that mock modules are excluded by SCANNING rather than by a hand-kept
// list, so adding a vi.mock() to a spec moves it to the isolated tier
// automatically instead of making it fail mysteriously here.
function mockUsingSpecs(): string[] {
  const entries = fs.readdirSync(specDir, {
    withFileTypes: true,
    recursive: true,
  });
  const specs: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (!fs.readFileSync(full, "utf8").includes("vi.mock(")) continue;
    specs.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return specs;
}

// A/B switch. `ALLOS_SPIKE_MODE=baseline` runs the SAME spec subset the way main
// runs it today (isolated, forked, per-file migration replay); anything else runs
// the spike. Measuring both through one config guarantees the two sides differ
// only in the mechanism under test and never in which files were selected.
const baseline = process.env.ALLOS_SPIKE_MODE === "baseline";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["lib/__db_tests__/**/*.test.ts"],
    exclude: mockUsingSpecs(),
    // Threads start cheaper than forks, which matters once the per-file boot cost
    // is gone; the baseline keeps vitest's default pool to match main.
    ...(baseline ? {} : { pool: "threads" as const }),
    // The point of the spike. Everything else here exists to make it safe.
    isolate: baseline,
    globalSetup: baseline ? [] : ["lib/__db_tests__/global-setup.ts"],
    // Both modes load the SAME pair vitest.db.config.ts uses. The action setup's
    // auth / next-cache mocks are not optional decoration for this tier: a number
    // of __db_tests__ specs import modules that reach the auth boundary, and
    // dropping it makes them fail for reasons unrelated to isolation. Its mocks
    // are uniform across every file, so a shared registry registering them once
    // per worker is equivalent — unlike a per-file vi.mock, which is why those
    // specs are excluded above.
    setupFiles: baseline
      ? ["lib/__db_tests__/setup.ts", "lib/__action_tests__/setup.ts"]
      : ["lib/__db_tests__/setup-shared.ts", "lib/__action_tests__/setup.ts"],
  },
});
