import { test, expect } from "@playwright/test";

// Care-plan items in Upcoming (issue #84). scripts/seed.ts gives profile 1 several
// provider-ordered care_plan_items with a FUTURE planned_date and an open status
// ("planned"/"active") — e.g. "Follow-up lipid panel" and "Nutrition counseling
// visit". These specs prove, end-to-end, that:
//   1. an open, dated care-plan item renders on /upcoming as a `careplan` row, and
//   2. its inline "Mark done" marks the row completed so it drops off the list.
// The default specs run authenticated as admin acting as profile 1 (storageState).

// Any careplan Upcoming row (stable testid prefix), narrowed by its title text.
const CAREPLAN_ROWS = '[data-testid^="upcoming-item-careplan:"]';

test.describe("care-plan items in Upcoming (issue #84)", () => {
  test("an open, dated care-plan item shows and marks done", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/upcoming");

    const row = page
      .locator(CAREPLAN_ROWS)
      .filter({ hasText: "Follow-up lipid panel" });
    await expect(row).toBeVisible();

    // Mark it done → status becomes completed and the row drops on revalidate.
    await row.getByRole("button", { name: "Mark done" }).click();
    await expect(
      page.locator(CAREPLAN_ROWS).filter({ hasText: "Follow-up lipid panel" })
    ).toHaveCount(0);
  });
});
