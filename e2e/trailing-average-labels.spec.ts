import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_DAY_ONE,
  DAY_ONE_PROFILE,
  DAY_ONE_WEIGHT_KG,
  DAY_ONE_STALE_DAYS_AGO,
  DAY_ONE_STALE_WEIGHT_KG,
  DAY_ONE_PROTEIN_COMPLETE_DAY,
  DAY_ONE_PROTEIN_TODAY,
} from "./fixture-logins";
import { workerDbPath, frozenNow } from "./worker-env";

// What a trailing average says it covers, in the browser (#1909 day-one ruling,
// #1917). Two claims, one profile:
//
//   • DAY ONE. A first-ever weigh-in used to leave the Rolling summary reading
//     "No readings" all day — the honest consequence of averaging complete days,
//     landing exactly when someone is checking whether their entry worked. The
//     card now shows that reading, labelled "Today's reading" rather than dressed
//     up as an average. A GAP is not day one: a profile with a stale weigh-in has
//     complete-day history, so its 7-day window stays empty.
//   • THE NUTRITION LABEL. The dashboard's Nutrition card printed "7-day average"
//     over a week-to-date figure that included a partial today. The fixture logs
//     the SAME protein on every complete day in the window and a very different
//     amount today, so the rendered number is one exact value if — and only if —
//     the window is a trailing seven complete days.
//
// Fixture-OWNED (#868): the dedicated Day One profile is seeded with no readings
// at all; this spec writes every row it asserts on and clears them first, so
// --repeat-each starts from the same nothing every time.

function dayStr(daysAgo: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function withDb<T>(fn: (db: Database.Database, profileId: number) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profileId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(DAY_ONE_PROFILE) as { id: number }
    ).id;
    return fn(db, profileId);
  } finally {
    db.close();
  }
}

// The day-one state itself: ONE weigh-in, dated today, and nothing else anywhere.
// The weigh-in doubles as the bodyweight the protein goal band scales by.
function resetToDayOne(): void {
  withDb((db, profileId) => {
    db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(profileId);
    db.prepare("DELETE FROM protein_log WHERE profile_id = ?").run(profileId);
    db.prepare("DELETE FROM food_log WHERE profile_id = ?").run(profileId);
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
    ).run(profileId, dayStr(0), DAY_ONE_WEIGHT_KG);
  });
}

function logProtein(daysAgo: number, grams: number): void {
  withDb((db, profileId) => {
    db.prepare(
      "INSERT INTO protein_log (profile_id, date, grams) VALUES (?, ?, ?)"
    ).run(profileId, dayStr(daysAgo), grams);
  });
}

test.describe("what a trailing average covers, and what it says (#1909/#1917)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_DAY_ONE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.beforeEach(() => {
    resetToDayOne();
  });

  test("a first-ever reading shows as TODAY's reading, not as an average", async () => {
    await page.goto("/trends/metric/weight");

    const summary = page.getByTestId("metric-period-stats");
    await expect(summary).toBeVisible();
    // One reading, so every window holds it and the three collapse onto one card.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(1);
    await expect(page.getByTestId("period-readings-90")).toContainText(
      "1 reading"
    );

    // The figure is today's reading and carries its own label and test id — an
    // average and a single in-progress reading are never the same element.
    await expect(page.getByTestId("period-today-reading-90")).toContainText(
      String(DAY_ONE_WEIGHT_KG)
    );
    // The app's copy uses a typographic apostrophe; assert what it renders.
    await expect(page.getByTestId("period-stat-90")).toContainText(
      "Today’s reading"
    );
    await expect(page.getByTestId("period-average-90")).toHaveCount(0);
    await expect(summary).not.toContainText("No readings");

    // …and the coverage note stops claiming "through yesterday" while it does so.
    const coverage = page.getByTestId("metric-period-coverage");
    await expect(coverage).toContainText("first reading");
    await expect(coverage).not.toContainText("through yesterday");
  });

  test("a GAP is not day one — the 7-day window stays empty", async () => {
    // A stale weigh-in plus today's. There IS complete-day history now, so the
    // 7-day window is honestly empty rather than falling back to today's number.
    withDb((db, profileId) => {
      db.prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
      ).run(profileId, dayStr(DAY_ONE_STALE_DAYS_AGO), DAY_ONE_STALE_WEIGHT_KG);
    });
    await page.goto("/trends/metric/weight");

    // 7d holds nothing; 30d and 90d hold the stale reading and collapse together.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(2);
    await expect(page.getByTestId("period-readings-7")).toContainText(
      "No readings"
    );
    await expect(page.getByTestId("period-today-reading-7")).toHaveCount(0);
    await expect(page.getByTestId("period-average-90")).toContainText(
      String(DAY_ONE_STALE_WEIGHT_KG)
    );
    // The card is back to describing complete days, because it is describing them.
    await expect(page.getByTestId("metric-period-coverage")).toContainText(
      "through yesterday"
    );
  });

  test("the Nutrition card's '7-day average' covers seven complete days", async () => {
    // Day one for protein too: today's intake only. The card declines the day-one
    // fallback — today's protein is already its headline — so no average line.
    logProtein(0, DAY_ONE_PROTEIN_TODAY);
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("nutrition-today-widget");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("nutrition-today-protein")).toContainText(
      `${DAY_ONE_PROTEIN_TODAY} g`
    );
    await expect(card.getByTestId("nutrition-trailing-average")).toHaveCount(0);

    // Now a full week of complete days, every one of them the same figure. The
    // average is that figure — and NOT the week-to-date number, which would be
    // dragged up by today's 300 g and would depend on the weekday.
    for (let ago = 1; ago <= 7; ago++) {
      logProtein(ago, DAY_ONE_PROTEIN_COMPLETE_DAY);
    }
    await page.goto("/");
    await expect(card.getByTestId("nutrition-trailing-average")).toHaveText(
      `7-day average · ${DAY_ONE_PROTEIN_COMPLETE_DAY} g/day`
    );
  });
});
