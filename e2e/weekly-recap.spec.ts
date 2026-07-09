import { test, expect } from "@playwright/test";

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
  });

  test("timeline surfaces the milestone entry under the Milestone filter", async ({
    page,
  }) => {
    await page.goto("/timeline?category=milestone");
    await expect(page.getByText("50 workouts logged").first()).toBeVisible();
    // The milestone badge labels the category on the card.
    await expect(page.getByText("Milestone").first()).toBeVisible();
  });
});
