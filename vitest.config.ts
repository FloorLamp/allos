import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { specsNeedingIsolation } from "./vitest.isolation";
// Both ceilings, with their derivation and their unit, live in ONE place.
import { testTimeout, hookTimeout } from "./vitest.timeouts";

// Loaded by EVERY project in both tiers: it turns a timeout into a sentence that
// says whether the worker was waiting or running (#3986). See the module header.
const TIMEOUT_REPORT = "./vitest.timeout-report.ts";

// Do not let the threads and forks pools each size themselves to the whole runner.
// CI A/B (#4000, 2026-08-29): three ungrouped/grouped test-unit samples moved
// median job time 234s -> 186s and Vitest time 218.07s -> 169.85s. The two named
// scanner medians fell 22-27%; within-pool variance remains, so this removes
// cross-pool competition rather than claiming every file now has a stable clock.
const SHARED_POOL_GROUP = 0;
const ISOLATED_POOL_GROUP = 1;

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
// environment is enough for the two `lib/**` projects. The `@/*` alias mirrors
// tsconfig.json `paths` so test files can import app modules the same way the app
// does.
//
// THREE PROJECTS, ONE `npm test`. The bulk run with a SHARED module registry
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
          testTimeout,
          hookTimeout,
          include: ["lib/**/*.test.ts"],
          exclude: [...NOT_PURE, ...ISOLATED],
          setupFiles: [TIMEOUT_REPORT],
          pool: "threads",
          isolate: false,
          sequence: { groupOrder: SHARED_POOL_GROUP },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "pure-isolated",
          testTimeout,
          hookTimeout,
          include: ISOLATED,
          exclude: NOT_PURE,
          setupFiles: [TIMEOUT_REPORT],
          pool: "forks",
          sequence: { groupOrder: ISOLATED_POOL_GROUP },
        },
      },
      // ── THE COMPONENT TIER (#3446) ────────────────────────────────────────
      //
      // A DOM environment over `components/**`, so a guard that lives in a hook or
      // in a component's own DOM read can be pinned by something cheaper than a
      // browser. Before this there were exactly two altitudes — a pure function
      // extracted into `lib/`, or a full Playwright run — and the measured default
      // for everything in between was NO coverage: #3371's reload gate shipped with
      // both its OR sites deletable and `npm test`, `npm run lint` and
      // `npm run typecheck` all green. See docs/internals/component-tests.md, which
      // records this tier's scope and the earlier decision it supersedes.
      //
      // WHY THIS CONFIG AND NOT A FOURTH ONE. The split this repo already makes is
      // PURITY, not environment: `vitest.db.config.ts` is separate because its tests
      // open real SQLite handles, need a global setup, and mock the auth/next-cache
      // boundary. A jsdom test is still pure in exactly that sense — no database, no
      // network, no filesystem, nothing to tear down between runs — so it belongs on
      // the pure side of the boundary the repo already drew, and folding it in is
      // what makes it IMPOSSIBLE to forget to run. `npm test`, CI's `test-unit` job
      // (`npm run test:coverage`), `CI (main)`'s and
      // scripts/work/agent-gates.sh's `npm test` all pick it up with no
      // further wiring — and "configured but never invoked" is the exact failure
      // #3446 exists to end. It earns its own config the day it needs a global
      // setup, a non-hermetic resource, or a coverage denominator of its own.
      //
      // WHY jsdom AND NOT happy-dom. happy-dom is faster to construct, and if this
      // tier ever grows to hundreds of files that per-file cost is the thing that
      // would change the answer. Today it is not the cost that matters. jsdom's
      // divergences from a browser are LOUD — it throws "not implemented" — where
      // happy-dom's are more often a quiet difference in result, and a tier whose
      // whole purpose is to stop silent false greens cannot be built on an
      // environment that fails quietly. It is also what @testing-library and Next
      // document against, so a future author is reading the mainstream recipe.
      //
      // ISOLATED, unlike the `pure` project: a document is per-file state, and the
      // registries these tests drive (lib/offline/unsaved-work.ts,
      // components/update-reload-channel.ts) are module-level singletons. A shared
      // registry would let one file's leftovers decide another file's verdict, which
      // is the failure this tier exists to catch rather than to commit.
      {
        resolve: { alias },
        test: {
          name: "components",
          testTimeout,
          hookTimeout,
          include: ["components/**/*.test.ts", "components/**/*.test.tsx"],
          exclude: ["node_modules/**"],
          environment: "jsdom",
          setupFiles: [TIMEOUT_REPORT, "components/__tests__/setup.ts"],
          pool: "threads",
          sequence: { groupOrder: SHARED_POOL_GROUP },
        },
      },
    ],
    // Coverage here is only measured for `npm run test:coverage` (the pure
    // suite), never for the default `npm test`. This is the FIRST of two coverage
    // gates: the DB+action tier has its own floor in vitest.db.config.ts
    // (`npm run test:db:coverage`), which exercises the query/action write paths
    // this pure suite never imports (they'd report ~0% here). Scope the
    // denominator to the logic layer (`lib/**`): almost nothing here imports
    // app/** or components/**, so including them would drown the signal at ~0%.
    // That app/component surface is a separate effort and is intentionally NOT
    // gated here — including by the component tier above, which renders
    // components/** but is measured only for the lib/** it happens to reach.
    //
    // THE FLOORS BELOW ARE MINIMA, so the component tier can only move them the
    // safe way. It imports lib/sw-update.ts, lib/offline/unsaved-work.ts and
    // lib/dirty-forms.ts, which the pure tier already covers, so its effect on the
    // measured numbers is a small rise at most. A tier that DROPPED the measured
    // baseline would be one adding uncovered lib/** files, which no test tier can.
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
        // canonical-result-loinc) are intentionally KEPT in — they have logic.
        "lib/canonical-result-definitions.json", // generated (scripts/gen-canonical-result-definitions.ts); not TS
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
