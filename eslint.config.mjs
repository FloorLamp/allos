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
      ],
    },
  },
  // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, whose
  // next/core-web-vitals preset newly enables the "React Compiler" rule family.
  // Every compiler rule family has completed its product-reviewed burn-down and
  // stays enforced alongside exhaustive-deps and the rest of the prior surface.
];

export default config;
