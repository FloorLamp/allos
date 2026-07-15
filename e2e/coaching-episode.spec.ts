import { test, expect } from "@playwright/test";

// Issue #44 item 3b: rest-nudge episode continuity. The e2e seed
// (e2e/seed-events.ts) forces a rest recommendation for profile 1 today (a short
// night below the 6h floor) and pre-seeds a rest episode that started yesterday,
// so the coaching engine phrases the nudge as a PERSISTING recommendation rather
// than a fresh alert (#752 — it describes signal persistence, never assumed rest).
test.describe("Coaching rest-episode continuity (#44 3b)", () => {
  test("Training overview phrases the rest nudge as a persisting recommendation", async ({
    page,
  }) => {
    await page.goto("/training?tab=overview");
    const title = page.getByTestId("next-workout-title");
    await expect(title).toBeVisible();
    // Day 2 of the same condition stays an imperative recommendation carrying the
    // day count ("Rest or take it easy — 2nd day"), not the first-day title.
    await expect(title).toHaveText("Rest or take it easy — 2nd day");
    await expect(title).not.toHaveText("Rest or take it easy today");
    // The detail states the signals persisted, never that the user rested (#752).
    await expect(
      page.getByText("Recovery signals have persisted for 2 days")
    ).toBeVisible();
  });
});
