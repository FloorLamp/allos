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

// ── THE SECOND QUESTION: does the ban BITE? ─────────────────────────────────
// The table above asks which bans REACH a file. It cannot ask whether a selector matches
// anything, so a ban with a mis-spelled selector resolves into that list and catches
// nothing — green here, silent in CI, and indistinguishable from a guard. With the nine
// walkers deleted, nothing else in the repo asks. These rows lint forged text through the
// real config, one per invariant this step converted.
//
// The vendor trio earned them: `Literal` was anchored and `TemplateElement` was not, so
// `oura_sleep_score_v2` was an error inside a backtick and legal inside a quote (#5347).
// Even un-anchored, all three selectors stay strictly narrower than the walker they
// replace, which matched raw file text and therefore its own comments.
//
// EVERY ZERO ROW MUST DISCRIMINATE. A converse that passes whether or not the exemption
// exists is worse than no row: it reads as a control and proves nothing. Each is checked
// by mutating the rule it names and confirming that row — and only that row — reds.
const LIFT_CATALOG = "must not be sourced from the lift catalog";

// A path with no file on disk; `lintText` resolves config by path, not by reading it.
const FIXTURE = "lib/bite-fixture.ts";

// file, forged source, the ban's own message fragment, how many times it must fire
const BITES: [file: string, code: string, fragment: string, hits: number][] = [
  // The two selectors this step revived, dead on main since #5356 landed after them.
  // NOTE the destructure: the selector reaches `const { revalidatePath } = await
  // import(...)` and NOT `(await import("next/cache")).revalidatePath`, which is
  // unguarded here and on main alike. That is a limitation of the selector, not an
  // exemption, so it is written down rather than pinned green as if it were one.
  [
    FIXTURE,
    'export async function f() { const { revalidatePath } = await import("next/cache"); return revalidatePath; }',
    REVALIDATE,
    1,
  ],
  [
    FIXTURE,
    'export const f = (page: { on: (e: string, h: () => void) => void }) => page.on("dialog", () => {});',
    DIALOG,
    1,
  ],

  // rpe-opt-in (#3335): one importer of the minter, no cast past the brand, one spelling
  // of the stored key.
  [
    FIXTURE,
    'import { mintRpeTracking } from "@/lib/rpe";\nexport const f = mintRpeTracking;',
    RPE_MINT,
    1,
  ],
  [FIXTURE, "export const f = (x: unknown) => x as RpeTracking;", RPE_CAST, 1],
  [FIXTURE, 'export const k = "strength_rpe";', RPE_KEY, 1],
  // A shipped migration is frozen text — its sha256 is in the manifest — so it cannot
  // carry a disable comment and is exempt by `ignores` instead.
  [
    "lib/migrations/versions/20260820-rpe-column-opt-in.ts",
    'export const k = "strength_rpe";',
    RPE_KEY,
    0,
  ],

  // streak-scope (#1935…#1966): one caller, and it states which question it asks.
  [
    FIXTURE,
    'import { currentStreak } from "./streak";\nexport const f = currentStreak;',
    STREAK,
    1,
  ],

  // disclaimers (#1049): a domain surface deletes its inline disclaimer rather than
  // importing the copy; /disclaimer is the page the copy is consolidated onto.
  [
    "app/(app)/bite-fixture/page.tsx",
    'import { DISCLAIMER_SECTIONS } from "@/lib/disclaimers";\nexport const f = DISCLAIMER_SECTIONS;',
    DISCLAIMER,
    1,
  ],
  [
    "app/(app)/disclaimer/page.tsx",
    'import { DISCLAIMER_SECTIONS } from "@/lib/disclaimers";\nexport const f = DISCLAIMER_SECTIONS;',
    DISCLAIMER,
    0,
  ],

  // vendor-score-engine-inert (#1069): the same characters banned in every spelling.
  [FIXTURE, 'export const a = "oura_sleep_score";', OURA, 1],
  // A vendor score key with a suffix is still a vendor score key…
  [FIXTURE, 'export const b = "oura_sleep_score_v2";', OURA, 1],
  [FIXTURE, "export const c = `oura_sleep_score_v2`;", OURA, 1],
  // …but a longer IDENTIFIER is a different symbol: a row field spelled
  // `oura_sleep_score_recorded_at` is a fact about DELIVERY, not the score — the same
  // argument that puts lib/integrations/registry.ts on the Fitbit allowlist — so that
  // form stays anchored. The first spelling tried here, `ouraSleepScoreLabel`, could not
  // fail either way: camelCase cannot contain a snake_case kind, so it proved nothing
  // and was replaced. Do not put it back.
  [FIXTURE, "export const d = { oura_sleep_score_recorded_at: 1 };", OURA, 0],
  // The two allowlists stay SEPARATE — the Sleep page's query may name an Oura kind and
  // is still banned from naming a Fitbit one.
  ["lib/queries/sleep.ts", 'export const e = "oura_sleep_score";', OURA, 0],
  ["lib/queries/sleep.ts", 'export const g = "fitbit_sleep_score";', FITBIT, 1],

  // db-import-boundary (#3520): the startup boundary, and the leaf that makes it one.
  [
    "lib/metric-window-overlap.ts",
    'import type { A } from "./integrations/health-connect";\nexport type B = A;',
    HEALTH_CONNECT,
    1,
  ],
  [
    "lib/integrations/health-connect-metrics.ts",
    'import type { A } from "./health-connect";\nexport type B = A;',
    LEAF,
    1,
  ],

  // mobility-coverage-apart (#482): "mobilized?" is not "trained?".
  [
    "lib/mobility-coverage.ts",
    'import { coverageFromSets } from "./muscle-coverage";\nexport const f = coverageFromSets;',
    STRENGTH_ENGINE,
    1,
  ],
  [
    "lib/mobility-coverage.ts",
    'import { liftInfo } from "./lift-catalog";\nexport const f = liftInfo;',
    LIFT_CATALOG,
    1,
  ],
  [
    "lib/mobility-coverage.ts",
    'export const q = "exercise_sets";',
    EXERCISE_SETS,
    1,
  ],

  // cadence-home (#2888): a private scope_kind list is the subtraction that issue removed.
  [
    "app/(app)/training/bite-fixture.ts",
    'export const f = (r: { scope_kind: string }) => r.scope_kind !== "practice";',
    SCOPE_KIND,
    1,
  ],

  // chrome-refresh-scan (#1878): every router.refresh() is classified or it is an error.
  [
    "components/BiteFixture.tsx",
    "export const f = (router: { refresh: () => void }) => router.refresh();",
    REFRESH,
    1,
  ],
];

describe("each converted ban still bites the shape it was written for", () => {
  it.each(BITES)("%s — %s", async (file, code, fragment, hits) => {
    const [result] = await eslint.lintText(code, { filePath: file });
    expect(
      result.messages.filter((m) => m.message.includes(fragment)).length,
      `${file}: expected ${hits} hit(s) on "${fragment}"`
    ).toBe(hits);
  });
});
