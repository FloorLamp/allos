import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { dashboardCandidatePrefix } from "./dashboard-candidate";

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
    // Today's protein figure (a floor, "≥ N g") — the seeded food gives a non-zero read.
    await expect(card).toContainText(/\d+ g/);
    await expect(card).toContainText(/Goal/);
    await expect(card.getByRole("link")).toHaveAttribute("href", "/nutrition");
  });

  test("Steps-today card shows today's steps versus the prior 7 days", async () => {
    await page.goto("/");
    const card = dashboardCandidatePrefix(page, "activity.steps:");
    await expect(card).toBeVisible();
    await expect(card).toContainText(/[\d,]+/);
    // The baseline names the days it covers (#1909). "7-day average" is the phrase
    // this card must NOT use: the metric detail page's Rolling summary answers a
    // different question over a different window and would own that label.
    await expect(card).toContainText(/Prior 7 days · [\d,]+ steps a day/);
    await expect(card).not.toContainText(/7-day average/);
    // Today (9,400) is above the baseline → an up delta line renders.
    await expect(card).toContainText(/% vs prior 7 days/);
  });

  test("Latest-vitals card shows the most recent BP and resting HR", async () => {
    await page.goto("/");
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    const hrCandidate = dashboardCandidatePrefix(
      page,
      "vitals.resting-heart-rate:"
    );
    const logCandidate = dashboardCandidatePrefix(page, "vitals.manual-log");
    await expect(bpCandidate).toBeVisible();
    await expect(hrCandidate).toBeVisible();
    // The most recent BP pair (118/76 in the seed) — a systolic/diastolic value.
    await expect(bpCandidate.getByTestId("vitals-latest-bp")).toContainText(
      /\d{2,3}\/\d{2,3}/
    );
    await expect(
      hrCandidate.getByTestId("vitals-latest-resting-hr")
    ).toContainText(/bpm resting/);
    // Both readings are recent, so both provenance lines state a plain date with no
    // staleness tint — the #2303 floor frames only what it must (the age-labeled side is
    // pinned by e2e/dashboard-vitals-recency.spec.ts).
    await expect(
      bpCandidate.getByTestId("vitals-latest-bp-age")
    ).not.toHaveAttribute("data-stale", "true");
    await expect(
      hrCandidate.getByTestId("vitals-latest-resting-hr-age")
    ).not.toHaveAttribute("data-stale", "true");
    // #1892: the log affordance is present WITH data, not only without it. It used to
    // live in the empty state alone, so the person who logs BP weekly — the one who
    // actually opens this card — had none. It opens the same shared measurements
    // quick-entry the empty CTA opens.
    const logReading = logCandidate.getByTestId("vitals-log-reading");
    await expect(logReading).toHaveText("Log a vital");
    await logReading.click();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
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
    const medication = dashboardCandidatePrefix(page, "intake.prn:");
    await expect(medication).toBeVisible();
    await expect(medication).toHaveAttribute("data-kind", "action");
    await expect(medication.getByTestId("quick-log-prn")).toBeVisible();
    // The fixture owns exactly one active PRN med, so the log control is unambiguous.
    await expect(medication.getByTestId("prn-log-now")).toBeVisible();
  });
});
