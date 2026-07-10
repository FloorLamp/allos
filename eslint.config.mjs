import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// ESLint 9 flat config. `next lint` is deprecated in Next 15 and removed in 16,
// so `npm run lint` now drives the ESLint CLI directly (see package.json). The
// lint surface is intentionally unchanged from the old `.eslintrc.json`:
// `eslint-config-next`'s `next/core-web-vitals` rule set, applied to the same
// source trees (app/ components/ lib/ e2e/ scripts/ — passed on the CLI).
//
// eslint-config-next 15.x still ships only classic (.eslintrc) configs — it has
// no flat-config export (that lands in a later major) — so we bridge it with
// FlatCompat from @eslint/eslintrc, the officially documented path for consuming
// a legacy shareable config under flat config. When eslint-config-next gains a
// native flat export, this can be replaced by it.
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
  // NOTE: the ESLint-9 compatibility shim that disabled `no-duplicate-head` and
  // `no-page-custom-font` (they crashed under @next/eslint-plugin-next@14.2.x via
  // the removed `context.getAncestors()` API) is gone — @next/eslint-plugin-next
  // @15.x reimplements both rules against the ESLint-9 API, so the full
  // next/core-web-vitals rule set now runs without throwing.
];

export default config;
