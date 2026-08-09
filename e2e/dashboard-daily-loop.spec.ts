import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

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
    const card = page.getByRole("main").getByTestId("nutrition-today-widget");
    await expect(card).toBeVisible();
    // Today's protein figure (a floor, "≥ N g") — the seeded food gives a non-zero read.
    await expect(card.getByTestId("nutrition-today-protein")).toContainText(
      /\d+ g/
    );
    await expect(card).toContainText(/Goal/);
    await expect(
      card.getByRole("link", { name: /View all nutrition today/i })
    ).toHaveAttribute("href", "/nutrition");
  });

  test("Steps-today card shows today's steps versus the prior 7 days", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("steps-today-widget");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("steps-today-count")).toContainText(/[\d,]+/);
    // The baseline names the days it covers (#1909). "7-day average" is the phrase
    // this card must NOT use: the metric detail page's Rolling summary answers a
    // different question over a different window and would own that label.
    await expect(card).toContainText(/Prior 7 days · [\d,]+ steps a day/);
    await expect(card).not.toContainText(/7-day average/);
    // Today (9,400) is above the baseline → an up delta line renders.
    await expect(card.getByTestId("steps-today-delta")).toContainText(
      /% vs prior 7 days/
    );
  });

  test("Latest-vitals card shows the most recent BP and resting HR", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("vitals-latest-widget");
    await expect(card).toBeVisible();
    // The most recent BP pair (118/76 in the seed) — a systolic/diastolic value.
    await expect(card.getByTestId("vitals-latest-bp")).toContainText(
      /\d{2,3}\/\d{2,3}/
    );
    await expect(card.getByTestId("vitals-latest-resting-hr")).toContainText(
      /bpm resting/
    );
    // Both readings are recent, so both provenance lines state a plain date with no
    // staleness tint — the #2303 floor frames only what it must (the age-labeled side is
    // pinned by e2e/dashboard-vitals-recency.spec.ts).
    await expect(card.getByTestId("vitals-latest-bp-age")).not.toHaveAttribute(
      "data-stale",
      "true"
    );
    await expect(
      card.getByTestId("vitals-latest-resting-hr-age")
    ).not.toHaveAttribute("data-stale", "true");
    // #1892: the log affordance is present WITH data, not only without it. It used to
    // live in the empty state alone, so the person who logs BP weekly — the one who
    // actually opens this card — had none. It opens the same shared measurements
    // quick-entry the empty CTA opens.
    const logReading = card.getByTestId("vitals-log-reading");
    await expect(logReading).toHaveText(/Log reading/);
    await logReading.click();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
  });

  test("Cycle-phase card shows the derived cycle day and phase (informational)", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("cycle-phase-value")).toContainText(
      /Cycle day \d+ · (Menstrual|Follicular|Luteal)/
    );
    // The #714 "never a prediction" line was SUPERSEDED by #1679 (owner-ruled
    // forecasting reversal, PR #1820): the tile now shows either the projected
    // next-period window or the plain derivation line. The shared seed logs too few
    // completed cycles for a forecast, so this profile gets the resting copy — and
    // the forecast presentation itself is pinned by the cycle/TTC specs.
    await expect(card).toContainText(/derived from your logged periods/i);
    await expect(
      card.getByRole("link", { name: /View all cycle phase/i })
    ).toHaveAttribute("href", "/medical/cycles");
  });

  test("the check-in card carries the folded Act (meds) section", async () => {
    await page.goto("/");
    const checkin = page.getByRole("main").getByTestId("how-are-you-card");
    await expect(checkin).toBeVisible();
    // The daily-loop profile owns one active PRN med and is well, so the Act section
    // (#1314) renders; expanding it reveals the same PRN quick-log control.
    const meds = checkin.getByTestId("checkin-section-act");
    await expect(meds).toBeVisible();
    await checkin.getByTestId("checkin-section-act-toggle").click();
    await expect(checkin.getByTestId("quick-log-prn")).toBeVisible();
    // The fixture owns exactly one active PRN med, so the log control is unambiguous.
    await expect(checkin.getByTestId("prn-log-now")).toBeVisible();
  });

  test("the Context section toggles a situation and the Supplements schedule reflects it (#1221 part 6 / #1311)", async () => {
    const SITUATION = "Deadline (e2e)";
    await page.goto("/");
    const checkin = page.getByRole("main").getByTestId("how-are-you-card");
    await expect(checkin).toBeVisible();

    // Empty Context lives inside the Rate details flow until a selection gives it
    // content worth a collapsed section.
    await expect(checkin.getByTestId("checkin-section-context")).toHaveCount(0);
    await checkin.getByTestId("checkin-section-rate-toggle").click();
    const chip = checkin.getByTestId(`checkin-situation-${SITUATION}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await settledClick(page, chip);
    // Once selected, Context earns its own collapsed section; reopen that new
    // server-rendered location rather than waiting on the retired Details node.
    const activeContext = checkin.getByTestId("checkin-section-context");
    await expect(activeContext).toBeVisible();
    await checkin.getByTestId("checkin-section-context-toggle").click();
    await expect(
      activeContext.getByTestId(`checkin-situation-${SITUATION}`)
    ).toHaveAttribute("aria-pressed", "true");

    // The #662 activation line renders from the shared dueness count — the fixture's
    // one situational supplement ("Focus Blend") is now due.
    await expect(
      checkin.getByTestId("checkin-situation-activation")
    ).toContainText(/situational item/);

    // Supplements reflects the shared state without duplicating situation controls.
    await page.goto("/nutrition?tab=supplements");
    await expect(page.getByTestId("situations-bar")).toHaveCount(0);
    await expect(
      page.getByRole("main").getByTestId("situation-activation")
    ).toContainText(/situational item/);

    // Restore through the dashboard context surface that owns the controls.
    await page.goto("/");
    const restoredCheckin = page
      .getByRole("main")
      .getByTestId("how-are-you-card");
    await restoredCheckin.getByTestId("checkin-section-context-toggle").click();
    const restoredChip = restoredCheckin.getByTestId(
      `checkin-situation-${SITUATION}`
    );
    await expect(restoredChip).toHaveAttribute("aria-pressed", "true");
    await settledClick(page, restoredChip);
    await expect(
      restoredCheckin.getByTestId("checkin-section-context")
    ).toHaveCount(0);
  });
});
