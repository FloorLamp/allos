import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Care-plan items in Upcoming (issue #84). scripts/seed.ts gives profile 1 several
// provider-ordered care_plan_items with a FUTURE planned_date and an open status
// ("planned"/"active") — e.g. "Follow-up lipid panel" and "Nutrition counseling
// visit". These specs prove, end-to-end, that:
//   1. an open, dated care-plan item renders on /upcoming as a `careplan` row, and
//   2. its inline "Mark done" marks the row completed so it drops off the list.
// The default specs run authenticated as admin acting as profile 1 (storageState).

// Any careplan Upcoming row (stable testid prefix), narrowed by its title text.
const CAREPLAN_ROWS = '[data-testid^="upcoming-item-careplan:"]';

// Re-open the seeded item before each run (#868 fixture ownership): "Mark done"
// persists status='completed' on the shared seeded row, so without this reset a
// second --repeat-each run (or any later run against the same DB) finds the row
// already gone and the "shows" assertion fails. Same short-lived direct-DB
// connection pattern as smoke.spec's resetCoachingSnooze.
function reopenSeededCarePlanItem(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "UPDATE care_plan_items SET status = 'planned' WHERE profile_id = 1 AND description = 'Follow-up lipid panel'"
    ).run();
  } finally {
    db.close();
  }
}

test.describe("care-plan items in Upcoming (issue #84)", () => {
  test("an open, dated care-plan item shows and marks done", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();
    reopenSeededCarePlanItem();

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
