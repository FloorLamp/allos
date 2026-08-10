import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// DB integration tests (a SEPARATE tier from the pure unit suite in
// lib/__tests__). These open real better-sqlite3 handles to exercise code that
// needs a live schema: the migration/upgrade path in lib/db.ts (fresh-boot vs.
// existing-DB "upgrade" divergence a fresh-only suite can't see), and the query
// layer executed against a seeded fixture (catching SQL typos / broken joins /
// scoping leaks the source-scan can't). Run via `npm run test:db`; gated in CI.
// The `@/*` alias mirrors tsconfig.json `paths`, same as vitest.config.ts.
const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "@": root };

// Specs that call vi.mock() themselves. A shared registry cannot re-mock a module
// an earlier file already evaluated, so these run isolated. Found by SCANNING, not
// by a hand-kept list, so adding a vi.mock() to a spec moves it to the isolated
// project automatically instead of making it fail mysteriously.
//
// The setup files' OWN vi.mock calls are fine shared: they are identical for every
// file in the tier, and the spies they install are stable instances
// (lib/__action_tests__/cache-spies.ts), so nothing varies per file.
function mockUsingSpecs(): string[] {
  const specs: string[] = [];
  for (const name of ["__db_tests__", "__action_tests__"]) {
    const dir = path.join(root, "lib", name);
    for (const entry of fs.readdirSync(dir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
      const full = path.join(entry.parentPath, entry.name);
      if (!fs.readFileSync(full, "utf8").includes("vi.mock(")) continue;
      specs.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return specs;
}

// Specs that call process.chdir(). Worker threads reject it outright, and under a
// shared registry it would not be safe even on `forks`: the directory change would
// outlive the file and follow every later spec in that worker. Same carve-out the
// pure tier makes in vitest.config.ts.
const CHDIR_SPECS = ["lib/__action_tests__/ai-log-clear.actions.test.ts"];

const ISOLATED = [...mockUsingSpecs(), ...CHDIR_SPECS];

// Both projects load the same setup pair the tier has always used: the db setup
// points the singleton at a throwaway database, and the action setup adds the auth
// / next-cache mocks the server-action tests need (harmless for the query tests,
// which import neither module). The shared project swaps the first for the variant
// that reseeds and rebinds per file.
const ACTION_SETUP = "lib/__action_tests__/setup.ts";

export default defineConfig({
  resolve: { alias },
  test: {
    // TWO PROJECTS, ONE RUN — so `test:db:coverage` still measures the WHOLE tier
    // in a single pass and the floors below need no cross-report merging.
    //
    // Importing lib/db.ts boots a database and pulls every migration module as a
    // module side effect, and `isolate: true` pays that once per test file. The
    // mock-free specs — the large majority of BOTH directories — instead share one
    // module registry per worker, with per-file isolation preserved by reseeding
    // from a pre-migrated template and rebinding the singleton. Only what a shared
    // registry genuinely cannot host stays isolated: the handful of specs that call
    // vi.mock() themselves, and the one that calls process.chdir().
    projects: [
      {
        resolve: { alias },
        test: {
          name: "db-shared",
          include: [
            "lib/__db_tests__/**/*.test.ts",
            "lib/__action_tests__/**/*.test.ts",
          ],
          exclude: ISOLATED,
          pool: "threads",
          isolate: false,
          globalSetup: ["lib/__db_tests__/global-setup.ts"],
          setupFiles: ["lib/__db_tests__/setup-shared.ts", ACTION_SETUP],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "db-isolated",
          include: ISOLATED,
          setupFiles: ["lib/__db_tests__/setup.ts", ACTION_SETUP],
        },
      },
    ],
    // Coverage for the DB+action tier — a SECOND gate alongside the pure suite's
    // (vitest.config.ts). The pure gate never imports the query/action write paths
    // that need a live schema, so those modules report ~0% there; this tier
    // exercises them and measures its own floor. Same `lib/**` denominator and
    // exclude discipline as the pure gate — one convention, two tiers — so a
    // per-file view could be merged later (see test:db:coverage). Run via
    // `npm run test:db:coverage`; wired into CI's check job.
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      exclude: [
        // Test tiers — not production code.
        "lib/__tests__/**",
        "lib/__db_tests__/**",
        "lib/__action_tests__/**",
        // Generated / pure-data modules (no logic to exercise) — same list the
        // pure gate excludes so the denominators line up.
        "lib/canonical-biomarkers.json", // generated (scripts/gen-canonical-biomarkers.ts); not TS
        "lib/growth-charts.json", // generated (scripts/gen-growth-charts.ts); pure data
        "lib/supplement-catalog.ts", // hand-maintained pure data, no functions
      ],
      reporter: ["text", "text-summary"],
      // CI REGRESSION FLOOR for the DB+action tier — a tripwire, not a stretch
      // goal, same discipline as the pure gate. These sit ~5 points BELOW the
      // measured whole-tier lib/** coverage so routine additions don't trip the
      // gate but a real drop does. The run FAILS when coverage falls below any
      // floor. Re-measure with `npm run test:db:coverage` and bump the floors up
      // (never down toward 0) if the covered baseline rises meaningfully.
      //
      // This tier reaches the query/action write paths the pure gate can't, so
      // its lines/statements/functions land HIGHER than a naive read of the pure
      // floors would suggest; branches are lower because the many defensive/error
      // arms in the query layer stay unexercised by the happy-path fixtures.
      thresholds: {
        lines: 51, // measured 56.61%
        statements: 48, // measured 53.04%
        branches: 34, // measured 39.97%
        functions: 51, // measured 56.47%
      },
    },
  },
});
