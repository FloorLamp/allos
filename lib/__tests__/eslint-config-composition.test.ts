import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

// WHY THIS EXISTS, and it is not a source scanner: it asks ESLint's own API which
// rules reach a file. A flat config REPLACES a rule's options rather than merging
// them, so a narrower `files` block switches OFF every ban an earlier block put on
// that rule for those files — with no error, no warning and nothing in the config
// that looks wrong. eslint.config.mjs accumulates its ban lists (SYNTAX_ALL →
// SYNTAX_PRODUCTION → … ) precisely so each block can re-state the level it sits
// inside, and a dropped spread is invisible without this question being asked.
//
// It is not hypothetical. Two shipped selectors — the `next/cache` dynamic-import
// ban and the Playwright dialog-handler ban — had been dead since the
// temporal-brand block landed after the revalidate block, and a file containing
// both forbidden shapes linted clean. Nothing said so for the whole of that time.
//
// The table names each ban by a fragment of ITS OWN MESSAGE, so a row reads as the
// sentence a developer would see. `mustNot` is the converse half: an exemption that
// quietly becomes universal is the same defect pointing the other way.

const eslint = new ESLint({ cwd: process.cwd() });

async function messagesFor(file: string): Promise<string> {
  const config = await eslint.calculateConfigForFile(file);
  const rules = (config as { rules?: Record<string, unknown> }).rules ?? {};
  const entries = [
    "no-restricted-imports",
    "no-restricted-syntax",
    "no-restricted-properties",
  ].flatMap((name) => {
    const value = rules[name];
    return Array.isArray(value) ? value.slice(1) : [];
  });
  return JSON.stringify(entries);
}

const TEMPORAL = "temporal brand";
const TS_API = "typescript-api";
const REVALIDATE = "Use revalidateRoute from lib/revalidate.ts";
const DIALOG = "Do not install a Playwright dialog handler";
const RPE_MINT = "mints an RpeTracking";
const RPE_CAST = "Do not cast to RpeTracking";
const RPE_KEY = "RPE opt-in key is spelled once";
const STREAK = "answers the overtraining question only";
const OURA = "Oura's own daily score";
const FITBIT = "Fitbit's own daily score";
const DISCLAIMER = "The disclaimer lives on /disclaimer";
const REFRESH = "Decide which this is: CHROME";
const SCOPE_KIND = "getFrequencyTargetProgressForHome";
const HEALTH_CONNECT = "import the shared constants from";
const LEAF = "stays dependency-free";
const STRENGTH_ENGINE = "must not be sourced from the strength coverage engine";
const EXERCISE_SETS = "never from strength set rows";

// One row per config block, plus the exemptions each block's `ignores` creates.
const CASES: [file: string, must: string[], mustNot: string[]][] = [
  [
    "app/(app)/layout.tsx",
    [
      TEMPORAL,
      TS_API,
      REVALIDATE,
      DIALOG,
      RPE_MINT,
      RPE_CAST,
      RPE_KEY,
      STREAK,
      OURA,
      FITBIT,
      DISCLAIMER,
      REFRESH,
    ],
    [SCOPE_KIND],
  ],
  [
    "app/(app)/training/OverviewSection.tsx",
    [TEMPORAL, RPE_CAST, RPE_KEY, STREAK, OURA, FITBIT, SCOPE_KIND],
    [],
  ],
  // The two vendor allowlists stay SEPARATE: each surface keeps the other's ban.
  ["lib/queries/sleep.ts", [TEMPORAL, RPE_CAST, RPE_KEY, FITBIT], [OURA]],
  [
    "lib/integrations/registry.ts",
    [TEMPORAL, RPE_CAST, RPE_KEY, OURA],
    [FITBIT],
  ],
  [
    "lib/mobility-coverage.ts",
    [
      TEMPORAL,
      RPE_CAST,
      RPE_KEY,
      STREAK,
      OURA,
      FITBIT,
      STRENGTH_ENGINE,
      EXERCISE_SETS,
    ],
    [],
  ],
  [
    "lib/metric-window-overlap.ts",
    [TEMPORAL, RPE_CAST, RPE_KEY, STREAK, HEALTH_CONNECT],
    [],
  ],
  [
    "lib/integrations/health-connect-metrics.ts",
    [TEMPORAL, RPE_CAST, RPE_KEY, LEAF],
    [],
  ],
  // lib/revalidate.ts is the one module allowed to expose the raw API…
  ["lib/revalidate.ts", [TEMPORAL, TS_API], [REVALIDATE]],
  // …a shipped migration keeps its own spelling of the opt-in key (it cannot carry a
  // disable comment without changing its manifest sha256) and keeps everything else…
  [
    "lib/migrations/versions/20260820-rpe-column-opt-in.ts",
    [TEMPORAL, RPE_CAST, RPE_MINT],
    [RPE_KEY],
  ],
  // …and the action tests mock next/cache directly to observe the wrapper.
  [
    "lib/__action_tests__/ai-log-clear.actions.test.ts",
    [TEMPORAL],
    [REVALIDATE, DIALOG],
  ],
];

describe("eslint.config.mjs composes its bans instead of replacing them", () => {
  it.each(CASES)(
    "%s reaches the bans it should",
    async (file, must, mustNot) => {
      const messages = await messagesFor(file);
      for (const fragment of must)
        expect(messages, `${file} lost: ${fragment}`).toContain(fragment);
      for (const fragment of mustNot)
        expect(
          messages,
          `${file} should be exempt from: ${fragment}`
        ).not.toContain(fragment);
    }
  );
});

// The table above asks WHICH bans reach a file; it cannot ask whether a selector MATCHES
// anything, so a ban with a mis-spelled selector resolves into that list and catches
// nothing. These rows lint forged text through the same config, and the vendor-score trio
// is the case that earned them: `Literal` was anchored and `TemplateElement` was not, so
// `oura_sleep_score_v2` was an error inside a backtick and legal inside a quote (#5347).
// Even un-anchored, all three stay strictly narrower than the walker they replace, which
// matched raw file text and therefore its own comments.
const FORGED_FILE = "lib/vendor-score-fixture.ts";
const FORGED: [code: string, hits: number][] = [
  ['export const a = "oura_sleep_score";', 1],
  // A vendor score key with a suffix is still a vendor score key…
  ['export const b = "oura_sleep_score_v2";', 1],
  ["export const c = `oura_sleep_score_v2`;", 1],
  // …but a longer IDENTIFIER is a different symbol: a row field spelled
  // `oura_sleep_score_recorded_at` is a fact about DELIVERY, not the score — the same
  // argument that puts lib/integrations/registry.ts on the Fitbit allowlist — and
  // prefix-matching identifiers would ban it. That is why this form stays anchored. The
  // first spelling tried here, `ouraSleepScoreLabel`, could not fail either way: camelCase
  // cannot contain a snake_case kind, so the row proved nothing until it was rewritten.
  ["export const d = { oura_sleep_score_recorded_at: 1 };", 0],
];

describe("the vendor-score ban bites the same characters in every spelling", () => {
  it.each(FORGED)("%s", async (code, hits) => {
    const [result] = await eslint.lintText(code, { filePath: FORGED_FILE });
    expect(result.messages.filter((m) => m.message.includes(OURA)).length).toBe(
      hits
    );
  });
});
