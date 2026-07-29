import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { settledClick } from "./helpers";

// Issue #1505, the rendered halves:
//   • a LOW-priority supplement is TRACKED — it renders on Supplements & Meds like
//     any other item — but NEVER PUSHED: it has no Upcoming row, while a high one
//     seeded beside it does. One predicate, two surfaces, visibly different.
//   • the demotion SUGGESTION renders on Supplements & Meds for an abandoned
//     high-priority supplement, and accepting it is what moves the item out of the
//     push tier — the user's tap, never the system's.
//
// Each test owns its fixture rows (unique names, deleted in `finally`) and asserts
// only on those, so nothing here depends on the shared seed's counts. Dates are
// derived from frozenNow() — never wall-clock.

const LOW_NAME = "Tracked Never Pushed (e2e)";
const HIGH_NAME = "Pushed Comparison (e2e)";
const ABANDONED_NAME = "Abandoned Habit (e2e)";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The frozen run clock as a YYYY-MM-DD calendar day, `back` days earlier.
function dayBack(back: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// One daily item with a single morning dose on profile 1, created `createdDaysAgo`
// days before the frozen clock so the adherence window's lifetime clamp sees a
// genuinely long-lived item.
function seedItem(
  db: Database.Database,
  name: string,
  priority: "low" | "high",
  createdDaysAgo: number
): { itemId: number; doseId: number } {
  const createdAt = `${dayBack(createdDaysAgo)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, priority, condition, source, created_at)
         VALUES (1, ?, 1, 'supplement', ?, 'daily', 'manual', ?)`
      )
      .run(name, priority, createdAt).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 cap', 'Morning', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
  return { itemId, doseId };
}

function dropItem(db: Database.Database, itemId: number | null): void {
  if (itemId == null) return;
  db.prepare(
    `DELETE FROM intake_item_logs
      WHERE dose_id IN (SELECT id FROM intake_item_doses WHERE item_id = ?)`
  ).run(itemId);
  db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(itemId);
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key = ?").run(
    `demote-priority:${itemId}`
  );
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
    `demote-priority:${itemId}:%`
  );
  db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
}

test("a low-priority supplement is tracked on its page and absent from Upcoming (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let lowId: number | null = null;
  let highId: number | null = null;
  try {
    const low = seedItem(db, LOW_NAME, "low", 60);
    const high = seedItem(db, HIGH_NAME, "high", 60);
    lowId = low.itemId;
    highId = high.itemId;

    // TRACKED: both items render on their own page, unchanged.
    await page.goto("/nutrition?tab=supplements");
    await expect(
      page.getByTestId("medicine-name").filter({ hasText: LOW_NAME })
    ).toBeVisible();
    await expect(
      page.getByTestId("medicine-name").filter({ hasText: HIGH_NAME })
    ).toBeVisible();

    // NEVER PUSHED: only the high-priority twin has an Upcoming row.
    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-dose:${high.doseId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`upcoming-item-dose:${low.doseId}`)
    ).toHaveCount(0);
  } finally {
    dropItem(db, lowId);
    dropItem(db, highId);
    db.close();
  }
});

test("accepting a demotion suggestion moves the item out of the push tier (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const item = seedItem(db, ABANDONED_NAME, "high", 90);
    itemId = item.itemId;
    // Taken on only two of its last thirty scheduled days — an abandoned habit.
    for (const back of [29, 22]) {
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
         VALUES (?, ?, ?, 'taken', '1 cap')`
      ).run(item.doseId, item.itemId, dayBack(back));
    }

    // It still pushes — the suggestion has changed nothing on its own.
    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toBeVisible();

    // The suggestion renders, and accepting it is the priority write.
    await page.goto("/nutrition?tab=supplements");
    const row = page
      .getByTestId("demotion-suggestion-item")
      .filter({ hasText: ABANDONED_NAME });
    await expect(row).toBeVisible();
    await settledClick(page, row.getByTestId("demotion-accept"));

    // The card's row is gone: a low item is never a candidate, so the suggestion
    // clears itself the moment it is acted on.
    await expect(
      page
        .getByTestId("demotion-suggestion-item")
        .filter({ hasText: ABANDONED_NAME })
    ).toHaveCount(0);
    // …and the item is still fully tracked on its own page.
    await expect(
      page.getByTestId("medicine-name").filter({ hasText: ABANDONED_NAME })
    ).toBeVisible();

    // The push tier no longer carries it.
    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toHaveCount(0);

    const stored = db
      .prepare("SELECT priority FROM intake_items WHERE id = ?")
      .get(item.itemId) as { priority: string };
    expect(stored.priority).toBe("low");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});
