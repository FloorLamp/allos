import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";
import { hydratedClick } from "./helpers";

const DAY = "2026-08-20";

function seedRows(stamp: string): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT s.active_profile_id AS id
         FROM sessions s JOIN logins l ON l.id = s.login_id
        WHERE l.username = 'admin' AND s.active_profile_id IS NOT NULL
        ORDER BY s.last_used_at DESC LIMIT 1`
      )
      .get() as { id: number };
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
       VALUES (?, 'berries', ?, ?)`
    ).run(profile.id, DAY, `2026-08-20T12:${stamp}:00.000Z`);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min)
       VALUES (?, ?, ?, '08:30', 20)`
    ).run(profile.id, `Ledger practice ${stamp}`, DAY);
    db.prepare(
      `INSERT INTO substance_daily_totals (profile_id, substance, date, units)
       VALUES (?, ?, ?, 2)`
    ).run(profile.id, `Ledger substance ${stamp}`, DAY);
  } finally {
    db.close();
  }
}

test("food and practice ledgers are reachable and Timeline filters their day rollups", async ({
  page,
}, testInfo) => {
  const stamp = String(
    (testInfo.repeatEachIndex + testInfo.retry) % 60
  ).padStart(2, "0");
  seedRows(stamp);

  await page.goto("/nutrition");
  await hydratedClick(page, page.getByTestId("food-ledger-link"));
  await expect(page).toHaveURL(/\/nutrition\/food-history/);
  await expect(page.getByTestId("food-ledger-page")).toBeVisible();
  await expect(page.getByTestId("food-ledger-row")).toContainText("Berries");
  await expect(page.getByTestId("food-ledger-pagination")).toContainText("of");

  await page.goto("/wellness");
  await hydratedClick(page, page.getByTestId("practice-ledger-link"));
  await expect(page).toHaveURL(/\/wellness\/practice-history/);
  await expect(page.getByTestId("practice-ledger-page")).toBeVisible();
  await expect(page.getByTestId("practice-session-history")).toContainText(
    `Ledger practice ${stamp}`
  );

  await page.goto(`/timeline?from=${DAY}&to=${DAY}`);
  await hydratedClick(
    page,
    page.getByRole("link", { name: "Food", exact: true })
  );
  await expect(page).toHaveURL(/category=food/);
  const foodDay = page.getByTestId("timeline-event").filter({
    has: page.locator(
      `a[href="/nutrition/food-history?from=${DAY}&to=${DAY}"]`
    ),
  });
  await expect(foodDay).toHaveCount(1);
  await expect(foodDay).toContainText(/servings? logged/);
  await hydratedClick(
    page,
    page.getByRole("link", { name: "Substance", exact: true })
  );
  await expect(page).toHaveURL(/category=substance/);
  const substanceDay = page
    .getByTestId("timeline-event")
    .filter({ hasText: `Ledger substance ${stamp}` });
  await expect(substanceDay).toHaveCount(1);
  await expect(substanceDay).toContainText(/substance uses? logged/);
});
