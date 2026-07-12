import { test, expect } from "@playwright/test";

// The Upcoming section of the merged Visits page (issue #288 — appointments and
// encounters share one /encounters surface now). Originally the standalone
// /appointments list (#391, gap 7); retargeted here to the merged page. Asserts a
// seeded scheduled visit renders with its provider inside the Upcoming section, and
// that cancelling the dedicated future appointment both settles its status and
// drops it from the Upcoming feed (list↔digest parity). Also proves the old
// /appointments route redirects into the merged page.

const APPT_UPCOMING = '[data-testid^="upcoming-item-appointment:"]';

test.describe("Visits — Upcoming (appointments) (#288)", () => {
  test("the old /appointments route redirects to the merged Visits page", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/appointments");
    await expect(page).toHaveURL(/\/encounters$/);
    await expect(page.getByRole("heading", { name: "Visits" })).toBeVisible();
  });

  test("a seeded scheduled appointment renders with its provider", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/encounters");
    await expect(page.getByRole("heading", { name: "Visits" })).toBeVisible();

    // The Upcoming section carries the appointments surface.
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    // The seeded, still-scheduled cardiology visit shows with its linked provider.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "Cardiology follow-up" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Dr. Marcus Lee");
  });

  test("cancelling an appointment settles its status and clears it from Upcoming", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/encounters");
    const upcoming = page.getByTestId("visits-upcoming");

    // The dedicated future appointment while it's still scheduled (only scheduled
    // rows carry the Cancel control). Guarded so a CI retry — where it's already
    // cancelled — skips straight to the assertions.
    const scheduledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" })
      .filter({
        has: page.getByRole("button", { name: "Cancel appointment" }),
      });
    if (await scheduledRow.count()) {
      await scheduledRow
        .getByRole("button", { name: "Cancel appointment" })
        .click();
      // It leaves the Scheduled list (its status is no longer "scheduled").
      await expect(scheduledRow).toHaveCount(0);
    }

    // Its status settled to Cancelled — visible once the settled-history section
    // is expanded.
    await page.getByText(/Completed & cancelled/).click();
    const settledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" });
    await expect(settledRow).toContainText("Cancelled");

    // And it's gone from the Upcoming feed.
    await page.goto("/upcoming");
    await expect(
      page.locator(APPT_UPCOMING).filter({ hasText: "E2E dermatology visit" })
    ).toHaveCount(0);
  });
});
