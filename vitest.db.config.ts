import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// DB integration tests (a SEPARATE tier from the pure unit suite in
// lib/__tests__). These open real better-sqlite3 handles to exercise code that
// needs a live schema: the migration/upgrade path in lib/db.ts (fresh-boot vs.
// existing-DB "upgrade" divergence a fresh-only suite can't see), and the query
// layer executed against a seeded fixture (catching SQL typos / broken joins /
// scoping leaks the source-scan can't). Run via `npm run test:db`; gated in CI.
// The `@/*` alias mirrors tsconfig.json `paths`, same as vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Two suites share this tier: the query-layer smoke tests and the server-action
    // write-path tests (lib/__action_tests__). Both need a live schema + temp DB.
    include: [
      "lib/__db_tests__/**/*.test.ts",
      "lib/__action_tests__/**/*.test.ts",
    ],
    // Redirect the lib/db.ts singleton at a per-file throwaway DB (ALLOS_DB_PATH)
    // BEFORE any test file imports it, so the query smoke tests run against a
    // seeded temp database and never touch (or depend on) data/allos.db. See
    // lib/__db_tests__/setup.ts. The action setup adds the auth / next-cache mocks
    // the server-action tests need (harmless for the query tests, which import
    // neither module).
    setupFiles: ["lib/__db_tests__/setup.ts", "lib/__action_tests__/setup.ts"],
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
