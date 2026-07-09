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
  },
});
