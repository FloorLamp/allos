import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openDashboardAll, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Act → toast → Undo, on the dose confirm (#2642).
//
// THE DASHBOARD ATTENTION ROW IS THE SURFACE `DoseConfirmButton` SERVES. It used to be
// one of two; the household card carried the other until #1463 §1 made that card a
// summary and ceded cross-profile confirms to Upcoming multi-view, so this spec moved
// here with the component rather than being deleted with the mount.
//
// The fixture is owned outright: this spec creates its OWN item on the acting profile
// and drops it afterwards, so nothing here depends on a seed row a neighbour might
// consume, and nothing it writes is left behind.
//
// The story is one sequence, so it is one test:
//   1. Confirm → "Dose logged" WITH an Undo → the log exists and the row leaves the page.
//   2. Undo → the log is gone, the toast names the consequence, the row is back.
//   3. A confirm that WROTE NOTHING carries no Undo. With a taken row put in place behind
//      the rendered page (the stale-tab case), the tap answers "Already logged as taken"
//      — and offering Undo there would let this tap erase the EARLIER write, which is not
//      taking back what you just did.
//
// SEQUENCING. The dev server is single-threaded, so a read issued while a POST is
// outstanding can be answered ahead of the write it is meant to verify. Every assertion
// below sits behind `settledClick`, which resolves on the correlated Server Action POST
// (see e2e/helpers.ts) — never on an optimistic paint and never on a timeout.

// The default admin storageState acts as profile 1, whose dashboard this drives.
const ACTING_PROFILE = 1;
const UNDO_ITEM = "Dashboard Undo Zinc";

function openDb(): InstanceType<typeof Database> {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// Create (or reset to a clean, never-confirmed state) this spec's own item. Owned
// outright: the "no log stands" precondition is an ABSENCE, and an absence borrowed from
// the seed is one a neighbour's ordinary write silently destroys.
function seedUndoItem(): { itemId: number; doseId: number } {
  const db = openDb();
  try {
    const existing = db
      .prepare(`SELECT id FROM intake_items WHERE profile_id = ? AND name = ?`)
      .get(ACTING_PROFILE, UNDO_ITEM) as { id: number } | undefined;
    if (existing) dropItem(db, existing.id);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, obligation, active, source)
           VALUES (?, ?, 'daily', 'should', 1, 'manual')`
        )
        .run(ACTING_PROFILE, UNDO_ITEM).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '15 mg', '08:00', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    return { itemId, doseId };
  } finally {
    db.close();
  }
}

function dropItem(db: InstanceType<typeof Database>, itemId: number): void {
  db.prepare(`DELETE FROM intake_item_logs WHERE item_id = ?`).run(itemId);
  db.prepare(`DELETE FROM intake_item_doses WHERE item_id = ?`).run(itemId);
  db.prepare(`DELETE FROM intake_items WHERE id = ?`).run(itemId);
}

function takenLogDates(itemId: number): string[] {
  const db = openDb();
  try {
    return (
      db
        .prepare(
          `SELECT date FROM intake_item_logs
            WHERE item_id = ? AND status = 'taken' ORDER BY id`
        )
        .all(itemId) as { date: string }[]
    ).map((r) => r.date);
  } finally {
    db.close();
  }
}

// Put a taken row in place behind an already-rendered card — the stale-tab case. The
// `date` is the one the APP itself wrote a moment earlier (the profile's own local day,
// resolved server-side), never a date this spec computes.
function logTakenBehindTheCard(
  itemId: number,
  doseId: number,
  date: string
): void {
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, supply_adjusted)
       VALUES (?, ?, ?, '15 mg', 'taken', 0)`
    ).run(doseId, itemId, date);
  } finally {
    db.close();
  }
}

// This spec's own attention row, found by the item it seeded. The dashboard's rows sit
// behind the "all" disclosure (#1804's native <details>), which every revalidate closes
// again — so the caller re-opens before each read rather than once at the top.
function doseRow(page: Page): Locator {
  return page.getByTestId("dashboard-candidate").filter({ hasText: UNDO_ITEM });
}

test("the dose confirm offers an Undo that takes the log back, and none when it wrote nothing (#2642)", async ({
  page,
}) => {
  test.slow();
  const { itemId, doseId } = seedUndoItem();
  // Runs as the default admin storageState, acting as profile 1 — so this seeded dose
  // is due on the dashboard the admin lands on.
  await page.goto("/");
  await openDashboardAll(page);
  await expect(doseRow(page)).toBeVisible();

  // ── 1. Act ────────────────────────────────────────────────────────────────────
  await settledClick(page, doseRow(page).getByTestId("attention-mark-taken"));

  const logged = page.getByTestId("toast").filter({ hasText: "Dose logged" });
  await expect(logged).toBeVisible();
  const undo = logged.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  // The POST has settled, so this read cannot be answered ahead of the write.
  const dates = takenLogDates(itemId);
  expect(dates).toHaveLength(1);
  const loggedDate = dates[0];
  await expect(doseRow(page)).toHaveCount(0);

  // ── 2. Undo ───────────────────────────────────────────────────────────────────
  await settledClick(page, undo);

  await expect(
    page
      .getByTestId("toast")
      .filter({ hasText: "Dose confirm undone — it’s due again." })
  ).toBeVisible();
  // The inverse was complete: the row this tap wrote is gone…
  expect(takenLogDates(itemId)).toEqual([]);
  // …and the REVALIDATED tree says the dose is due again. Asserted by COUNT, not by
  // visibility: the revalidated render closes the "all" disclosure again, so "is it on
  // screen" is a question about a disclosure, not about the undo. Playwright retries
  // the count until the new tree commits.
  await expect(doseRow(page)).toHaveCount(1);

  // ── 3. A tap that writes nothing gets no Undo ─────────────────────────────────
  // A taken row appears behind the rendered page, from somewhere this button had no
  // part in (an earlier tap, a Telegram confirm, the offline replay). Reload first so the
  // disclosure starts from a known state and the still-due row is reachable to tap, and
  // write the log only once that render is on screen — the row is BEHIND the render,
  // which is the whole stale-tab scenario.
  await page.goto("/");
  await openDashboardAll(page);
  await expect(doseRow(page)).toBeVisible();
  logTakenBehindTheCard(itemId, doseId, loggedDate);
  await settledClick(page, doseRow(page).getByTestId("attention-mark-taken"));

  const repeat = page
    .getByTestId("toast")
    .filter({ hasText: "Already logged as taken" });
  await expect(repeat).toBeVisible();
  // THE ASSERTION: no Undo beside a tap that wrote nothing.
  await expect(repeat.getByRole("button", { name: "Undo" })).toHaveCount(0);
  // And the earlier row is untouched — the idempotent confirm added nothing.
  expect(takenLogDates(itemId)).toEqual([loggedDate]);

  // Leave the profile as it was found.
  const db = openDb();
  try {
    dropItem(db, itemId);
  } finally {
    db.close();
  }
});
