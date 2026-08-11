import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

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
  // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, whose
  // next/core-web-vitals preset newly enables the "React Compiler" rule family.
  // Every compiler rule family has completed its product-reviewed burn-down and
  // stays enforced alongside exhaustive-deps and the rest of the prior surface.
];

export default config;
