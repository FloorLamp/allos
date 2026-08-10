import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { expandUpcomingAggregates, settledClick } from "./helpers";

// Issue #1505, the rendered halves of the obligation model:
//   • a `may` item is TRACKED — it renders on Supplements & Meds like any other —
//     but NEVER PUSHED: no Upcoming due row, while a `should` twin seeded beside it
//     has one. It is COLLAPSED, not removed: it appears in Upcoming's "available"
//     disclosure, so the difference is visible on one screen.
//   • the demotion SUGGESTION renders for an abandoned should-tier supplement, and
//     accepting it is what MOVES the item from the due list into that disclosure —
//     the user's tap, never the system's.
//
// Each test owns its fixture rows (unique names, deleted in `finally`) and asserts
// only on those, so nothing here depends on the shared seed's counts. Dates are
// derived from frozenNow() — never wall-clock.

const LOW_NAME = "Tracked Never Pushed (e2e)";
const HIGH_NAME = "Pushed Comparison (e2e)";
const ABANDONED_NAME = "Abandoned Habit (e2e)";
const GUARDED_MED_NAME = "Guarded Med (e2e)";

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
  obligation: "may" | "should",
  createdDaysAgo: number
): { itemId: number; doseId: number } {
  const createdAt = `${dayBack(createdDaysAgo)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at)
         VALUES (1, ?, 1, 'supplement', ?, 'daily', 'manual', ?)`
      )
      .run(name, obligation, createdAt).lastInsertRowid
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
    `demote-obligation:${itemId}`
  );
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
    `demote-obligation:${itemId}:%`
  );
  db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
}

test("a `may` item is tracked on its page, off the due list, and inside the available disclosure (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let lowId: number | null = null;
  let highId: number | null = null;
  try {
    const low = seedItem(db, LOW_NAME, "may", 60);
    const high = seedItem(db, HIGH_NAME, "should", 60);
    lowId = low.itemId;
    highId = high.itemId;

    // TRACKED: both items are on their own page. The `should` one is in the due-today
    // list; the `may` one is under "Not scheduled today", because it has no dueness —
    // present and reachable, just not claimed to be owed.
    await page.goto("/nutrition?tab=supplements");
    await expect(
      page.getByTestId("medicine-name").filter({ hasText: HIGH_NAME })
    ).toBeVisible();
    const notScheduled = page.getByTestId("not-scheduled-section");
    await notScheduled.locator("summary").click();
    await expect(
      notScheduled.getByTestId("medicine-name").filter({ hasText: LOW_NAME })
    ).toBeVisible();

    // NEVER PUSHED: only the `should` twin has an Upcoming DUE row…
    await page.goto("/upcoming");
    // The DUE rows fold per band (#1504); the availability disclosure below is a
    // separate, deliberately un-folded surface — a `may` item is in neither the
    // dose aggregate nor its count.
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    await expect(
      page.getByTestId(`upcoming-item-dose:${high.doseId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`upcoming-item-dose:${low.doseId}`)
    ).toHaveCount(0);

    // …and the `may` one is COLLAPSED into the availability disclosure rather than
    // vanishing. Opening it shows the item, labelled as available, not as due.
    const available = page.getByTestId("available-section");
    await expect(available).toBeVisible();
    await available.locator("summary").click();
    await expect(
      available.getByTestId("available-row").filter({ hasText: LOW_NAME })
    ).toBeVisible();
    await expect(
      available.getByTestId("available-row").filter({ hasText: HIGH_NAME })
    ).toHaveCount(0);
  } finally {
    dropItem(db, lowId);
    dropItem(db, highId);
    db.close();
  }
});

test("accepting a demotion suggestion moves the item into the available disclosure (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const item = seedItem(db, ABANDONED_NAME, "should", 90);
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
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toBeVisible();

    // The suggestion renders, and accepting it is the obligation write.
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
    // …and the item is still fully tracked on its own page — now under "Not
    // scheduled today", which is what a `may` item is.
    const notScheduled = page.getByTestId("not-scheduled-section");
    await notScheduled.locator("summary").click();
    await expect(
      notScheduled
        .getByTestId("medicine-name")
        .filter({ hasText: ABANDONED_NAME })
    ).toBeVisible();

    // The push tier no longer carries it.
    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toHaveCount(0);

    // It MOVED rather than disappeared — the visible half of collapse-not-remove.
    const available = page.getByTestId("available-section");
    await expect(available).toBeVisible();
    await available.locator("summary").click();
    await expect(
      available.getByTestId("available-row").filter({ hasText: ABANDONED_NAME })
    ).toBeVisible();

    const stored = db
      .prepare("SELECT obligation FROM intake_items WHERE id = ?")
      .get(item.itemId) as { obligation: string };
    expect(stored.obligation).toBe("may");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

test("a medication's obligation control defaults to Must and states each level's consequences (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    // A `must` medication with a live schedule — the state the guardrail protects.
    const med = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, obligation, condition, source, created_at)
           VALUES (1, ?, 1, 'medication', 'must', 'daily', 'manual', ?)`
        )
        .run(GUARDED_MED_NAME, `${dayBack(30)} 08:00:00`).lastInsertRowid
    );
    itemId = med;
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '1 tablet', 'Morning', 'any', 0, ?)`
    ).run(med, `${dayBack(30)} 08:00:00`);

    await page.goto(`/medications/${med}?action=edit`);
    const obligation = page.getByTestId("med-obligation");
    await expect(obligation).toHaveValue("must");

    // The consequence of the CURRENT choice is always on screen — "May" must never be
    // a bare adjective, which is the failure the whole model exists to fix. Each level
    // names what it does, from the one shared copy the confirm dialog also quotes.
    const hint = page.getByTestId("med-obligation-hint");
    await expect(hint).toContainText(/follow-up nudge/i);

    await obligation.selectOption("should");
    // The hint names the mechanism the user is giving up, not just its absence: the
    // confirm dialog quotes the same phrase, so a user who reads either sees the same
    // words for the same loss.
    await expect(hint).toContainText(/no missed-dose escalation/i);

    await obligation.selectOption("may");
    await expect(hint).toContainText(/no reminders and no misses/i);
    // Choosing May reveals the as-needed dose shape it IS (#851/#798 key off it).
    await expect(page.getByTestId("redose-block")).toBeVisible();

    // Nothing is written by looking: the stored obligation is untouched until save.
    const stored = db
      .prepare("SELECT obligation FROM intake_items WHERE id = ?")
      .get(med) as { obligation: string };
    expect(stored.obligation).toBe("must");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

// ---- #2419: the collapsed rows can be LOGGED --------------------------------
//
// The doctrine's other promise — a `may` item is "always one tap away", and every
// collapsed row is COLLAPSED, not filtered out. Both web surfaces were
// look-but-don't-log until now, which made taking a situation-bound item mean
// flipping its situation active first, just to make a take button exist. Dueness
// gates NUDGING; logging is a statement about what happened.

const SITUATION_NAME = "Heat Wave (e2e)";
const SITUATION_ITEM = "Situation Bound (e2e)";
const OFFER_ITEM = "Offer Tap (e2e)";

// How many taken rows this dose has — polled after a tap, so the assertion waits on
// the write rather than on a repaint.
function takenCount(db: Database.Database, doseId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken'`
      )
      .get(doseId) as { n: number }
  ).n;
}

test("a situation-inactive item logs in one tap from More supplements, and the situation stays off (#2419)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  let situationId: number | null = null;
  try {
    const item = seedItem(db, SITUATION_ITEM, "should", 30);
    itemId = item.itemId;
    // Bound to a situation that is NOT active, so the item is off every due path
    // and lands under "More supplements" — the owner-reported case.
    situationId = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active, illness_type)
           VALUES (1, ?, 0, 0)`
        )
        .run(SITUATION_NAME).lastInsertRowid
    );
    db.prepare(
      "UPDATE intake_items SET condition = 'situational', situation_id = ? WHERE id = ?"
    ).run(situationId, item.itemId);

    await page.goto("/nutrition?tab=supplements");
    const notScheduled = page.getByTestId("not-scheduled-section");
    await notScheduled.locator("summary").click();
    const row = notScheduled
      .getByTestId("supplement-row")
      .filter({ hasText: SITUATION_ITEM });
    await expect(row).toBeVisible();

    // One tap, from the collapsed section, with no edit and no situation change.
    await settledClick(page, row.getByTestId("dose-take"));
    await expect.poll(() => takenCount(db, item.doseId)).toBe(1);

    // Invariant 2: logging is not a lifecycle write. The situation is exactly where
    // it was — nothing implied it, nothing turned it on.
    expect(
      (
        db
          .prepare("SELECT active FROM situations WHERE id = ?")
          .get(situationId) as { active: number }
      ).active
    ).toBe(0);
    // Invariant 3: dueness did not move either. The row is still collapsed — it was
    // logged, not promoted into today's schedule — and now reads as taken.
    await expect(
      notScheduled
        .getByTestId("supplement-row")
        .filter({ hasText: SITUATION_ITEM })
        .getByTestId("dose-take")
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    dropItem(db, itemId);
    if (situationId != null) {
      db.prepare("DELETE FROM situations WHERE id = ?").run(situationId);
    }
    db.close();
  }
});

test("an Upcoming Available row logs in one tap and stays available rather than becoming due (#2419)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const item = seedItem(db, OFFER_ITEM, "may", 30);
    itemId = item.itemId;

    await page.goto("/upcoming");
    const available = page.getByTestId("available-section");
    await available.locator("summary").click();
    const row = available
      .getByTestId("available-row")
      .filter({ hasText: OFFER_ITEM });
    await expect(row).toBeVisible();

    await settledClick(page, row.getByTestId("available-mark-taken"));
    await expect.poll(() => takenCount(db, item.doseId)).toBe(1);

    // Carrying a dose id did not make the offer into work: still no due row, and the
    // item is still in the disclosure it was collapsed into.
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toHaveCount(0);
    await expect(
      available.getByTestId("available-row").filter({ hasText: OFFER_ITEM })
    ).toBeVisible();
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});
