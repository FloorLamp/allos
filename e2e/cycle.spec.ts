import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_CYCLE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Menstrual cycle tracking (issue #714): the Cycle surface (derived phase + cycle-length /
// variability trend), one-tap period logging, and the Timeline day-header phase/period
// chip. Deliberately tracking, not forecasting.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_CYCLE in its OWN cookie context
// on a dedicated adult profile seeded with three completed, roughly-regular periods (NO
// open period) plus one activity on a period day (so the Timeline renders a day + chip).
// The log/end/delete test is self-contained: it records the starting row count, mutates,
// then restores it, so --repeat-each stays clean. Interactions settle via settledClick.

test.describe("menstrual cycle (#714)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("seeded cycles render the derived phase and the length trend", async () => {
    test.slow();
    await page.goto("/medical/cycles");
    const phase = page.getByTestId("cycle-current-phase");
    await expect(phase).toBeVisible();
    await expect(phase).toHaveText(/Menstrual|Follicular|Luteal/);

    await expect(page.getByTestId("cycle-trend")).toBeVisible();
    await expect(page.getByTestId("cycle-regularity")).toBeVisible();
    expect(
      await page.getByTestId("cycle-history-row").count()
    ).toBeGreaterThanOrEqual(3);
  });

  test("one-tap logs a period (phase → Menstrual), then end + delete restores state", async () => {
    await page.goto("/medical/cycles");
    const rows = page.getByTestId("cycle-history-row");
    const before = await rows.count();

    // Start a period today.
    await settledClick(page, page.getByTestId("period-started-button"));
    await expect(page.getByTestId("period-ended-button")).toBeVisible();
    await expect(page.getByTestId("cycle-current-phase")).toHaveText(
      "Menstrual"
    );
    await expect(rows).toHaveCount(before + 1);

    // End it (cleanup part 1) — the button flips back.
    await settledClick(page, page.getByTestId("period-ended-button"));
    await expect(page.getByTestId("period-started-button")).toBeVisible();

    // Delete the just-created (newest, first) row — restore the starting count.
    await settledClick(page, page.getByTestId("cycle-delete-button").first());
    await expect(rows).toHaveCount(before);
  });

  test("Timeline day header shows the cycle phase/period chip", async () => {
    await page.goto("/timeline");
    await expect(page.getByTestId("cycle-phase-chip").first()).toBeVisible();
  });
});
