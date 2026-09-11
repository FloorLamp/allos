import { test, expect } from "./fixtures";
import { appContent } from "./helpers";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DAILY,
  E2E_LOGIN_PROTEIN_SOURCES,
  E2E_LOGIN_PROTEIN_TRACKED,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { frozenLocalHHMM, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { STEPS_DELTA_COMPLETE_HOUR } from "@/lib/steps-today";

// The daily loop (issue #1221) — WHAT HOME STATES ABOUT TODAY.
//
// #1221 added four cards: Nutrition today, Steps today, Latest vitals and Cycle phase.
// #4076 made them ranker rows. Home v3 (#5435 §3.2) replaces the ranker with fixed
// seats and ONE FACTS LINE above the day's chart, which is where today's protein and
// today's steps are stated now — the same `proteinTodayLineParts` and
// `summarizeStepsToday` models, in the facts line's terser grammar. Cycle is a seat.
// Vitals are not on Home at all.
//
// SO THE CLAIMS SPLIT, AND EACH HALF IS HANDLED ON ITS OWN TERMS. What the MODEL says
// — the floor marker, the larger-of-two figure, the goal band's unit spelling, the
// baseline window, the withheld partial-day delta — still has a reader, and is read
// off the facts line below. What the ROW's affordances said — the door to /nutrition,
// the hover that explains why a floor is a floor — does not, and each is retired with
// a note naming what went and where the claim still lives.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_DAILY in its OWN cookie
// context on a dedicated adult FEMALE profile (DAILY_LOOP_PROFILE) seeded with one
// reading in every domain, dated to the fixture's "today" so each card renders
// populated. Read-only — the spec asserts presence + value PATTERNS (never an exact
// shared-seed count), so a neighbor's write or a --repeat-each run can't break it.

test.describe("dashboard daily loop (#1221)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_DAILY,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("Home's facts line states today's protein against the goal band", async () => {
    await page.goto("/");
    const facts = appContent(page).getByTestId("home-facts");
    await expect(facts).toBeVisible();
    // Today's protein figure. A floor basis marks itself with a trailing "+" (#3257,
    // the #1822 marker) — never "≥ N g", and never a hedge about the estimator.
    await expect(facts).toContainText(/\d+ g\+/);
    // "g", NEVER "g/day" — on the band and on the average alike. The row's label
    // already names the window, so the unit must not name it again. Asserted with a
    // lookahead BECAUSE a plain substring cannot see the regression: /Goal \d+–\d+ g/
    // matches "Goal 95–130 g/day" perfectly well. The lookahead is exactly `(?!\/)`
    // and no wider — the facts line concatenates its parts with " · ", so a `\w`
    // boundary here would fail on the CORRECT rendering and pass on nothing. The "/"
    // is the whole difference between the two spellings, so it is the whole test.
    //
    // This claim used to live in a component test over the Nutrition-today CARD, then
    // on the tail's row (#3365). It has never moved altitude to be cheaper — it moves
    // to whatever a person actually reads, which is now this line.
    await expect(facts).toContainText(/Goal \d+–\d+ g(?!\/)/);
    // No source list and no floor hedging survives anywhere in the line.
    await expect(facts).not.toContainText("≥");
    await expect(facts).not.toContainText("g/kg");
    await expect(facts).not.toContainText(
      /floor|likely higher|logged foods \+/
    );
  });

  // ── THE HONESTY HOVER HAS NO READER (#3257, #5435 §3.2) ───────────────────────
  //
  // Two assertions retired with the row: that the protein row's door goes to
  // `/nutrition`, and that its disclosure control's accessible name carries
  // `proteinTodayExplanation` — the band's derivation, where today's grams came from,
  // and why a floor basis is not the whole day.
  //
  // Home's facts line is a STATEMENT: a number and a goal, no door and no disclosure.
  // `proteinTodayExplanation` is therefore called by nothing in the app — verified by
  // grep, not assumed — and the "#3257 moved the honesty, it was not deleted" claim
  // this file made has no rendered instance left.
  //
  // WHAT STILL HOLDS IT: lib/__tests__/protein-today.test.ts pins all four bases and
  // the exact sentence each one is allowed to say, including the #3903 rewrite. So the
  // WORDS cannot rot; what is unproven is that a reader ever sees them.
  //
  // THIS IS AN OWNER QUESTION, NOT A CLEANUP. §3.2 gives the facts line no hover, and
  // whether the floor's explanation should be seated somewhere on Home is not
  // something #5435 answers or PR 2 should invent.

  // THE TRACKED BRANCH, RENDERED (#3903). Until this test the protein row's tracked
  // basis reached no rendered test at all — which is how it kept an exact figure and a
  // hover with no hedge through #3888's survey of the other four states.
  //
  // Its own login/context rather than the describe's shared page: the fixture is the only
  // one carrying a tracked protein_g, and it is a different profile.
  //
  // WHY THIS FIXTURE DISCRIMINATES: today holds 70 g logged in-app against a 20 g health
  // app reading. The retired override returned the health app's 20 g and zeroed the rest,
  // so a tree still carrying it renders "20 g" here — the smaller number.
  //
  // It catches the OVERRIDE half only. Its basis is `both-sources`, not `tracked`, so the
  // floor marker's old `tracked` exception leaves this row's "+" untouched; the
  // tracked-only test below is the one that sees that half.
  test("the facts line states the LARGER floor of the two sources (#3903)", async ({
    browser,
  }) => {
    const own = await loginAs(browser, {
      username: E2E_LOGIN_PROTEIN_SOURCES,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await own.goto("/");
      const facts = appContent(own).getByTestId("home-facts");
      await expect(facts).toBeVisible();

      // max(20 tracked, 70 in-app) — and the "+" the tracked basis used to go without.
      // Scoped to the facts line rather than the page: "70" alone would be satisfiable
      // by the goal band or a step count sitting beside it.
      await expect(facts).toContainText("70 g+");
      await expect(facts).not.toContainText("20 g");

      // THE HOVER HALF RETIRED WITH THE ROW. It asserted the exact sentence naming
      // BOTH records, because the failure this fixture exists for was a hover that
      // named only the winner. Home's facts line has no hover, and
      // `proteinTodayExplanation` has no production reader at all — see the note above
      // the tracked test. The sentence itself stays pinned, for this basis and the
      // other three, in lib/__tests__/protein-today.test.ts.
      //
      // WHAT THIS FIXTURE STILL DISCRIMINATES, which is why it is repaired rather than
      // retired: the retired override returned the health app's 20 g and zeroed the
      // rest, so a tree still carrying it renders the SMALLER number here. That is the
      // half this login was seeded for, and it is asserted above.
    } finally {
      await own.context().close();
    }
  });

  // THE STATE THAT SAID THE LEAST (#3903), which after the ruling is reached only when
  // the profile has logged nothing in-app at all. This is the row that used to print an
  // exact figure with a hover that volunteered nothing about incompleteness — and the
  // only fixture that fails if the floor marker's `tracked` exception returns.
  test("a tracked-only basis is a floor too, and wears the marker (#3903)", async ({
    browser,
  }) => {
    const own = await loginAs(browser, {
      username: E2E_LOGIN_PROTEIN_TRACKED,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await own.goto("/");
      const facts = appContent(own).getByTestId("home-facts");
      await expect(facts).toBeVisible();

      // "20 g+", never the bare "20 g" this basis shipped with. Asserted with the marker
      // attached, because "20 g" is a substring of "20 g+" and would pass on both. This
      // is the ONLY fixture that fails if the floor marker's `tracked` exception
      // returns, so the marker is what this login is here for.
      await expect(facts).toContainText("20 g+");

      // Its OWN sentence — the unsent-meals one, not the unlogged-foods one — retired
      // with the hover. It is pinned per basis in lib/__tests__/protein-today.test.ts.
    } finally {
      await own.context().close();
    }
  });

  test("Home's facts line states the prior-7-day baseline, and no partial-day delta", async () => {
    await page.goto("/");
    const facts = appContent(page).getByTestId("home-facts");
    await expect(facts).toBeVisible();
    await expect(facts).toContainText(/[\d,]+ steps/);
    // The baseline NAMES THE DAYS IT COVERS (#1909) — the claim, which the facts
    // line's terser grammar keeps ("prior 7 days 8,200" where the row said "Prior 7
    // days · 8,200 steps a day"). "7-day average" is the phrase it must NOT use: the
    // metric detail page's Rolling summary answers a different question over a
    // different window and would own that label.
    await expect(facts).toContainText(/prior 7 days [\d,]+/i);
    await expect(facts).not.toContainText(/7-day average/);

    // …and NO percentage, because the frozen clock sits at 13:mm profile-local (the
    // #1103 pin) and today is not a complete day yet (#3258). Today's 9,400 is above
    // the baseline, so the old line would have rendered a cheerful "+21% vs prior 7
    // days" over a partial sum measured against seven whole ones — the same artifact
    // that read −73% at midday and −47% that evening on one unchanged day. Asserted
    // as "no percent sign on the line at all", which is stronger than the row's
    // phrase-specific check and is available here because the facts line states
    // figures and windows only.
    const localHour = Number(
      frozenLocalHHMM(pinnedTimezone(frozenNow().toISOString()).zone).slice(
        0,
        2
      )
    );
    expect(
      localHour,
      "the pinned local hour must sit BELOW the gate, or this asserts nothing"
    ).toBeLessThan(STEPS_DELTA_COMPLETE_HOUR);
    await expect(facts).not.toContainText(/%/);
  });

  // ── LATEST VITALS ARE NOT ON HOME (#1221, #5435 §3.2) ─────────────────────────
  //
  // A test here read the BP and resting-HR rows off the tail: the most recent pair,
  // the "N bpm" spelling that must not read "bpm resting", and the #2303 provenance
  // line carrying no staleness tint while both readings are fresh. Home v3 seats
  // dose / practice / care / training / fast / period and states sleep, steps,
  // protein and the day's sun facts — vitals are neither a seat nor a fact, so those
  // rows have no surface. The age-labeled converse was already pinned by
  // e2e/dashboard-vitals-recency.spec.ts, which retired with the rest of Group A.
  //
  // #1892's CLAIM SURVIVES ITS SURFACE, AND THAT IS WHAT THIS TEST IS NOW. The claim
  // was "the log affordance is present WITH data, not only without it" — it used to
  // live in the vitals empty state alone, so the person who logs BP weekly had none.
  // The 2026-08-29 ruling moved every always-available write off the tail because the
  // quick logger is the app's one quick-write surface. BOTH HALVES still run, on the
  // profile that HAS vitals data, which is the case #1892 was filed about.
  test("#1892: measurements are offered by the quick logger, on a profile that has vitals", async () => {
    await page.goto("/");
    // The Now band rendered, so the absences below are read against a real page and
    // not against a 404 or an unrendered shell.
    await expect(appContent(page).getByTestId("home-now")).toBeVisible();
    await expect(
      dashboardCandidatePrefix(page, "vitals.manual-log")
    ).toHaveCount(0);
    await expect(page.getByTestId("vitals-log-reading")).toHaveCount(0);
    // The puck is phone-only chrome, so the viewport moves for this one assertion
    // and moves back — every other test in this file shares this page at 1280.
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      const sheet = await openLogSheet(page);
      const row = await showLogRow(sheet, "log-measurements");
      await row.click();
      await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
        "data-form",
        "measurements"
      );
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  // ── THE CYCLE-PHASE CARD HAS NO SUCCESSOR ON HOME (#1221, #5435 §3.2) ─────────
  //
  // A test here read the derived cycle day, the phase word (menstrual / follicular /
  // luteal) and the `/medical/cycles` door off the `cycle.phase:` row. All three
  // retire, and the near-miss is worth writing down because it was tried: Home seats
  // Period, and that seat's title IS "Period · day N" — but only while a period is
  // OPEN. This fixture is mid-cycle with none open, so its seat reads "Period" and
  // offers Start.
  //
  // The two are not the same claim. The card was INFORMATIONAL — where you are in the
  // cycle on any day, whether or not you are bleeding. The seat is a STATE AND A
  // WRITE: what is running, and the one tap that starts or ends it. Repairing this
  // onto the seat would have asserted the card's sentence against a row that does not
  // make it, and passed only on fixtures that happen to be bleeding.
  //
  // WHAT RETIRED: the rendered informational phase, its day, and its door. What did
  // not: the phase derivation itself, which is untouched in the cycle model and its
  // own tests, and the seat's open-period state, which e2e/cycle-log-affordance.spec.ts
  // exercises end to end across all three of the offer's renderers.

  // #1221's PRN branch FOLLOWS ITS CAPABILITY (#4076 ruling 4), the same move #3366
  // made for the vitals log above and #4083 for the weigh-in. The tail used to render
  // one `intake.prn:<id>` candidate per active PRN item, each embedding the full dose
  // logger; the quick logger's Consume segment already owned doses, so the tail's
  // copies retired rather than being restated as a row that cannot host them.
  //
  // BOTH HALVES, as that ruling's precedent requires: asserting only the removal
  // would pass just as happily on a tree where dose logging vanished instead of
  // moving. This fixture owns exactly one active PRN med and rendered its card before
  // the change, which is what makes the absence a real removal rather than a
  // selector that never matched.
  test("PRN dose logging left Home for the quick logger", async () => {
    await page.goto("/");

    // The control: this profile's Home rendered and holds rows, so the absence below
    // is about a populated page and not an empty selector. It was the tail's own
    // contents before #5435 §4; the Now band is what carries rows here.
    expect(await page.locator("[data-candidate-id]").count()).toBeGreaterThan(
      0
    );
    await expect(dashboardCandidatePrefix(page, "intake.prn:")).toHaveCount(0);
    await expect(page.getByTestId("quick-log-prn")).toHaveCount(0);

    // The puck is phone-only chrome, so the viewport moves for this one assertion
    // and moves back — every other test in this file shares this page at 1280.
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      const sheet = await openLogSheet(page);
      await expect(await showLogRow(sheet, "log-dose")).toBeVisible();
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });
});
