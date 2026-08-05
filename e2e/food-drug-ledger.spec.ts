import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";

// Food log × food–drug rules (issue #2021): the app printed "Avoid all alcohol during
// treatment and for 3 days after" on a metronidazole row and then watched an alcohol
// serving get logged in complete silence. This pins the wire-up on the surface it
// reaches: a care-tier row on Upcoming carrying the label's OWN advice line, the logged
// fact, and nothing that judges the person.
//
// Fixture discipline (shared seeded DB): this spec OWNS its rows — a uniquely prefixed
// medication with a dated course window, plus today's alcohol servings — seeded via a raw
// connection and restored in beforeAll AND afterAll, so it is idempotent across
// --repeat-each and retries. Today's alcohol count is saved and put back exactly as it was
// (the seeded profile logs alcohol on other days, and this must not disturb them).
// Locators name the specific finding, never a positional match on a shared surface.

const MED = "E2E FOODDRUG Metronidazole";
const TODAY = frozenNow().toISOString().slice(0, 10);

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The alcohol servings profile 1 had logged today before this spec touched anything.
let priorAlcohol: number | null = null;

function cleanup(): void {
  const db = openDb();
  try {
    const ids = db
      .prepare("SELECT id FROM intake_items WHERE name = ?")
      .all(MED) as { id: number }[];
    for (const { id } of ids) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `food-drug-event:${id}:%`
      );
      db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(id);
      db.prepare("DELETE FROM intake_items WHERE id = ?").run(id);
    }
    if (priorAlcohol == null) {
      db.prepare(
        "DELETE FROM food_log WHERE profile_id = 1 AND date = ? AND group_key = 'alcohol'"
      ).run(TODAY);
    } else {
      db.prepare(
        `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (1, ?, 'alcohol', ?)
         ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
      ).run(TODAY, priorAlcohol);
    }
  } finally {
    db.close();
  }
}

function seed(): void {
  const db = openDb();
  try {
    const existing = db
      .prepare(
        "SELECT servings FROM food_log WHERE profile_id = 1 AND date = ? AND group_key = 'alcohol'"
      )
      .get(TODAY) as { servings: number } | undefined;
    priorAlcohol = existing?.servings ?? null;

    // `may` so the fixture medication never mints a due dose on the shared Upcoming
    // surface — the finding under test is about the food log, not about dueness.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
           VALUES (1, ?, 'medication', 1, 'may')`
        )
        .run(MED).lastInsertRowid
    );
    // A dated course: started three days ago, ends in three days — so today sits inside
    // the window and the entry's own 3-day tail is not in play yet.
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, start_date, end_date)
       VALUES (?, '500 mg', 'morning', ?, ?)`
    ).run(itemId, shift(TODAY, -3), shift(TODAY, 3));
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (1, ?, 'alcohol', 1)
       ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = 1`
    ).run(TODAY);
  } finally {
    db.close();
  }
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe("food–drug ledger findings (#2021)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("alcohol logged during a metronidazole course surfaces on Upcoming", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const finding = page
      .getByRole("main")
      .locator('[data-testid^="upcoming-item-food-drug-event:"]')
      .filter({ hasText: MED });
    await expect(finding).toBeVisible();
    // The fact from the user's own log…
    await expect(finding).toContainText("Alcohol logged today");
    await expect(finding).toContainText("1 serving of alcohol");
    // …and the medication label's own sentence, cited, with the informational tail.
    await expect(finding).toContainText(
      "Avoid all alcohol during treatment and for 3 days after"
    );
    await expect(finding).toContainText("Source:");
    await expect(finding).toContainText("Informational, not medical advice.");
    // Never a verdict about the person (#992/#716).
    await expect(finding).not.toContainText(/you should|shouldn't/i);
  });
});
