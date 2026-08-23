import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";

// Browser boundary for #3397: a food-group series that changes inside the selected
// range appears only as a dismissible digest chip. It does not mint a saved tile,
// census card, or detail link. The unique group is inserted and removed inside the
// test, so shared-seed content and repeat order cannot move the assertion.

const GROUP = "e2e_digest_food_group";

function dateBack(days: number): string {
  const date = frozenNow();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

test("nutrition movement renders as a neutral digest-only chip (#3397)", async ({
  page,
}) => {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  const remove = db.prepare(
    "DELETE FROM food_daily_totals WHERE profile_id = 1 AND group_key = ?"
  );
  try {
    remove.run(GROUP);
    const insert = db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (1, ?, ?, ?)`
    );
    for (let back = 8; back >= 1; back--) {
      insert.run(dateBack(back), GROUP, back >= 5 ? 4 : 1);
    }

    await page.goto(`/trends?from=${dateBack(8)}&to=${dateBack(1)}`);
    const chip = page
      .getByTestId("trend-digest-chip")
      .filter({ hasText: GROUP });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-tone", "neutral");
    await expect(chip).not.toContainText(
      /\b(should|must|need to|try to|better|worse|good|bad)\b/i
    );
    await expect(chip.locator("xpath=ancestor::a")).toHaveCount(0);
    await expect(
      page.getByTestId("saved-tiles").filter({ hasText: GROUP })
    ).toHaveCount(0);
    await expect(
      page.getByTestId("trends-body").filter({ hasText: GROUP })
    ).toHaveCount(0);
    await expect(page.getByLabel(`Dismiss ${GROUP} trend`)).toBeVisible();
  } finally {
    remove.run(GROUP);
    db.close();
  }
});
