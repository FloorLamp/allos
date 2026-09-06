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
// The level `app/`, `components/`, `lib/`, `scripts/` and `e2e/` already sit on —
// named so the e2e blocks below can spread it rather than re-listing its members.
const SYNTAX_APP_SURFACE = [...SYNTAX_ALL, ...APP_SURFACE_SYNTAX];
const SYNTAX_PRODUCTION = [...SYNTAX_APP_SURFACE, RPE_BRAND_CAST];
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

// ── e2e/**: the hygiene scan's zero-allowlist bans (#5350) ───────────────────
//
// Each ban below was a per-file COUNT frozen at zero with an EMPTY allowlist in
// lib/__tests__/e2e-hygiene.test.ts — a straight prohibition wearing a ratchet's
// clothes. Every one is a syntax shape with no type surface, so it moves onto the
// parse ESLint already runs, exactly as #5392 moved the nine production walkers.
//
// THE ESCAPE MARKERS MOVE WITH THEM. A scan line carrying `first-ok: <why>` (or
// `topass-ok`, `waitfortimeout-ok`, `clock-ok`, `ci-ok`, `confirm-delete-ok`) was
// dropped before counting; the same line now reads
// `// eslint-disable-line no-restricted-syntax -- first-ok: <why>`, which keeps the
// reason on the line it excuses and costs no extra line.
//
// AND THAT IS A REACH CHANGE, STATED RATHER THAN HIDDEN: the marker was per-PATTERN
// and a disable directive is per-RULE. A line excused for `.first()` is now also
// excused for every other `no-restricted-syntax` ban that could appear on it. The
// bans that most plausibly co-occur with a marked line are split onto
// `no-restricted-properties` and `no-restricted-imports` where the shape allows, so
// the collision surface is smaller than one rule holding all of them — but it is not
// zero, and `reportUnusedDisableDirectives` is still off (#5363), so a directive that
// stops excusing anything is silent until that lands.
//
// ONE SCAN RULE DID NOT COME: the offline-navigation guard (#3002) asks whether a
// `.goto()` sits BETWEEN a `setOffline(true)` and a `setOffline(false)` with no
// `readyForOffline()` before it. That is a state machine over sibling statements,
// which esquery cannot express, so it stays in lib/__tests__/e2e-hygiene.test.ts.

// The blessed interaction module OWNS the settle patterns it exists to centralize
// (`followLink`'s internal waits, plus the decision-tree header that spells both
// out), so the scan never read it — SCAN_EXCLUDE, one entry. An `ignores` here
// leaves it on the level above, which is what that exclusion meant.
const E2E_HELPERS = "e2e/helpers.ts";
// The DB-per-worker harness IS the thing the harness rules point at: it imports
// `test` from Playwright to extend it, reads ALLOS_DB_PATH to hand out
// `workerDbPath()`, and takes the wall-clock reading `frozenNow()` is derived from.
const E2E_WORKER_HARNESS = [
  "e2e/fixtures.ts",
  "e2e/worker-env.ts",
  "e2e/global-setup.ts",
  "e2e/global-teardown.ts",
];
const E2E_FAMILY_HOME = "e2e/family-helpers.ts";
const E2E_FIXTURE_PROFILE = "e2e/fixture-profile.ts";

const HYGIENE_DOC = "see docs/internals/e2e-hygiene.md.";

const WALL_CLOCK_MESSAGE = `A spec's "now" is the harness's frozen now, never the wall clock (#1538) — use frozenNow() from ./worker-env, or carry a \`clock-ok: <why>\` disable line for a use that is NOT a stored timestamp (a unique-name suffix, a TOTP probe); ${HYGIENE_DOC}`;

// THE FOUR BANS THAT CARRY LIVE ESCAPE TRAFFIC sit on `no-restricted-properties`
// rather than on `no-restricted-syntax`, and that placement is the point: 748 of the
// 750 reviewed escapes in e2e/ today are one of these four, and a disable directive
// is per-RULE where the retired scan's same-line marker was per-PATTERN. Splitting
// them off means a line excused for `.first()` still cannot smuggle in a temporal
// brand cast, a wall-clock CONSTRUCTOR or any other no-restricted-syntax ban. The
// four remaining collisions are between these four themselves, which is what the
// scan's own per-file counts could not distinguish either.
const E2E_PROPERTY_BANS = [
  {
    // #868 (ii) — a fixed sleep asserts nothing and is either too short (flakes
    // under contention) or too long. The ONE sanctioned use is an irreducible
    // bounded absence-of-effect proof, which carries its reason on a disable line.
    property: "waitForTimeout",
    message: `waitForTimeout(...) asserts nothing — await the actual signal (settledClick / followLink / a retrying expect on one locator), or carry a \`waitfortimeout-ok: <why>\` disable line ONLY for an irreducible bounded absence-of-effect proof; ${HYGIENE_DOC}`,
  },
  {
    // #868 (iii) — on a shared seeded surface "the first row" is whatever a
    // neighbour spec or a retry left on top.
    property: "first",
    message: `.first() on a shared surface takes whatever a neighbour spec left on top — target a spec-owned fixture by exact locator, or carry a \`first-ok: <why>\` disable line for a reviewed owned-fixture use; ${HYGIENE_DOC}`,
  },
  {
    // #868 (iv) — a retrying block proves "passes within N attempts", not "works",
    // and hides WHICH step raced.
    property: "toPass",
    message: `.toPass( proves "passes within N attempts", not "works", and hides which step raced — await the actual signal, or carry a \`topass-ok: <why>\` disable line for a reviewed last resort; ${HYGIENE_DOC}`,
  },
  { object: "Date", property: "now", message: WALL_CLOCK_MESSAGE },
];
// The harness reads the wall clock ONCE, to derive the frozen now every spec then
// asks for — so it is the one surface that drops `Date.now`, exactly as it drops the
// `new Date()` twin among the syntax bans.
const E2E_PROPERTY_BANS_WORKER_HARNESS = E2E_PROPERTY_BANS.filter(
  (ban) => ban.property !== "now"
);

// Applies to every e2e source but the blessed interaction module.
const E2E_SETTLE_BANS = [
  {
    // #868 (i) — a readiness gate that settles on a quiet page but not a streaming
    // one, and waits for the wrong thing: network silence, not "my interaction
    // landed".
    selector:
      "CallExpression[callee.property.name='waitForLoadState'][arguments.0.value='networkidle']",
    message: `waitForLoadState("networkidle") settles on network silence, not on your interaction landing — use settledClick / followLink from e2e/helpers.ts; ${HYGIENE_DOC}`,
  },
  {
    // A committed skip is missing coverage disguised as a test; a runtime skip makes
    // a green run ambiguous about which contract ran.
    selector:
      "CallExpression[callee.object.name='test'][callee.property.name='skip']",
    message: `A committed test.skip makes a green run ambiguous about which contracts ran — delete obsolete coverage, or make the boundary deterministic in the fixture; ${HYGIENE_DOC}`,
  },
  {
    // #2645/#2648 — the harness serves ONE build shape (every worker's `next start`
    // runs NODE_ENV=production), so the runner is not a proxy for "is this a
    // production build" and the non-CI arm of such a branch is unreachable.
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='CI']",
    message: `The harness serves ONE build shape — every worker runs NODE_ENV=production — so process.env.CI is not a proxy for "is this a production build" (#2645/#2648). Assert what the harness can serve, or name the runner-only fact on a \`ci-ok: <why>\` disable line; ${HYGIENE_DOC}`,
  },
  {
    // #2437/#2559 — two boundingBox()es inside one Promise.all are two CDP
    // round-trips with a layout pass between them, so a RELATIVE assertion built
    // from them can describe a layout that never existed. The sibling combinator
    // fires on the second and later box in the array, so a third element between
    // them (which the retired regex's lazy gap could walk past into the NEXT
    // Promise.all) is caught and cross-statement pairing is impossible.
    selector:
      "CallExpression[callee.object.name='Promise'][callee.property.name='all'] > ArrayExpression > CallExpression[callee.property.name='boundingBox'] ~ CallExpression[callee.property.name='boundingBox']",
    message: `Two boundingBox() reads through one Promise.all are not atomic — each is its own round-trip and the page lays out between them. Use settledBoxes([...]) from e2e/helpers.ts, which repeats the group until two consecutive reads agree; ${HYGIENE_DOC}`,
  },
  {
    // #2714 — a measured point is a fact about the PAST from the instant it is
    // returned, and a surface that relays out after settling moves the target out
    // from under the gesture, whereupon the recognizer rejects the landing and the
    // swipe does nothing at all. A document-anchored gesture names its coordinates
    // inline; that is the only honest spelling.
    selector:
      "CallExpression[callee.name='touchSwipe'][arguments.0.type='Identifier']:not([arguments.1.type='ObjectExpression'])",
    message: `A swipe's starting point may only be an inline { x, y } literal — a MEASURED point is stale from the instant it is returned (#2714). Use touchSwipeFrom(page, locator, { dx, dy }) from e2e/helpers.ts, which re-aims and proves where the finger landed; ${HYGIENE_DOC}`,
  },
  {
    // #3454 — the confirm dialog's Delete is a client toggle with no POST to settle
    // on, so a tap dispatched before React attaches is discarded in silence.
    selector:
      "CallExpression[callee.property.name='click']:has(CallExpression[callee.property.name='getByTestId'][arguments.0.value='confirm-dialog']):has(Property[key.name='name'][value.value='Delete'])",
    message: `A bare .click() on a confirm dialog's Delete can be swallowed before React attaches — use deleteActivityFromForm, or carry a \`confirm-delete-ok: <why>\` disable line; ${HYGIENE_DOC}`,
  },
  {
    // #1543 — the app shell clips horizontal overflow, so a document-width vs
    // viewport-width comparison is unconditionally true on every (app) page.
    selector:
      "MemberExpression[property.name='scrollWidth'][object.property.name='documentElement']",
    message: `The app shell clips horizontal overflow, so a document-level width comparison asserts nothing on an (app) page (#1543) — use expectNoClippedContent(page) from e2e/helpers.ts, which measures element-level containment; ${HYGIENE_DOC}`,
  },
  {
    selector:
      "MemberExpression[property.name='scrollWidth'][object.object.name='document'][object.property.name='body']",
    message: `The app shell clips horizontal overflow, so a document-level width comparison asserts nothing on an (app) page (#1543) — use expectNoClippedContent(page) from e2e/helpers.ts, which measures element-level containment; ${HYGIENE_DOC}`,
  },
  ...[
    // #4369 — a bare fixed year is a date fuse with no date attached: a relative
    // fixture eventually leaves it, and the negated form then passes vacuously.
    // The string arm is the whole literal (`"2024"`, not `"Jan 2024"`); the regex
    // arm matches a year anywhere in the pattern, which is what the retired scan's
    // `/…\b20\d{2}\b…/` alternative did.
    "CallExpression[callee.property.name='toContainText'][arguments.0.value=/^20[0-9]{2}$/]",
    "CallExpression[callee.property.name='toContainText'][arguments.0.regex.pattern=/20[0-9]{2}/]",
    "CallExpression[callee.property.name='toContainText'] > TemplateLiteral > TemplateElement[value.raw=/^20[0-9]{2}$/]",
  ].map((selector) => ({
    selector,
    message: `A bare fixed year is not a date contract: a relative fixture eventually leaves it and a negated assertion then passes vacuously (#4369). Assert the fixture-derived display date, or use a year-SHAPE regex when proving no date renders; ${HYGIENE_DOC}`,
  })),
];

// The Settings → Family create/grant controls are onClick Server-Action handlers,
// not form submits, so an inline goto→fill→click flakes on the hydration swallow /
// toaster false-settle (#830/#1111). Nine near-identical copies had accreted before
// e2e/family-helpers.ts became their one home — which is why that file is the one
// exemption: it OWNS these three markers by design.
const E2E_FAMILY_BANS = [
  [
    "CallExpression[callee.property.name='getByPlaceholder'][arguments.0.value='Username']",
    "createLoginViaFamily",
    "create-login",
  ],
  [
    ":matches(Literal[value='Add a profile'], TemplateElement[value.raw='Add a profile'])",
    "createProfileViaFamily",
    "create-profile",
  ],
  [
    ":matches(Literal[value='Save access'], TemplateElement[value.raw='Save access'])",
    "setGrantsViaFamily",
    "set-grants",
  ],
].map(([selector, helper, what]) => ({
  selector,
  message: `An inline Settings → Family ${what} sequence flakes on the onClick+refresh hydration swallow / toaster false-settle (#830/#1111) — use ${helper} from e2e/family-helpers.ts; ${HYGIENE_DOC}`,
}));

// #1487 — a fixture profile built with a bare INSERT starts with no `saved_items`
// rows, so it renders an empty Trends Overview no real profile can be in; a bare
// DELETE leaves the rows the constructor seeded and fails on their foreign key.
// e2e/fixture-profile.ts is the constructor pair's home and is the one exemption.
const E2E_PROFILE_SQL_BANS = [
  [
    String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+profiles\b`,
    "A raw INSERT INTO profiles skips the standard Overview metric seeds every production-created profile gets (#1487) — use createFixtureProfile from e2e/fixture-profile.ts",
  ],
  [
    String.raw`DELETE\s+FROM\s+profiles\b`,
    "A raw DELETE FROM profiles leaves the rows the fixture CONSTRUCTOR seeded and fails on their foreign key (#1487) — use destroyFixtureProfile from e2e/fixture-profile.ts, the constructor's pair",
  ],
].map(([pattern, message]) => ({
  selector: `:matches(Literal[value=/${pattern}/i], TemplateElement[value.raw=/${pattern}/i])`,
  message: `${message}; ${HYGIENE_DOC}`,
}));

// #1538 — the DB-per-worker harness. A spec importing `test` from "@playwright/test"
// opts out of it entirely (no per-worker baseURL, no per-worker session), and
// ALLOS_DB_PATH is the APP SERVER's environment, not the spec process's, so reading
// it opens the wrong worker's database. TYPE imports (Page, Locator, Browser) are
// not restricted — only the `test` binding is.
const E2E_HARNESS_IMPORT_BAN = {
  name: "@playwright/test",
  importNames: ["test"],
  message: `Importing \`test\` from "@playwright/test" opts out of the DB-per-worker harness (#1538) — import { test, expect } from "./fixtures"; type imports may stay; ${HYGIENE_DOC}`,
};
const E2E_HARNESS_BANS = [
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='ALLOS_DB_PATH']",
    message: `ALLOS_DB_PATH is the APP SERVER's environment, not the spec process's — reading it opens the wrong worker's database (#1538). Use workerDbPath() from ./worker-env; ${HYGIENE_DOC}`,
  },
  {
    // #1538 — the app serves a frozen `now()` and a long lane drifts ~90 minutes
    // from real time, so a wall-clock timestamp lands in the app's future. The
    // `Date.now()` half of this ban is a PROPERTY and sits with the other three
    // high-traffic escapes below; only the constructor form needs a selector.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: WALL_CLOCK_MESSAGE,
  },
];

// #3946 — `deleteActivitiesTitled` in e2e/shared-profile-guard.ts is the one
// definition, and it existed verbatim in three specs before that.
//
// THE PATTERN COMES FROM HOW THE SPECS SPELL IT, not from how the issue described
// it: a census found five spellings, so a rule written for `WHERE title = ?` alone
// would have shipped green and blind to four of them. It stops short of
// `profile_id = ?` on purpose — a selector cannot resolve a constant, and that
// binding may be a spec-OWNED fixture profile, which the shared helper must never
// touch. `LIKE` is out of scope too: a prefix sweep is a different contract.
//
// SPECS ONLY. A seed and a fixture module delete-then-insert to stay idempotent
// over an existing database, which is their job and not a spec's cleanup.
const E2E_SHARED_ACTIVITY_DELETE = (() => {
  const pattern = String.raw`DELETE\s+FROM\s+activities\s+WHERE\s+(?:profile_id\s*=\s*1\s+AND\s+)?title\s*(?:=|IN\s*\()`;
  return {
    selector: `:matches(Literal[value=/${pattern}/i], TemplateElement[value.raw=/${pattern}/i])`,
    message: `An inline shared-profile activity cleanup is spelled once — use deleteActivitiesTitled from e2e/shared-profile-guard.ts (#3946); ${HYGIENE_DOC}`,
  };
})();

// FOUR FILES EACH OWN ONE GROUP, and each keeps every OTHER group — which is why
// these are composed sets and not an accumulating ladder. An `ignores` entry drops a
// file to the level ABOVE, so a ladder would have handed family-helpers.ts an
// exemption from the profile-SQL and harness bans it never had under the scan. The
// shape here is the one the two vendor allowlists above already use: state each
// surface's list, and the converse.
//
// e2e/ already sits on APP_SURFACE_SYNTAX (the revalidate block lists it), so that
// is what these build on rather than SYNTAX_ALL.
const SYNTAX_E2E_BASE = [...SYNTAX_APP_SURFACE, ...E2E_SETTLE_BANS];
const SYNTAX_E2E_ALL = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_PROFILE_SQL_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_SPEC = [...SYNTAX_E2E_ALL, E2E_SHARED_ACTIVITY_DELETE];
// …and the three converses, each dropping exactly the group its file owns.
const SYNTAX_E2E_FAMILY_HOME = [
  ...SYNTAX_E2E_BASE,
  ...E2E_PROFILE_SQL_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_FIXTURE_PROFILE = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_WORKER_HARNESS = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_PROFILE_SQL_BANS,
];
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
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_PRODUCTION
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_APP_SURFACE],
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
  // ── e2e/**: the retired hygiene scan's zero-allowlist bans (#5350) ──────────
  // The scan read `e2e/**/*.ts` — specs AND the driver/helper modules, because a
  // settle anti-pattern can hide in a helper the specs import (#868 phase 2). Only
  // e2e/helpers.ts was never read: it OWNS the settle patterns it exists to
  // centralize, so an `ignores` here leaves it on the level above, which is what
  // that one exclusion meant.
  {
    files: ["e2e/**/*.ts"],
    ignores: [E2E_HELPERS],
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN, E2E_HARNESS_IMPORT_BAN],
        IMPORT_PATTERNS_PRODUCTION
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_ALL],
      "no-restricted-properties": ["error", ...E2E_PROPERTY_BANS],
    },
  },
  // The Settings → Family driver owns the three inline markers by design…
  {
    files: [E2E_FAMILY_HOME],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_FAMILY_HOME],
    },
  },
  // …the fixture-profile constructor pair owns the two profile writes…
  {
    files: [E2E_FIXTURE_PROFILE],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_FIXTURE_PROFILE],
    },
  },
  // …and the DB-per-worker harness IS what the harness bans point at: it extends
  // Playwright's `test`, reads ALLOS_DB_PATH to hand out workerDbPath(), and takes
  // the one wall-clock reading frozenNow() is derived from.
  {
    files: E2E_WORKER_HARNESS,
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_PRODUCTION
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_WORKER_HARNESS],
      "no-restricted-properties": [
        "error",
        ...E2E_PROPERTY_BANS_WORKER_HARNESS,
      ],
    },
  },
  // A seed and a fixture module delete-then-insert to stay idempotent over an
  // existing database, which is their job and not a spec's cleanup — so the shared
  // activity cleanup is the one ban scoped to specs alone. None of the three files
  // above is a spec, so this block adds to the full list rather than to a converse.
  {
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_SPEC],
    },
  },
];

export default config;
