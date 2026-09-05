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
  "VendorMsInstant",
  "DayMidnightAnchor",
  "MetricSampleInstant",
];
// A cast (`as` or angle-bracket) whose target is a brand, a union holding one, or an
// array of one. Three alternatives rather than one nested `:matches`, because a child
// combinator binds to the matched node and cannot describe two different parents.
const TEMPORAL_BRAND_CAST_SELECTOR = (() => {
  const cast = ":matches(TSAsExpression, TSTypeAssertion)";
  const brand = `TSTypeReference[typeName.name=/^(?:${TEMPORAL_BRANDS.join("|")})$/]`;
  return `:matches(${cast} > ${brand}, ${cast} > TSUnionType > ${brand}, ${cast} > TSArrayType > ${brand})`;
})();

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
      "no-restricted-syntax": [
        "error",
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
      ],
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
  // The temporal brands (#2899, lib/temporal-types.ts) are worth exactly as much as
  // the weakest way to obtain one, so `x as LocalDay` on a plain string is an error
  // EVERYWHERE — production, tests and scripts alike. A brand comes from a minter
  // that validated or constructed it; each minter carries the one permitted cast on
  // a `// eslint-disable-next-line no-restricted-syntax -- <brand> minter:` line,
  // which makes `grep -rn "minter:" lib` the minter inventory. A DB row shape
  // (`.get(...) as { date: LocalDay }`) is deliberately NOT matched: the selector
  // sees only a direct cast to a brand, a union containing one, or an array of one,
  // and a row shape may carry the brand lib/time-columns.ts declares for that column.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: TEMPORAL_BRAND_CAST_SELECTOR,
          message:
            "Do not cast to a temporal brand. Obtain it from a minter that validates or constructs it (lib/temporal-types.ts, #2899).",
        },
      ],
    },
  },
  // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, whose
  // next/core-web-vitals preset newly enables the "React Compiler" rule family.
  // Every compiler rule family has completed its product-reviewed burn-down and
  // stays enforced alongside exhaustive-deps and the rest of the prior surface.
];

export default config;
