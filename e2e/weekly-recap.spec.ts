import { test, expect } from "./fixtures";
// Issue #32: the Weekly-recap dashboard card and a milestone Timeline entry.
// The e2e seed (e2e/seed-events.ts) pins a dashboard layout that makes the
// weekly-recap widget visible for profile 1 and plants a "50 workouts logged"
// milestone so both surfaces have deterministic content.
test.describe("Weekly recap + milestones (#32)", () => {
  test("dashboard shows the weekly-recap card with its seven-day window", async ({
    page,
  }) => {
    await page.goto("/");
    const recap = page.getByTestId("weekly-recap");
    await expect(recap).toBeVisible();
    await expect(
      recap.getByRole("heading", { name: "Weekly recap" })
    ).toBeVisible();
    // The seeded profile has recent activity, so the card renders summary rows
    // (not the empty-state nudge) — Workouts is always present when any workout
    // fell in the window.
    await expect(recap.getByText("Workouts")).toBeVisible();

    // #1218: the range renders through the login's date-format prefs
    // (recapRangeLabel → "Jul 3 – Jul 9"), never raw ISO ("2026-07-03 – …").
    const range = recap.getByTestId("weekly-recap-range");
    await expect(range).toBeVisible();
    await expect(range).toHaveText(
      /[A-Z][a-z]{2,} \d{1,2}(, \d{4})? – [A-Z][a-z]{2,} \d{1,2}(, \d{4})?/
    );
    await expect(range).not.toHaveText(/\d{4}-\d{2}-\d{2}/);

    // #1935: three rows were cut for failing the week-scale test. Volume was a
    // session fact aggregated whose percentage restated the workout count directly
    // above it; Calories compared one low-confidence estimate against another; and
    // Streak measured app engagement with a cliff, on a card the rest of the app
    // fills with rest-day and deload advice. The seeded profile has the strength
    // sessions and the recent activity that would have produced all three.
    await expect(recap.getByText("Volume", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Calories", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Streak", { exact: true })).toHaveCount(0);
    await expect(recap.getByText(/active days?$/)).toHaveCount(0);
  });

  test("timeline surfaces the milestone entry under the Milestone filter", async ({
    page,
  }) => {
    await page.goto("/timeline?category=milestone");
    await expect(page.getByText("50 workouts logged").first()).toBeVisible(); // first-ok: asserts the milestone line renders — order-agnostic presence
    // The milestone badge labels the category on the card. Scoped to a feed entry:
    // the #1517 collapsed filter bar renders a (hidden) "Milestone · All dates"
    // summary label earlier in the DOM, which a page-wide first-match would grab —
    // the consolidation-class selector break. (Prose deliberately avoids spelling
    // out the locator call: the hygiene guard is a text scan and would count it.)
    await expect(
      page.locator('[id^="timeline-entry-"]').getByText("Milestone").first() // first-ok: asserts a Milestone badge renders on a feed entry — order-agnostic presence
    ).toBeVisible();
  });
});
