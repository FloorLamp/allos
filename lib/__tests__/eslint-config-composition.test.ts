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
// The e2e hygiene bans (#5350). Each was a per-file count frozen at zero with an
// empty allowlist; four files each own one group and keep every other one.
const NETWORKIDLE = "settles on network silence";
const WAIT_TIMEOUT = "waitForTimeout(...) asserts nothing";
const FIRST = ".first() on a shared surface";
const TOPASS = "passes within N attempts";
const TEST_SKIP = "committed test.skip";
const CI_BRANCH = "The harness serves ONE build shape";
const MULTI_BOX = "Two boundingBox() reads through one Promise.all";
const SWIPE = "may only be an inline { x, y } literal";
const CONFIRM_DELETE = "confirm dialog's Delete can be swallowed";
const DOC_OVERFLOW = "document-level width comparison asserts nothing";
const BARE_YEAR = "A bare fixed year is not a date contract";
const FAMILY_LOGIN = "use createLoginViaFamily";
const FAMILY_PROFILE = "use createProfileViaFamily";
const FAMILY_GRANTS = "use setGrantsViaFamily";
const PROFILE_INSERT = "A raw INSERT INTO profiles";
const PROFILE_DELETE = "A raw DELETE FROM profiles";
const PW_TEST = "opts out of the DB-per-worker harness";
const DB_PATH = "ALLOS_DB_PATH is the APP SERVER's environment";
const WALL_CLOCK = "the harness's frozen now";
const ACTIVITY_DELETE = "use deleteActivitiesTitled";
const E2E_EVERY_BAN = [
  NETWORKIDLE,
  WAIT_TIMEOUT,
  FIRST,
  TOPASS,
  TEST_SKIP,
  CI_BRANCH,
  MULTI_BOX,
  SWIPE,
  CONFIRM_DELETE,
  DOC_OVERFLOW,
  BARE_YEAR,
  FAMILY_LOGIN,
  FAMILY_PROFILE,
  FAMILY_GRANTS,
  PROFILE_INSERT,
  PROFILE_DELETE,
  PW_TEST,
  DB_PATH,
  WALL_CLOCK,
];
const without = (...dropped: string[]) =>
  E2E_EVERY_BAN.filter((ban) => !dropped.includes(ban));
const DATE_PARSE = "Date.parse answers in the SERVER's zone";

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
      DATE_PARSE,
    ],
    [SCOPE_KIND],
  ],
  // The clock seam (#5338) reaches lib/, and its on-touch population is exempt BY FILE
  // while keeping every other ban — an on-touch app surface keeps #1878 in particular.
  ["lib/share-links.ts", [TEMPORAL, RPE_CAST, STREAK, DATE_PARSE], []],
  ["lib/weight-anomaly.ts", [TEMPORAL, RPE_CAST, STREAK], [DATE_PARSE]],
  ["components/illness/FeverChart.tsx", [TEMPORAL, REFRESH], [DATE_PARSE]],
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
    [REVALIDATE, DIALOG, DATE_PARSE],
  ],

  // ── e2e/** (#5350) ────────────────────────────────────────────────────────
  // A spec reaches every ban, including the one scoped to specs alone…
  [
    "e2e/dashboard.spec.ts",
    [TEMPORAL, DIALOG, REVALIDATE, ...E2E_EVERY_BAN, ACTIVITY_DELETE],
    [RPE_CAST, OURA, STREAK, REFRESH],
  ],
  // …a driver module reaches every ban EXCEPT that one, because a fixture module
  // delete-then-inserts to stay idempotent and that is not a spec's cleanup.
  ["e2e/nav.ts", [TEMPORAL, DIALOG, ...E2E_EVERY_BAN], [ACTIVITY_DELETE]],
  // The blessed interaction module OWNS the settle patterns it centralizes, so it
  // was the scan's ONE exclusion and falls back to the level above here.
  ["e2e/helpers.ts", [TEMPORAL, DIALOG], [...E2E_EVERY_BAN, ACTIVITY_DELETE]],
  // The three converses: each file drops exactly the group it owns and keeps the
  // rest. A ladder of `ignores` would have dropped the groups BELOW them too.
  [
    "e2e/family-helpers.ts",
    without(FAMILY_LOGIN, FAMILY_PROFILE, FAMILY_GRANTS),
    [FAMILY_LOGIN, FAMILY_PROFILE, FAMILY_GRANTS, ACTIVITY_DELETE],
  ],
  [
    "e2e/fixture-profile.ts",
    without(PROFILE_INSERT, PROFILE_DELETE),
    [PROFILE_INSERT, PROFILE_DELETE, ACTIVITY_DELETE],
  ],
  [
    "e2e/fixtures.ts",
    without(PW_TEST, DB_PATH, WALL_CLOCK),
    [PW_TEST, DB_PATH, WALL_CLOCK, ACTIVITY_DELETE],
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
// The same, under e2e/ — and the four real files whose exemptions are the converse
// half of the e2e rows. `Loc` is never declared: these are lints, not compiles.
const E2E_SPEC = "e2e/bite-fixture.spec.ts";
const E2E_MODULE = "e2e/bite-fixture.ts";
const E2E_HELPERS = "e2e/helpers.ts";
const E2E_FAMILY = "e2e/family-helpers.ts";
const E2E_FIXTURE_PROFILE = "e2e/fixture-profile.ts";
const E2E_FIXTURES = "e2e/fixtures.ts";

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

  // ── e2e hygiene (#5350) ───────────────────────────────────────────────────
  // Nineteen bans, each shown biting the shape the retired scan's regex matched —
  // and, where the selector is narrower than "the words appear", shown STAYING
  // QUIET on the neighbour that made the regex hard to write. Every zero row here
  // is checked by revoking the exemption (or widening the selector) it names and
  // confirming that row, and only that row, reds.
  [E2E_SPEC, 'await page.waitForLoadState("networkidle");', NETWORKIDLE, 1],
  [E2E_SPEC, "await page.waitForTimeout(50);", WAIT_TIMEOUT, 1],
  [E2E_SPEC, "export const f = (l: Loc) => l.first();", FIRST, 1],
  [E2E_SPEC, "await expect(async () => {}).toPass({ timeout: 1 });", TOPASS, 1],
  [E2E_SPEC, 'test.skip("x", () => {});', TEST_SKIP, 1],
  [E2E_SPEC, "export const f = process.env.CI ? 1 : 2;", CI_BRANCH, 1],
  [
    E2E_SPEC,
    "export const f = async (x: Loc, y: Loc) => Promise.all([x.boundingBox(), y.boundingBox()]);",
    MULTI_BOX,
    1,
  ],
  // A third element between the two boxes still reds — the retired regex's lazy gap
  // could walk out of one Promise.all into the next and pair a box with a stranger's.
  [
    E2E_SPEC,
    "export const f = async (x: Loc, y: Loc) => Promise.all([x.count(), x.boundingBox(), y.boundingBox()]);",
    MULTI_BOX,
    1,
  ],
  // …and ONE box is the honest single read the rule must not fire on. Widening the
  // selector to drop the `~` sibling clause reds this row and nothing else.
  [
    E2E_SPEC,
    "export const f = async (x: Loc) => Promise.all([x.boundingBox()]);",
    MULTI_BOX,
    0,
  ],
  [E2E_SPEC, "await touchSwipe(page, grip, { x: grip.x, y: 1 });", SWIPE, 1],
  // A document-anchored gesture names its coordinates inline; that is the whole
  // distinction, so the literal form must stay legal.
  [
    E2E_SPEC,
    "await touchSwipe(page, { x: 2, y: 5 }, { x: 220, y: 505 });",
    SWIPE,
    0,
  ],
  [
    E2E_SPEC,
    'await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" }).click();',
    CONFIRM_DELETE,
    1,
  ],
  // `name: "Delete"` is anchored on its closing quote on purpose: the longer
  // destructive labels drive tables this teardown ban does not read.
  [
    E2E_SPEC,
    'await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete login" }).click();',
    CONFIRM_DELETE,
    0,
  ],
  [
    E2E_SPEC,
    "export const f = () => document.documentElement.scrollWidth;",
    DOC_OVERFLOW,
    1,
  ],
  [E2E_SPEC, 'await expect(row).toContainText("2024");', BARE_YEAR, 1],
  // The negated form is the one that turns VACUOUSLY green, so it is the half that
  // most needs catching (#4369).
  [E2E_SPEC, 'await expect(row).not.toContainText("2024");', BARE_YEAR, 1],
  [
    E2E_SPEC,
    "await expect(row).toContainText(/logged 2024-05/);",
    BARE_YEAR,
    1,
  ],
  // A year inside a longer string is a fixture-derived display date, which is the
  // thing the rule asks for. Un-anchoring the string arm reds this row alone.
  [E2E_SPEC, 'await expect(row).toContainText("Jan 2024");', BARE_YEAR, 0],
  [
    E2E_SPEC,
    'await page.getByPlaceholder("Username").fill("x");',
    FAMILY_LOGIN,
    1,
  ],
  [E2E_SPEC, 'export const s = "Add a profile";', FAMILY_PROFILE, 1],
  [E2E_SPEC, "export const s = `Save access`;", FAMILY_GRANTS, 1],
  // The blessed home OWNS the three markers by design — and still may not spell a
  // raw profile write, which a nested `ignores` ladder would have excused.
  [
    E2E_FAMILY,
    'await page.getByPlaceholder("Username").fill("x");',
    FAMILY_LOGIN,
    0,
  ],
  [
    E2E_FAMILY,
    'db.exec("INSERT INTO profiles (name) VALUES (?)");',
    PROFILE_INSERT,
    1,
  ],
  [
    E2E_SPEC,
    'db.exec("INSERT OR IGNORE INTO profiles (name) VALUES (?)");',
    PROFILE_INSERT,
    1,
  ],
  [
    E2E_SPEC,
    'db.exec("DELETE FROM profiles WHERE id = ?");',
    PROFILE_DELETE,
    1,
  ],
  // The constructor pair's home — and it still may not spell an inline family
  // create, the converse of the row two above.
  [
    E2E_FIXTURE_PROFILE,
    'db.exec("INSERT INTO profiles (name) VALUES (?)");',
    PROFILE_INSERT,
    0,
  ],
  [
    E2E_FIXTURE_PROFILE,
    'await page.getByPlaceholder("Username").fill("x");',
    FAMILY_LOGIN,
    1,
  ],
  [
    E2E_SPEC,
    'import { test } from "@playwright/test";\nexport const t = test;',
    PW_TEST,
    1,
  ],
  // A TYPE import from the same module is not the opt-out and must stay legal.
  [
    E2E_SPEC,
    'import type { Page } from "@playwright/test";\nexport type P = Page;',
    PW_TEST,
    0,
  ],
  [E2E_SPEC, "export const p = process.env.ALLOS_DB_PATH;", DB_PATH, 1],
  [E2E_SPEC, "export const t = Date.now();", WALL_CLOCK, 1],
  [E2E_SPEC, "export const t = new Date();", WALL_CLOCK, 1],
  // `new Date(iso)` reads a fixture-derived instant, not the wall clock.
  [E2E_SPEC, 'export const t = new Date("2020-01-02");', WALL_CLOCK, 0],
  // The harness takes the ONE wall-clock reading frozenNow() is derived from, and
  // is still held to every other ban — `.first()` among them.
  [E2E_FIXTURES, "export const t = Date.now();", WALL_CLOCK, 0],
  [
    E2E_FIXTURES,
    'import { test } from "@playwright/test";\nexport const t = test;',
    PW_TEST,
    0,
  ],
  [E2E_FIXTURES, "export const f = (l: Loc) => l.first();", FIRST, 1],
  // The blessed interaction module was the scan's ONE exclusion.
  [E2E_HELPERS, "await page.waitForTimeout(50);", WAIT_TIMEOUT, 0],
  [E2E_HELPERS, "export const f = (l: Loc) => l.first();", FIRST, 0],
  // #3946's census found five spellings of the shared-profile cleanup; a rule
  // written for `WHERE title = ?` alone would have shipped green and blind to four.
  [
    E2E_SPEC,
    'db.exec("DELETE FROM activities WHERE profile_id = 1 AND title = ?");',
    ACTIVITY_DELETE,
    1,
  ],
  [
    E2E_SPEC,
    "db.exec(`DELETE FROM activities\n  WHERE title IN (?, ?)`);",
    ACTIVITY_DELETE,
    1,
  ],
  // It stops short of `LIKE` on purpose: a prefix sweep is a different contract from
  // the helper's exact-title delete, and two specs use one legitimately.
  [
    E2E_SPEC,
    'db.exec("DELETE FROM activities WHERE title LIKE ?");',
    ACTIVITY_DELETE,
    0,
  ],
  // SPECS ONLY — a seed module delete-then-inserts to stay idempotent, which is its
  // job. Dropping the `*.spec.ts` block's narrower `files` reds this row alone.
  [
    E2E_MODULE,
    'db.exec("DELETE FROM activities WHERE title = ?");',
    ACTIVITY_DELETE,
    0,
  ],
  // the clock seam (#5338): a new Date.parse is an error in lib/ and on the app
  // surface alike; an on-touch file is exempt from this ban only, and a test tier from
  // all of it.
  [FIXTURE, "export const f = (s: string) => Date.parse(s);", DATE_PARSE, 1],
  [
    "components/BiteFixture.tsx",
    "export const f = (s: string) => Date.parse(s);",
    DATE_PARSE,
    1,
  ],
  [
    "lib/weight-anomaly.ts",
    "export const f = (s: string) => Date.parse(s);",
    DATE_PARSE,
    0,
  ],
  [
    "components/illness/FeverChart.tsx",
    "export const f = (router: { refresh: () => void }) => router.refresh();",
    REFRESH,
    1,
  ],
  [
    "lib/__tests__/bite-fixture.test.ts",
    "export const f = (s: string) => Date.parse(s);",
    DATE_PARSE,
    0,
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
