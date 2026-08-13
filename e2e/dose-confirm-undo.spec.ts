import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Act → toast → Undo, on the dose confirm (#2642).
//
// The household card is one of the two surfaces `DoseConfirmButton` serves (the dashboard
// attention hero is the other — same component, same shared inverse), and it is the one
// whose fixture can be owned outright: this spec creates its OWN item on the seeded second
// profile and drops it afterwards, so nothing here depends on a seed row a neighbour might
// consume, and nothing it writes is left behind.
//
// The story is one sequence, so it is one test:
//   1. Confirm → "Dose logged" WITH an Undo → the log exists and the row leaves the card.
//   2. Undo → the log is gone, the toast names the consequence, the row is back.
//   3. A confirm that WROTE NOTHING carries no Undo. With a taken row put in place behind
//      the rendered card (the stale-tab case), the tap answers "Already logged as taken"
//      — and offering Undo there would let this tap erase the EARLIER write, which is not
//      taking back what you just did.
//
// SEQUENCING. The dev server is single-threaded, so a read issued while a POST is
// outstanding can be answered ahead of the write it is meant to verify. Every assertion
// below sits behind `settledClick`, which resolves on the correlated Server Action POST
// (see e2e/helpers.ts) — never on an optimistic paint and never on a timeout.

const SEEDED_PROFILE_2 = 2; // "Sam Rivers"
const UNDO_ITEM = "Household Undo Zinc";

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
      .get(SEEDED_PROFILE_2, UNDO_ITEM) as { id: number } | undefined;
    if (existing) dropItem(db, existing.id);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, obligation, active, source)
           VALUES (?, ?, 'daily', 'should', 1, 'manual')`
        )
        .run(SEEDED_PROFILE_2, UNDO_ITEM).lastInsertRowid
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

// A card FOLDS its due-dose list past the shared threshold (#1504/#2615), so how many
// rows a card lays out is a neighbour's business. Open the disclosure if there is one.
// A plain <details>, so a pure client toggle and never a POST.
async function revealDoseRows(page: Page, card: Locator): Promise<void> {
  const aggregate = card.getByTestId("household-dose-aggregate");
  if ((await aggregate.count()) === 0) return;
  if (await aggregate.evaluate((el) => (el as HTMLDetailsElement).open)) return;
  await hydratedClick(
    page,
    card.getByTestId("household-dose-aggregate-summary")
  );
  await expect(aggregate).toHaveJSProperty("open", true);
}

test("the dose confirm offers an Undo that takes the log back, and none when it wrote nothing (#2642)", async ({
  page,
}) => {
  test.slow();
  const { itemId, doseId } = seedUndoItem();
  // Runs as the default admin storageState — admin reaches both profiles, so the
  // household cards carry confirm buttons.
  await page.goto("/household");
  const card = page.locator(
    `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
  );
  await revealDoseRows(page, card);
  const doseRow = () =>
    card.getByTestId("household-due-dose").filter({ hasText: UNDO_ITEM });
  await expect(doseRow()).toBeVisible();

  // ── 1. Act ────────────────────────────────────────────────────────────────────
  await settledClick(page, doseRow().getByTestId("household-confirm-dose"));

  const logged = page.getByTestId("toast").filter({ hasText: "Dose logged" });
  await expect(logged).toBeVisible();
  const undo = logged.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  // The POST has settled, so this read cannot be answered ahead of the write.
  const dates = takenLogDates(itemId);
  expect(dates).toHaveLength(1);
  const loggedDate = dates[0];
  await expect(doseRow()).toHaveCount(0);

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
  // visibility: the card's dose list is a <details> whose open state the revalidated
  // render resets, so "is it on screen" is a question about a disclosure, not about the
  // undo. Playwright retries the count until the new tree commits.
  await expect(doseRow()).toHaveCount(1);

  // ── 3. A tap that writes nothing gets no Undo ─────────────────────────────────
  // A taken row appears behind the rendered card, from somewhere this button had no
  // part in (an earlier tap, a Telegram confirm, the offline replay). Reload first so the
  // disclosure starts from a known state and the still-due row is reachable to tap, and
  // write the log only once that render is on screen — the row is BEHIND the card, which
  // is the whole stale-tab scenario.
  await page.goto("/household");
  await revealDoseRows(page, card);
  await expect(doseRow()).toBeVisible();
  logTakenBehindTheCard(itemId, doseId, loggedDate);
  await settledClick(page, doseRow().getByTestId("household-confirm-dose"));

  const repeat = page
    .getByTestId("toast")
    .filter({ hasText: "Already logged as taken" });
  await expect(repeat).toBeVisible();
  // THE ASSERTION: no Undo beside a tap that wrote nothing.
  await expect(repeat.getByRole("button", { name: "Undo" })).toHaveCount(0);
  // And the earlier row is untouched — the idempotent confirm added nothing.
  expect(takenLogDates(itemId)).toEqual([loggedDate]);

  // Leave the shared profile as it was found.
  const db = openDb();
  try {
    dropItem(db, itemId);
  } finally {
    db.close();
  }
});
