import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DAILY,
  E2E_LOGIN_PROTEIN_SOURCES,
  E2E_LOGIN_PROTEIN_TRACKED,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import { openDashboardAll } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { frozenLocalHHMM, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { STEPS_DELTA_COMPLETE_HOUR } from "@/lib/steps-today";

// Dashboard daily-loop recomposition (issue #1221): the four new cards — Nutrition
// today, Steps today, Latest vitals, and Cycle phase — plus the folded "Take any
// meds?" branch of the "How are you today?" check-in.
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

  test("Nutrition-today card shows today's protein against the goal band", async () => {
    await page.goto("/");
    const card = dashboardCandidatePrefix(page, "nutrition.protein:");
    await expect(card).toBeVisible();
    // Today's protein figure. A floor basis marks itself with a trailing "+" (#3257,
    // the #1822 marker) — never "≥ N g", and never a hedge about the estimator.
    await expect(card).toContainText(/\d+ g\+/);
    // "g", NEVER "g/day" — on the band and on the average alike. The row's label
    // already names the window, so the unit must not name it again. Asserted with a
    // lookahead BECAUSE a plain substring cannot see the regression: /Goal \d+–\d+ g/
    // matches "Goal 95–130 g/day" perfectly well. The lookahead is exactly `(?!\/)`
    // and no wider — the row's text concatenates its door label straight onto the
    // last value ("…39 gNutrition"), so a `\w` boundary here would fail on the
    // CORRECT rendering and pass on nothing. The "/" is the whole difference between
    // the two spellings, so it is the whole test.
    //
    // This claim used to live in a component test over the Nutrition-today CARD. That
    // card is deleted (#3365): once the tail reports as rows it was reachable from no
    // lane, so the test observed markup no user could see. The claim did not move
    // altitude to be cheaper — it moved to the row a person actually reads.
    await expect(card).toContainText(/Goal \d+–\d+ g(?!\/)/);
    // The trailing average, which is the OTHER half of #1917's fix: a real
    // trailing-7 complete-day figure, labelled as one, in the same plain unit.
    await expect(card).toContainText(/7-day average \d+ g(?!\/)/);
    // The band's derivation and the goal label live in the row's hover now, not in the
    // glance line, and no source list or floor hedging survives anywhere in the row.
    await expect(card).not.toContainText("≥");
    await expect(card).not.toContainText("g/kg");
    await expect(card).not.toContainText(/floor|likely higher|logged foods \+/);
    await expect(card.getByRole("link")).toHaveAttribute("href", "/nutrition");

    // The honesty MOVED — it was not deleted (#3257). The row's disclosure control is
    // the whole mechanism for that, so its accessible name is asserted here: without
    // this, removing `disclosure:` from the presentation is a silent green.
    const explain = card.getByRole("button");
    await expect(explain).toHaveAttribute(
      "aria-label",
      /g\/kg.*Today's total is from.*aren't counted, so your real total may be higher\./s
    );
  });

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
  test("the protein row shows the LARGER floor and names both sources (#3903)", async ({
    browser,
  }) => {
    const own = await loginAs(browser, {
      username: E2E_LOGIN_PROTEIN_SOURCES,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await own.goto("/");
      const card = dashboardCandidatePrefix(own, "nutrition.protein:");
      await expect(card).toBeVisible();

      // max(20 tracked, 70 in-app) — and the "+" the tracked basis used to go without.
      // Scoped to the row's own amount rather than the page: "70" alone would be
      // satisfiable by the goal band or the 7-day average sitting beside it.
      await expect(card).toContainText("70 g+");
      await expect(card).not.toContainText("20 g");

      // The hover names BOTH records, and hedges for both reasons. Asserted as the exact
      // sentences: the failure this row exists for was a hover that named only the
      // winner, which every "contains a source phrase" matcher would have passed.
      const explain = own.getByRole("button", {
        name: /Today's total is from your food log and your health app\./,
      });
      await expect(explain).toHaveAttribute(
        "aria-label",
        /Today's total is from your food log and your health app\. Foods you haven't logged and meals your health app hasn't sent aren't counted, so your real total may be higher\./
      );
    } finally {
      await own.context().close();
    }
  });

  // THE STATE THAT SAID THE LEAST (#3903), which after the ruling is reached only when
  // the profile has logged nothing in-app at all. This is the row that used to print an
  // exact figure with a hover that volunteered nothing about incompleteness — and the
  // only fixture that fails if the floor marker's `tracked` exception returns.
  test("a tracked-only row is a floor too, and says why (#3903)", async ({
    browser,
  }) => {
    const own = await loginAs(browser, {
      username: E2E_LOGIN_PROTEIN_TRACKED,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await own.goto("/");
      const card = dashboardCandidatePrefix(own, "nutrition.protein:");
      await expect(card).toBeVisible();

      // "20 g+", never the bare "20 g" this basis shipped with. Asserted with the marker
      // attached, because "20 g" is a substring of "20 g+" and would pass on both.
      await expect(card).toContainText("20 g+");

      // Its OWN sentence, not the unlogged-foods one: for this basis the incompleteness
      // is unsent time, not unlogged food, and reusing the sibling sentence would state
      // something this state's data does not support.
      const explain = own.getByRole("button", {
        name: /Today's total is from the daily total your health app sends\./,
      });
      await expect(explain).toHaveAttribute(
        "aria-label",
        /Today's total is from the daily total your health app sends\. Meals your health app hasn't sent yet aren't counted, so your real total may be higher\./
      );
    } finally {
      await own.context().close();
    }
  });

  test("Steps-today card shows the prior-7-day baseline, and no partial-day delta", async () => {
    await page.goto("/");
    const card = dashboardCandidatePrefix(page, "activity.steps:");
    await expect(card).toBeVisible();
    await expect(card).toContainText(/[\d,]+/);
    // The baseline names the days it covers (#1909). "7-day average" is the phrase
    // this card must NOT use: the metric detail page's Rolling summary answers a
    // different question over a different window and would own that label.
    await expect(card).toContainText(/Prior 7 days · [\d,]+ steps a day/);
    await expect(card).not.toContainText(/7-day average/);

    // …and NO percentage, because the frozen clock sits at 13:mm profile-local (the
    // #1103 pin) and today is not a complete day yet (#3258). Today's 9,400 is above
    // the baseline, so the old line would have rendered a cheerful "+21% vs prior 7
    // days" over a partial sum measured against seven whole ones — the same artifact
    // that read −73% at midday and −47% that evening on one unchanged day.
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
    await expect(card).not.toContainText(/% vs prior 7 days/);
  });

  test("Latest-vitals card shows the most recent BP and resting HR", async () => {
    await page.goto("/");
    await openDashboardAll(page);
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    const hrCandidate = dashboardCandidatePrefix(
      page,
      "vitals.resting-heart-rate:"
    );
    await expect(bpCandidate).toBeVisible();
    await expect(hrCandidate).toBeVisible();
    // The most recent BP pair (118/76 in the seed) — a systolic/diastolic value.
    await expect(bpCandidate.getByTestId("vitals-latest-bp")).toContainText(
      /\d{2,3}\/\d{2,3}/
    );
    const hrReading = hrCandidate.getByTestId("vitals-latest-resting-hr");
    await expect(hrReading).toContainText(/\d+ bpm/);
    await expect(hrReading).not.toContainText("bpm resting");
    // Both readings are recent, so both provenance lines state a plain date with no
    // staleness tint — the #2303 floor frames only what it must (the age-labeled side is
    // pinned by e2e/dashboard-vitals-recency.spec.ts).
    await expect(
      bpCandidate.getByTestId("vitals-latest-bp-age")
    ).not.toHaveAttribute("data-stale", "true");
    await expect(
      hrCandidate.getByTestId("vitals-latest-resting-hr-age")
    ).not.toHaveAttribute("data-stale", "true");
    // #1892 SURVIVES ITS SURFACE (#3366). The claim was "the log affordance is present
    // WITH data, not only without it" — it used to live in the vitals empty state
    // alone, so the person who logs BP weekly had none. The 2026-08-29 ruling moved
    // every always-available write off the tail because the quick logger is the app's
    // one quick-write surface, which satisfies the claim unconditionally rather than
    // per-card. Both halves are asserted here: gone from the card, offered by the
    // sheet, on a profile that HAS vitals data — the case #1892 was filed about.
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

  test("Cycle-phase card shows the derived cycle day and phase (informational)", async () => {
    await page.goto("/");
    const card = dashboardCandidatePrefix(page, "cycle.phase:");
    await expect(card).toBeVisible();
    await expect(card).toContainText(/Day \d+/);
    await expect(card).toContainText(/menstrual|follicular|luteal/i);
    await expect(card.getByRole("link")).toHaveAttribute(
      "href",
      "/medical/cycles"
    );
  });

  test("the PRN medication action is its own atomic candidate", async () => {
    await page.goto("/");
    await openDashboardAll(page);
    const medication = dashboardCandidatePrefix(page, "intake.prn:");
    await expect(medication).toBeVisible();
    await expect(medication).toHaveAttribute("data-kind", "action");
    await expect(medication.getByTestId("quick-log-prn")).toBeVisible();
    // The fixture owns exactly one active PRN med, so the log control is unambiguous.
    await expect(medication.getByTestId("prn-log-now")).toBeVisible();
  });
});
