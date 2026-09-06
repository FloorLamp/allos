import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const TYPESCRIPT_API_PATTERN = {
  group: ["typescript", "typescript/*"],
  message:
    'Import the compiler API from "typescript-api" (the pinned 5.x alias), not from "typescript" — see #3559.',
};

// ESLint 9 flat config. `next lint` is deprecated in Next 15 and removed in 16,
// so `npm run lint` drives the ESLint CLI directly (see package.json). The lint
// surface is `eslint-config-next`'s `next/core-web-vitals` rule set, applied to
// every tracked JavaScript and TypeScript source file from the repository root.
//
// eslint-config-next 16 ships a NATIVE flat-config export (a `Linter.Config[]`),
// so we consume it directly. This replaces the `@eslint/eslintrc` FlatCompat
// bridge we needed on 15.x (which only shipped classic `.eslintrc` configs) —
// FlatCompat.extends("next/core-web-vitals") throws a "circular structure"
// error against the 16.x native flat config, so the bridge is gone.
// The brand names lib/temporal-types.ts exports — the cast ban below is keyed on them.
const TEMPORAL_BRANDS = [
  "LocalDay",
  "LocalTime",
  "CanonicalInstant",
  "BareInstant",
];
// A reference to a brand by bare name, qualified name (`TT.LocalDay`) or
// `import("…").LocalDay`.
const TEMPORAL_BRAND_REF = (() => {
  const names = `/^(?:${TEMPORAL_BRANDS.join("|")})$/`;
  return `:matches(TSTypeReference[typeName.name=${names}], TSTypeReference[typeName.right.name=${names}], TSImportType[qualifier.name=${names}])`;
})();
// The shapes a cast to a brand can take, by NAME — this rule is syntactic and does
// not chase what a name resolves to (lib/temporal-types.ts says what that leaves to
// review). `.typeAnnotation` pins a match to the cast's TYPE side, so a brand inside
// the expression being cast (`foo<LocalDay>() as string`) is not this rule's business;
// the `:not(TSTypeLiteral …)` clause is the row-shape exemption.
const TEMPORAL_BRAND_CAST_SELECTORS = (() => {
  const cast = ":matches(TSAsExpression, TSTypeAssertion)";
  const names = `/^(?:${TEMPORAL_BRANDS.join("|")})$/`;
  return [
    // `s as LocalDay`, `<LocalDay>s`, `s as unknown as LocalDay`.
    `${cast} > ${TEMPORAL_BRAND_REF}.typeAnnotation`,
    // The brand anywhere inside the cast's type — a union, array, tuple, intersection,
    // `NonNullable<>`, `Readonly<>`, `Array<>` — except inside an object type literal.
    `${cast} > *.typeAnnotation ${TEMPORAL_BRAND_REF}:not(TSTypeLiteral ${TEMPORAL_BRAND_REF})`,
    // `type D = LocalDay`, `type D = LocalDay & {}`, `type Ds = LocalDay[]` — an alias
    // that mentions a brand outside an object shape exists only to cast around the
    // rule. `type Row = { d: LocalDay }` is a row shape and stays allowed.
    `TSTypeAliasDeclaration > ${TEMPORAL_BRAND_REF}.typeAnnotation`,
    `TSTypeAliasDeclaration > *.typeAnnotation ${TEMPORAL_BRAND_REF}:not(TSTypeLiteral ${TEMPORAL_BRAND_REF})`,
    // `type G<T = LocalDay> = T` — the brand named in an alias's type parameters
    // rather than its body.
    `TSTypeAliasDeclaration > TSTypeParameterDeclaration ${TEMPORAL_BRAND_REF}`,
    // `import { LocalDay as LD }` / `export { LocalDay as LD }` — renaming a brand
    // takes its name out of every selector above. Covers the ES2022 string-literal
    // spelling (`import { "LocalDay" as LD }`) and `import LD = TT.LocalDay`.
    `:matches(ImportSpecifier, ExportSpecifier)[imported.name=${names}]:not([local.name=${names}])`,
    `:matches(ImportSpecifier, ExportSpecifier)[imported.value=${names}]`,
    `ExportSpecifier[local.name=${names}]:not([exported.name=${names}])`,
    `ExportSpecifier[local.value=${names}]`,
    `TSImportEqualsDeclaration > TSQualifiedName.moduleReference[right.name=${names}]`,
  ];
})();

// ── The scanners that used to reread the tree ────────────────────────────────
//
// Everything from here to the config array is an invariant that used to live in a
// Vitest file walking `lib/`, `app/` and `components/` with its own `readdirSync`
// and matching source text by regex (#5346/#5347). Each is a SYNTAX shape with no
// type surface, so it belongs on the parse ESLint already runs; the scans' own
// same-line reason markers become `// eslint-disable-next-line <rule> -- <reason>`
// and their per-file allowlists become `files`/`ignores` overrides.
//
// ONE MECHANIC GOVERNS ALL OF THEM, and getting it wrong is silent: a flat config
// REPLACES a rule's options rather than merging them, so a narrower `files` block
// switches OFF every ban an earlier block put on the same rule for those files. The
// accumulating constants below are the fix — each block spreads the level it sits
// inside — and a block that `ignores` a file leaves that file on the level above,
// which is why the temporal-brand block stays first and broadest.

// Test tiers are not shipped surfaces: a fixture may name anything it is asserting
// about. Every scan replaced below excluded them.
const TEST_TREES = [
  "**/__tests__/**",
  "**/__db_tests__/**",
  "**/__action_tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
];
const PRODUCTION_TREES = [
  "lib/**/*.{ts,tsx}",
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "scripts/**/*.{ts,tsx}",
];

// #1636/#2149 — was inline in the revalidate block below; named here so the blocks
// added after it can re-state it (see the mechanic above).
const REVALIDATE_PATH_BAN = {
  name: "next/cache",
  importNames: ["revalidatePath"],
  message:
    "Use revalidateRoute from lib/revalidate.ts so the target remains compile-checked (#1636/#2149).",
};

// #3335 — the RPE opt-in seam. `RpeTracking` is minted on one branch of one module,
// so exactly one production module may import the minter and nothing may cast past
// the brand. (was lib/__tests__/rpe-opt-in.test.ts)
const RPE_MINTER_BAN = {
  name: "@/lib/rpe",
  importNames: ["mintRpeTracking"],
  message:
    "Only lib/rpe-tracking.ts mints an RpeTracking — a second producer is the drift the opt-in seam exists to prevent (#3335).",
};
const RPE_BRAND_CAST = {
  selector:
    ":matches(TSAsExpression, TSTypeAssertion) > TSTypeReference[typeName.name='RpeTracking'].typeAnnotation",
  message:
    "Do not cast to RpeTracking. Obtain it from mintRpeTracking, which is reached only when the profile opted in (lib/rpe.ts, #3335).",
};
// The stored key is an identity: two spellings of it would be two opt-ins.
const RPE_KEY_LITERAL = [
  {
    selector: "Literal[value='strength_rpe']",
    message:
      "The RPE opt-in key is spelled once, in lib/rpe-tracking.ts — import RPE_TRACKING_KEY (#3335).",
  },
  {
    selector: "TemplateElement[value.raw=/strength_rpe/]",
    message:
      "The RPE opt-in key is spelled once, in lib/rpe-tracking.ts — import RPE_TRACKING_KEY (#3335).",
  },
];

// #1935/#1936/#1937/#1939/#1966 — one streak computation survives and one module may
// call it. A new caller has to state which "you have done too much of this in a row"
// question it answers; a run to MAINTAIN is not one of them.
// (was lib/__tests__/streak-scope.test.ts)
const STREAK_MODULE_BAN = {
  group: ["**/streak"],
  message:
    'lib/streak answers the overtraining question only. A new caller must say which "you have done too much of this in a row" question it asks — a run to MAINTAIN is not one (#1935/#1936/#1937/#1939/#1966).',
};

// #1049 — the disclaimer copy is consolidated onto /disclaimer and footer-linked from
// every page, so a domain surface deletes its inline disclaimer rather than importing
// the constant. (was the import half of lib/__tests__/disclaimers.test.ts)
const DISCLAIMERS_BAN = {
  name: "@/lib/disclaimers",
  message:
    "The disclaimer lives on /disclaimer and is footer-linked from every page — delete the inline disclaimer rather than importing the copy (#1049).",
};

// #1069 — a vendor's own daily score is a store-what-the-source-said display value.
// Nothing may COMPUTE with one, so only the display/ingest surfaces may name the kinds,
// by literal or by the exported constant. The two vendors keep SEPARATE allowlists (a
// Sleep-page query may name an Oura kind and still not an imported Fitbit one), which
// is why three blocks below and not one.
// (was lib/__tests__/vendor-score-engine-inert.test.ts)
const vendorScoreBan = (vendor, names) =>
  [
    // ANCHORED, and the two literal forms below are not: a longer IDENTIFIER is a
    // different symbol (`ouraSleepScoreLabel` is not the kind), so prefix-matching
    // identifiers would fire on unrelated names. A longer STRING containing the key is
    // the key plus a suffix — `oura_sleep_score_v2` is still a vendor score key — so the
    // quote and the backtick spellings must ban the same twenty characters. They did not
    // until #5347: the string was legal and the template was not.
    `Identifier[name=/^(?:${names.join("|")})$/]`,
    `Literal[value=/(?:${names.join("|")})/]`,
    `TemplateElement[value.raw=/(?:${names.join("|")})/]`,
  ].map((selector) => ({
    selector,
    message: `${vendor}'s own daily score is displayed attributed and feeds NO engine — not the pillars, not coaching, not the digest, not risk/cadence (#1069).`,
  }));
const OURA_SCORE_KINDS = vendorScoreBan("Oura", [
  "oura_sleep_score",
  "oura_readiness_score",
  "OURA_SLEEP_SCORE_METRIC",
  "OURA_READINESS_SCORE_METRIC",
]);
const FITBIT_SCORE_KINDS = vendorScoreBan("Fitbit", [
  "fitbit_sleep_score",
  "fitbit_readiness_score",
  "FITBIT_SLEEP_SCORE_METRIC",
  "FITBIT_READINESS_SCORE_METRIC",
]);
// Each a display/ingest/bounds surface, never an engine that derives a decision.
const OURA_SURFACES = [
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/oura.ts",
  // The sync that ingests the two daily-score endpoints into metric_samples.
  "lib/integrations/oura-sync.ts",
  // Plausibility bounds (0-100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The SOLE read path: the Sleep page's display query.
  "lib/queries/sleep.ts",
  // The display surfaces (Sleep page + its attributed tiles).
  "app/(app)/sleep/page.tsx",
  "app/(app)/sleep/OuraScores.tsx",
];
const FITBIT_SURFACES = [
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/fitbit-takeout.ts",
  // Plausibility bounds (0-100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The DECLARATION of which streams only a Takeout archive can deliver (#2164). It is
  // DATA, not code: a literal array with type-only imports, where the kinds appear only
  // as the `metric` selector saying WHICH ROWS to look at. Its reader asks MAX(date) and
  // selects no `value` column, so the ask is a fact about DELIVERY, never about what
  // Fitbit scored.
  "lib/integrations/registry.ts",
];

// Accumulating levels, narrowest last — see the mechanic at the top of this section.
const SYNTAX_ALL = TEMPORAL_BRAND_CAST_SELECTORS.map((selector) => ({
  selector,
  message:
    "Do not cast or re-alias to a temporal brand. Obtain it from a minter that validates or constructs it (lib/temporal-types.ts, #2899).",
}));
// These two used to sit inline in the revalidate block and had been DEAD since the
// temporal-brand block landed after it: flat config replaces a rule's options, so the
// broader block was switching both off for every file the narrower one governs. Named
// here, re-stated by every block below, and proven with a forged violation.
const APP_SURFACE_SYNTAX = [
  {
    selector:
      "VariableDeclarator[id.type='ObjectPattern']:has(Property[key.name='revalidatePath']) ImportExpression[source.value='next/cache']",
    message:
      "Use revalidateRoute from lib/revalidate.ts so the target remains compile-checked (#1636/#2149).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='page'][callee.property.name=/^(?:on|once)$/][arguments.0.value='dialog']",
    message:
      "Do not install a Playwright dialog handler: native browser dialogs are prohibited, and accepting one would hide a regression.",
  },
];
const SYNTAX_PRODUCTION = [
  ...SYNTAX_ALL,
  ...APP_SURFACE_SYNTAX,
  RPE_BRAND_CAST,
];
const SYNTAX_PRODUCTION_KEYED = [...SYNTAX_PRODUCTION, ...RPE_KEY_LITERAL];
const SYNTAX_LIB_APP = [
  ...SYNTAX_PRODUCTION_KEYED,
  ...OURA_SCORE_KINDS,
  ...FITBIT_SCORE_KINDS,
];
const IMPORT_PATHS_PRODUCTION = [REVALIDATE_PATH_BAN, RPE_MINTER_BAN];
const IMPORT_PATTERNS_PRODUCTION = [TYPESCRIPT_API_PATTERN];
const IMPORT_PATTERNS_LIB_APP = [
  ...IMPORT_PATTERNS_PRODUCTION,
  STREAK_MODULE_BAN,
];
const restrictImports = (paths, patterns) => ["error", { paths, patterns }];

// ── #5338 — THE CLOCK SEAM ───────────────────────────────────────────────────
//
// `Date.parse` on a zoneless date-TIME string answers in the SERVER's zone, by
// specification and silently: a date-only string is UTC, a stamp ending in `Z` is
// UTC, and only the middle case moves with the host. Production writers emit a `Z`
// and CI runs UTC, which is how a wrong write took four falsifying passes to surface.
// The replacement is a TYPE rather than a convention: `parseInstant` takes
// `CanonicalInstant | BareInstant` and `parseDay` takes `LocalDay` (lib/date.ts), so
// a caller holding a bare `string` cannot reach either and has to say which shape it
// has. A column no brand describes yet (`metric_samples.started_at`/`ended_at`, a
// settings value) keeps `parseUtcSql` — UTC either way, and not the banned call —
// with a same-line comment naming the shape it expects.
const DATE_PARSE_BAN = {
  object: "Date",
  property: "parse",
  message:
    "Date.parse answers in the SERVER's zone for a zoneless date-time string. Parse through parseInstant / parseDay (lib/date.ts), whose parameter type says the value is UTC; a value no brand describes yet goes through parseUtcSql with a same-line comment naming the shape expected (#5338).",
};
// The population that pre-dates the ban, exempt BY FILE the way the vendor-score
// surfaces are. The ruling migrates it ON TOUCH: converting a site in one of these
// files means converting every site in it and deleting the line here, so the list
// only shrinks. Every entry was a literal-`Z` or bare-variable `Date.parse` when the
// ban landed; none is an endorsement.
const DATE_PARSE_ON_TOUCH = [
  "app/(auth)/login/actions.ts",
  "components/illness/FeverChart.tsx",
  "lib/adherence-patterns.ts",
  "lib/ai-usage-rollup.ts",
  "lib/backup-verify.ts",
  "lib/calorie-estimate.ts",
  "lib/chart-time-axis.ts",
  "lib/clinical-parse.ts",
  "lib/coaching/common.ts",
  "lib/coaching/engine.ts",
  "lib/derived-biomarkers.ts",
  "lib/endurance-plan.ts",
  "lib/food-drug-ledger.ts",
  "lib/goal-pacing.ts",
  "lib/integrations/backfill-progress.ts",
  "lib/integrations/health-connect.ts",
  "lib/local-day-window.ts",
  "lib/metric-snapshot.ts",
  "lib/metric-sources.ts",
  "lib/metric-window-overlap.ts",
  "lib/mobility-coverage.ts",
  "lib/niggle-model.ts",
  "lib/offline/writes.ts",
  "lib/optical-prescription.ts",
  "lib/photo/metadata-backfill.ts",
  "lib/practice-log.ts",
  "lib/queries/continuous-streams.ts",
  "lib/queries/correction-history.ts",
  "lib/queries/intake/refill.ts",
  "lib/queries/steps-target.ts",
  "lib/recommendation-run.ts",
  "lib/reference-range/retest.ts",
  "lib/sleep-retime-db.ts",
  "lib/training-observations.ts",
  "lib/travel-timezone.ts",
  "lib/trend-annotations.ts",
  "lib/weight-anomaly.ts",
  "lib/workout-recommendation.ts",
  "scripts/seed.ts",
];
// #1878 — was inline in its block below; named so the clock-seam block after it can
// re-state it for app/ and components/ (the flat-config mechanic above).
const ROUTER_REFRESH_BAN = {
  object: "router",
  property: "refresh",
  message:
    "Decide which this is: CHROME (a background actor — repaint through useChromeRefresh so a half-typed form is not emptied) or USER (the person asked for it — keep the direct call and say why on an eslint-disable line) (#1878).",
};

const config = [
  // Global ignores — mirror the old ignorePatterns. Build output, deps, and the
  // runtime data dir are never linted.
  {
    ignores: [
      ".next/",
      ".next-demo/",
      "node_modules/",
      "data/",
      "coverage/",
      "out/",
      "build/",
      "dist/",
      "e2e/.data/",
      "e2e/.auth/",
      "test-results/",
      "playwright-report/",
      "blob-report/",
      "playwright/.cache/",
    ],
  },
  // ESLint 9 flat config defaults linterOptions.reportUnusedDisableDirectives to
  // "warn", but the old `.eslintrc.json` + `next lint` path left it off — keep it
  // off so the reported set stays identical (no newly-surfaced warnings on
  // existing dead eslint-disable comments).
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  ...nextCoreWebVitals,
  // The compiler API comes from `typescript-api`, a devDependency aliased to
  // `npm:typescript@5.9`, and never from `typescript` itself (#3559). TS 7 turns the
  // root export into a version stub and moves `createSourceFile` / `forEachChild` to
  // entries it marks UNSTABLE, so a plain `import ts from "typescript"` stops
  // resolving to a compiler at all — which would take the Server Action
  // authorization sweep and the adult-only write scan red on a version bump. Sixteen
  // files import the alias today; this is what stops a seventeenth reopening it.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [TYPESCRIPT_API_PATTERN],
        },
      ],
    },
  },
  // The temporal brands (#2899, lib/temporal-types.ts) are worth exactly as much as
  // the weakest way to obtain one. A brand comes from a minter that validated or
  // constructed it; the constructing minters carry their one permitted cast on a
  // `// eslint-disable-next-line no-restricted-syntax -- <brand> minter:` line.
  //
  // This rule is a RATCHET over spellings, not a proof: it refuses the ways of naming
  // a brand as a cast target, an alias or a renamed import/export that
  // lib/__tests__/temporal-types.test.ts lists, and that list is the definition of
  // what it catches. TypeScript's type grammar has more ways to name a type than any
  // selector list — three falsifying passes each found new ones — so a spelling the
  // test does not list is an ADDITION (add the selector and the test row), never a
  // refutation, and the reviewer's job is unchanged by the rule's existence. A DB row
  // shape (`.get(...) as { date: LocalDay }`, or an alias/interface holding one) is
  // deliberately allowed — an object type literal is exempt — because a row may
  // carry the brand lib/time-columns.ts declares for that column.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_ALL],
    },
  },
  // Production code revalidates through lib/revalidate.ts, whose generated-route
  // parameter makes stale paths a compile error (#1636/#2149). This restriction
  // used to be a Vitest source scanner that reread every file after ESLint had
  // already parsed it. Put the import boundary on that existing parse instead.
  // Action tests mock next/cache directly to observe the wrapper and are not app
  // callers; lib/revalidate.ts is the one module allowed to expose the raw API.
  {
    files: [
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "scripts/**/*.{ts,tsx}",
      "e2e/**/*.{ts,tsx}",
    ],
    ignores: ["lib/revalidate.ts", "lib/__action_tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [TYPESCRIPT_API_PATTERN],
          paths: [
            {
              name: "next/cache",
              importNames: ["revalidatePath"],
              message:
                "Use revalidateRoute from lib/revalidate.ts so the target remains compile-checked (#1636/#2149).",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...SYNTAX_ALL, ...APP_SURFACE_SYNTAX],
    },
  },
  // Native alert/confirm/prompt calls bypass the app's accessible dialog primitives.
  // This used to be a three-test Vitest scanner that reparsed every app/component
  // file with the TypeScript compiler API under coverage. ESLint already owns the AST
  // pass, and its core rule resolves scope, so the app's shadowed async `confirm()`
  // service remains valid while `window.confirm()` and an unshadowed bare call fail.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-alert": "error",
    },
  },
  // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, whose
  // next/core-web-vitals preset newly enables the "React Compiler" rule family.
  // Every compiler rule family has completed its product-reviewed burn-down and
  // stays enforced alongside exhaustive-deps and the rest of the prior surface.
  // ── The retired scanners' rules, narrowest LAST ──────────────────────────────
  // Each block re-states the level it sits inside; a file listed in `ignores` falls
  // back to that level rather than to nothing. See the mechanic above the constants.
  //
  // Production, everywhere: the RPE opt-in seam (#3335). lib/rpe-tracking.ts carries
  // the one permitted import of the minter and the one spelling of the stored key on
  // its own disable line, and lib/rpe.ts the one permitted cast — the same shape the
  // temporal-brand minters use.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, "lib/revalidate.ts"],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        IMPORT_PATTERNS_PRODUCTION
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_PRODUCTION],
    },
  },
  // The opt-in KEY, everywhere except migrations. A shipped migration is frozen text
  // (its sha256 is in lib/migrations/manifest.json), so the one that back-fills the
  // column keeps its own spelling of the key and cannot carry a disable comment.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, "lib/revalidate.ts", "lib/migrations/**"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_PRODUCTION_KEYED],
    },
  },
  // lib/ + app/, outside both vendor allowlists: the streak scope (#1935…#1966) and
  // the vendor daily scores (#1069).
  {
    files: [
      "lib/**/*.{ts,tsx}",
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
    ],
    ignores: [
      ...TEST_TREES,
      "lib/revalidate.ts",
      "lib/migrations/**",
      ...OURA_SURFACES,
      ...FITBIT_SURFACES,
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        IMPORT_PATTERNS_LIB_APP
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_LIB_APP],
    },
  },
  // An Oura display/ingest surface may name an Oura kind — and still not a Fitbit one.
  {
    files: OURA_SURFACES,
    ignores: FITBIT_SURFACES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...FITBIT_SCORE_KINDS,
      ],
    },
  },
  // …and the converse.
  {
    files: FITBIT_SURFACES,
    ignores: OURA_SURFACES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...OURA_SCORE_KINDS,
      ],
    },
  },
  // #3520 — the migration registry reaches this helper at DB startup, so it stays on
  // the leaf metric policy and off the full Health Connect parser and its application
  // graph. (was lib/__tests__/db-import-boundary.test.ts)
  {
    files: ["lib/metric-window-overlap.ts"],
    rules: {
      "no-restricted-imports": restrictImports(IMPORT_PATHS_PRODUCTION, [
        ...IMPORT_PATTERNS_LIB_APP,
        {
          group: ["**/integrations/health-connect"],
          message:
            "lib/db.ts loads the migration registry, which reaches this helper — import the shared constants from ./integrations/health-connect-metrics, not the full parser (#3520).",
        },
      ]),
    },
  },
  // …and the leaf it depends on stays dependency-free, which is what makes it a leaf.
  {
    files: ["lib/integrations/health-connect-metrics.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...[
          "ImportDeclaration",
          "ImportExpression",
          "TSImportEqualsDeclaration",
          "CallExpression[callee.name='require']",
        ].map((selector) => ({
          selector,
          message:
            "The shared Health Connect metric policy is imported at DB startup and stays dependency-free — keep it a leaf module (#3520).",
        })),
      ],
    },
  },
  // #482/#840 — mobility coverage answers "mobilized?", strength coverage answers
  // "trained?". Merging them gives a false all-clear, so this module reads mobility
  // move slugs and never the lift catalog's coverage engine or strength set rows.
  // (was the scan half of lib/__tests__/mobility-coverage-apart.test.ts)
  {
    files: ["lib/mobility-coverage.ts"],
    rules: {
      "no-restricted-imports": restrictImports(IMPORT_PATHS_PRODUCTION, [
        ...IMPORT_PATTERNS_LIB_APP,
        {
          group: ["**/muscle-coverage"],
          message:
            'Mobility coverage must not be sourced from the strength coverage engine — it would answer "trained?" instead of "mobilized?" (#482).',
        },
      ]),
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_LIB_APP,
        {
          selector:
            ":matches(ImportSpecifier[imported.name='liftInfo'], Identifier[name='coverageFromSets'])",
          message:
            "Mobility coverage must not be sourced from the lift catalog or the strength coverage engine (#482).",
        },
        {
          selector:
            ":matches(Literal[value=/exercise_sets/], TemplateElement[value.raw=/exercise_sets/])",
          message:
            "Mobility coverage is counted from mobility sessions, never from strength set rows (#482).",
        },
      ],
    },
  },
  // #1049 — no domain surface imports the disclaimer copy. /disclaimer is the page the
  // copy is consolidated onto, so it is the one importer, exactly as lib/revalidate.ts
  // is the one module allowed to expose the raw revalidate API.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [
      ...TEST_TREES,
      ...OURA_SURFACES.filter((f) => f.startsWith("app/")),
      "app/(app)/disclaimer/page.tsx",
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        [...IMPORT_PATHS_PRODUCTION, DISCLAIMERS_BAN],
        IMPORT_PATTERNS_LIB_APP
      ),
    },
  },
  // #1878 — every `router.refresh()` is classified. A background actor repaints
  // through `useChromeRefresh` so the dirty-form registry can hold it; a repaint the
  // person asked for calls the router directly and carries its reason on a file-level
  // disable, which is the granularity the retired allowlist had (it listed FILES).
  // (was the first test of lib/__tests__/chrome-refresh-scan.test.ts)
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: TEST_TREES,
    rules: {
      "no-restricted-properties": ["error", ROUTER_REFRESH_BAN],
    },
  },
  // #5338 — the clock seam, over every production tree except the on-touch
  // population. lib/date.ts needs no exemption: the seam is built on `parseUtcSql`,
  // which appends the `Z` itself. app/ and components/ re-state #1878 beside it so
  // the narrower block above does not switch the ban off for them; an on-touch file
  // there falls back to that block and keeps #1878 alone.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, ...DATE_PARSE_ON_TOUCH],
    rules: {
      "no-restricted-properties": ["error", DATE_PARSE_BAN],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [...TEST_TREES, ...DATE_PARSE_ON_TOUCH],
    rules: {
      "no-restricted-properties": ["error", DATE_PARSE_BAN, ROUTER_REFRESH_BAN],
    },
  },
  // #2888 — the training surfaces reach the registry. `scope_kind !== "practice"` was a
  // private membership rule that disagreed with the two surfaces beside it, and a
  // subtraction only excludes what its author remembered; filter with
  // getFrequencyTargetProgressForHome so membership stays declared once in
  // CADENCE_SCOPES.home. (was the literal half of lib/__tests__/cadence-home.test.ts)
  {
    files: ["app/(app)/training/**/*.{ts,tsx}"],
    ignores: TEST_TREES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_LIB_APP,
        {
          selector:
            "BinaryExpression[operator=/^[!=]==?$/][right.type='Literal']:matches([left.name='scope_kind'], [left.property.name='scope_kind'])",
          message:
            'Filter with getFrequencyTargetProgressForHome(profileId, "training") — a private scope_kind list is the subtraction #2888 removed.',
        },
      ],
    },
  },
];

export default config;
