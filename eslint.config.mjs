import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// ESLint 9 flat config. `next lint` is deprecated in Next 15 and removed in 16,
// so `npm run lint` now drives the ESLint CLI directly (see package.json). The
// lint surface is intentionally unchanged from the old `.eslintrc.json`:
// `eslint-config-next`'s `next/core-web-vitals` rule set, applied to the same
// source trees (app/ components/ lib/ e2e/ scripts/ — passed on the CLI).
//
// eslint-config-next 14.2.x ships only classic (.eslintrc) configs — it has no
// flat-config export — so we bridge it with FlatCompat from @eslint/eslintrc,
// the officially documented path for consuming a legacy shareable config under
// flat config. When the repo moves to Next 15+, this can be replaced by
// eslint-config-next's native flat export.
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  // Global ignores — mirror the old ignorePatterns. Build output, deps, and the
  // runtime data dir are never linted.
  {
    ignores: [".next/", "node_modules/", "data/"],
  },
  // Preserve the pre-flat-config lint surface. ESLint 9 flat config defaults
  // linterOptions.reportUnusedDisableDirectives to "warn", but the old
  // `.eslintrc.json` + `next lint` path left it off — so turning it off here
  // keeps the reported set identical (no newly-surfaced warnings on existing
  // dead eslint-disable comments) and this change purely relocates lint from
  // `next lint` to the ESLint CLI.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  ...compat.extends("next/core-web-vitals"),
  // ESLint 9 compatibility shim for two pages-router-only rules.
  //
  // @next/eslint-plugin-next@14.2.33 (bundled with next 14.2.33) implements
  // `no-duplicate-head` and `no-page-custom-font` with `context.getAncestors()`,
  // an API ESLint 9 removed — so they THROW on any file rather than lint it (the
  // same crash `next lint` would hit under ESLint 9; it is not a flat-config
  // artifact). Both rules only target the Pages Router (`pages/_document`, custom
  // `<Head>`/font usage), and this is a pure App Router app with no `pages/`
  // directory, so they can never produce a real finding here. Disabling them
  // therefore removes nothing that was actually enforced on this codebase while
  // unblocking every other Next/core-web-vitals rule. Drop this block once the
  // repo moves to a Next 15+ config whose plugin build is ESLint 9-native.
  {
    rules: {
      "@next/next/no-duplicate-head": "off",
      "@next/next/no-page-custom-font": "off",
    },
  },
];

export default config;
