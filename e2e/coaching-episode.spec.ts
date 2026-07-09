import { test, expect } from "@playwright/test";

// Issue #44 item 3b: rest-nudge episode continuity. The e2e seed
// (e2e/seed-events.ts) forces a rest recommendation for profile 1 today (a short
// night below the 6h floor) and pre-seeds a rest episode that started yesterday,
// so the coaching engine phrases the nudge as a CONTINUING easy stretch rather
// than a fresh alert.
test.describe("Coaching rest-episode continuity (#44 3b)", () => {
  test("Training overview phrases the rest nudge as a continuing easy day", async ({
    page,
  }) => {
    await page.goto("/training?tab=overview");
    const title = page.getByTestId("next-workout-title");
    await expect(title).toBeVisible();
    // Day 2 of the same condition reads "Second easy day", not the first-day
    // "Rest or take it easy today".
    await expect(title).toHaveText("Second easy day");
    await expect(title).not.toHaveText("Rest or take it easy today");
    // The underlying reason is kept but tagged as an ongoing stretch.
    await expect(page.getByText("second easy day in a row")).toBeVisible();
  });
});
