import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_REST_EPISODE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
// Issue #44 item 3b: rest-nudge episode continuity. The e2e seed
// (e2e/seed/coaching.ts) forces a rest recommendation today (a short night below the
// 6h floor) and pre-seeds a rest episode that started yesterday, so the coaching
// engine phrases the nudge as a PERSISTING recommendation rather than a fresh alert
// (#752 — it describes signal persistence, never assumed rest).
//
// Driven against the DEDICATED rest-episode profile, and that is what makes the exact
// title assertable (#3006). The title's stance comes from restTenseFor, which reads
// the profile's training history — so on the shared profile 1 the wording flipped to
// "Make your next session an easy one — 2nd day" whenever a co-resident spec had
// logged a workout as the admin earlier on the same worker. This profile's only
// activity is ten days old and no other spec signs in as its login, so the tense is
// an input this spec controls rather than a consequence of which specs it happens to
// share a worker with. Read-only, so it stays repeat-safe under --repeat-each.
test.describe("Coaching rest-episode continuity (#44 3b)", () => {
  test("Training overview phrases the rest nudge as a persisting recommendation", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REST_EPISODE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
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
    } finally {
      await page.context().close();
    }
  });
});
