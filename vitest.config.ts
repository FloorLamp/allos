import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { specsNeedingIsolation } from "./vitest.isolation";

const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "@": root };

// DB integration tests (migrations/upgrades) and the server-action write-path
// tests are a separate, impure tier that opens real SQLite handles and mocks the
// auth/next-cache boundary — keep the default `npm test` suite pure. They run via
// `npm run test:db` (vitest.db.config.ts) and are gated in CI.
const NOT_PURE = [
  "lib/__db_tests__/**",
  "lib/__action_tests__/**",
  "node_modules/**",
];

// Routed by scanning, never by hand — see vitest.isolation.ts for what disqualifies
// a spec from the shared registry and why that is a scan rather than a list. Today
// this finds the two specs that call process.chdir() plus the single vi.mock user.
const ISOLATED = specsNeedingIsolation(root, ["lib/__tests__"]);

// Tests target pure logic only (no DB/network), so the default `node`
// environment is enough. The `@/*` alias mirrors tsconfig.json `paths` so test
// files can import app modules the same way the app does.
//
// TWO PROJECTS, ONE `npm test`. The bulk run with a SHARED module registry
// (`isolate: false`): almost nothing here needs a private registry, and
// re-importing the same module graph for every file was over half the run —
// importing it once per worker took the suite from 31s to 13s. The handful that
// genuinely cannot share keep the old per-file isolation, routed there by the
// scan in vitest.isolation.ts rather than by anyone remembering to list them.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "pure",
          include: ["lib/**/*.test.ts"],
          exclude: [...NOT_PURE, ...ISOLATED],
          pool: "threads",
          isolate: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "pure-isolated",
          include: ISOLATED,
          exclude: NOT_PURE,
          pool: "forks",
        },
      },
    ],
    // Coverage here is only measured for `npm run test:coverage` (the pure
    // suite), never for the default `npm test`. This is the FIRST of two coverage
    // gates: the DB+action tier has its own floor in vitest.db.config.ts
    // (`npm run test:db:coverage`), which exercises the query/action write paths
    // this pure suite never imports (they'd report ~0% here). Scope the
    // denominator to the logic layer (`lib/**`): the pure suite never imports
    // app/** or components/**, so including them would drown the signal at ~0%.
    // That app/component surface is a separate effort and is intentionally NOT
    // gated here.
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      exclude: [
        // Test tiers — not production code.
        "lib/__tests__/**",
        "lib/__db_tests__/**",
        "lib/__action_tests__/**",
        // Generated / pure-data modules (no logic to exercise): excluding them
        // from the denominator keeps the floor honest. Catalog modules that also
        // export functions (immunization-catalog, cvx-map, activities-catalog,
        // biomarker-loinc) are intentionally KEPT in — they have logic.
        "lib/canonical-biomarkers.json", // generated (scripts/gen-canonical-biomarkers.ts); not TS
        "lib/growth-charts.json", // generated (scripts/gen-growth-charts.ts); pure data
        "lib/supplement-catalog.ts", // hand-maintained pure data, no functions
      ],
      reporter: ["text", "text-summary"],
      // CI REGRESSION FLOOR — a tripwire, not a stretch goal. These sit a few
      // points BELOW the current measured pure-suite lib/** coverage so routine
      // additions don't trip the gate but a real drop does. The run FAILS when
      // coverage falls below any floor. Measured values (pure suite, lib/**
      // with the excludes above) are noted next to each; re-measure with
      // `npm run test:coverage` and bump the floors up (never down toward 0)
      // if the covered baseline rises meaningfully.
      //
      // Recalibrated for vitest 4 / @vitest/coverage-v8 4 (#125): the v4 provider
      // uses AST-aware branch/function remapping, so the SAME passing suite now
      // measures differently — lines/statements rose (~56% -> ~64%) while branches
      // (~86% -> ~63%) and functions (~78% -> ~60%) fell. This is a measurement-
      // methodology change, not a coverage regression; the floors below are re-
      // anchored ~5 points under the v4 baseline to keep the tripwire meaningful.
      thresholds: {
        lines: 58, // measured 63.91% (vitest 4)
        statements: 58, // measured 63.92% (vitest 4)
        branches: 58, // measured 63.36% (vitest 4)
        functions: 55, // measured 60.49% (vitest 4)
      },
    },
  },
});
