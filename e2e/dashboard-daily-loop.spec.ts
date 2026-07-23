import { test, expect, type Page } from "@playwright/test";
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

  test("Steps-today card shows today's steps versus the 7-day average", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("steps-today-widget");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("steps-today-count")).toContainText(/[\d,]+/);
    await expect(card).toContainText(/7-day average/);
    // Today (9,400) is above the trailing average → an up delta line renders.
    await expect(card.getByTestId("steps-today-delta")).toContainText(
      /% vs 7-day average/
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
  });

  test("Cycle-phase card shows the derived cycle day and phase (informational)", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("cycle-phase-value")).toContainText(
      /Cycle day \d+ · (Menstrual|Follicular|Luteal)/
    );
    // Informational only — never a prediction (the #714 contract).
    await expect(card).toContainText(/never a prediction/i);
    await expect(
      card.getByRole("link", { name: /View all cycle phase/i })
    ).toHaveAttribute("href", "/medical/cycles");
  });

  test("the check-in card carries the folded 'Take any meds?' branch", async () => {
    await page.goto("/");
    const checkin = page.getByRole("main").getByTestId("how-are-you-card");
    await expect(checkin).toBeVisible();
    // The daily-loop profile owns one active PRN med and is well, so the meds branch
    // renders; expanding it reveals the same PRN quick-log control.
    const meds = checkin.getByTestId("checkin-meds");
    await expect(meds).toBeVisible();
    await checkin.getByTestId("checkin-meds-toggle").click();
    await expect(checkin.getByTestId("quick-log-prn")).toBeVisible();
    // The fixture owns exactly one active PRN med, so the log control is unambiguous.
    await expect(checkin.getByTestId("prn-log-now")).toBeVisible();
  });

  test("the 'Anything going on?' branch toggles a situation and the Supplements bar agrees (#1221 part 6)", async () => {
    const SITUATION = "Deadline (e2e)";
    await page.goto("/");
    const checkin = page.getByRole("main").getByTestId("how-are-you-card");
    await expect(checkin).toBeVisible();

    // Expand the collapsed disclosure and toggle the custom fixture situation ON.
    await expect(checkin.getByTestId("checkin-situations")).toBeVisible();
    await checkin.getByTestId("checkin-situations-toggle").click();
    const chip = checkin.getByTestId(`checkin-situation-${SITUATION}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await settledClick(page, chip);
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // The #662 activation line renders from the shared dueness count — the fixture's
    // one situational supplement ("Focus Blend") is now due.
    await expect(
      checkin.getByTestId("checkin-situation-activation")
    ).toContainText(/situational item/);

    // The Supplements bar agrees on next visit: the SAME situation reads active there,
    // and its own activation line renders (one shared vocabulary + dueness count, #221).
    await page.goto("/nutrition?tab=supplements");
    const bar = page.getByRole("main").getByTestId("situations-bar");
    await expect(bar).toBeVisible();
    await expect(
      bar.getByRole("button", { name: SITUATION, exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("main").getByTestId("situation-activation")
    ).toContainText(/situational item/);

    // Restore the fixture (toggle OFF) so --repeat-each stays clean.
    await settledClick(
      page,
      bar.getByRole("button", { name: SITUATION, exact: true })
    );
    await expect(
      bar.getByRole("button", { name: SITUATION, exact: true })
    ).toHaveAttribute("aria-pressed", "false");
  });
});
