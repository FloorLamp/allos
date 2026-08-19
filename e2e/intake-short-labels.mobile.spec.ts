import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";

// Issue #2858 — the curated intake CONTROL label reaches the web's tight spots.
//
// This is the phone-width half deliberately, because the abbreviation only buys
// anything where the width is actually scarce: Upcoming renders each offered item
// as ONE CHIP in a wrapped run (#2579-F), and a chip whose text is
// "Coenzyme Q10 · Morning" spends most of a 390px line on a word the reader
// already reads as "CoQ10". At desktop width the same run has room for either, so
// a desktop-only assertion would pass on the version that fixed nothing.
//
// The second half of the promise is what keeps this from being a data loss: the
// FULL name must stay retrievable from the same control. The chip states it as its
// accessible name (and its hover title), so this asserts the pair — abbreviated
// text, unabbreviated accessible name — not just the abbreviation.
//
// The item name is the curated map's own key, not a decorated fixture name: the
// resolver is a LOOKUP, so a "(e2e)"-suffixed name would resolve to itself and the
// test would assert nothing. It is deleted in `finally`, and no seeded item shares
// it. Dates derive from frozenNow(), never wall-clock (#1417).

// The curated pair under test: lib/intake-short-name maps this name to this label.
const FULL_NAME = "Coenzyme Q10";
const SHORT_NAME = "CoQ10";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// A `may` (offered, never pushed) daily supplement with one morning dose on
// profile 1 — the shape that lands in Upcoming's availability disclosure.
function seedOfferedItem(db: Database.Database): {
  itemId: number;
  doseId: number;
} {
  const created = frozenNow();
  created.setUTCDate(created.getUTCDate() - 30);
  const createdAt = `${created.toISOString().slice(0, 10)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at)
         VALUES (1, ?, 1, 'supplement', 'may', 'daily', 'manual', ?)`
      )
      .run(FULL_NAME, createdAt).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '100 mg', 'Morning', 'any', 0, ?)`
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
  db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
}

test("an offered item's chip wears the short name and still announces the full one", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    itemId = seedOfferedItem(db).itemId;

    await page.goto("/upcoming");
    const available = page.getByTestId("available-section");
    await expect(available).toBeVisible();
    await available.locator("summary").click();

    // The chip run holds exactly one control for this item, whichever affordance
    // the row earned (log it, or open its page when the viewer cannot write).
    const chip = available
      .getByTestId("available-row")
      .filter({ hasText: SHORT_NAME });
    await expect(chip).toBeVisible();

    // THE assertion, both halves. The visible text is the abbreviation and does not
    // carry the long form anywhere in it…
    await expect(chip).not.toContainText(FULL_NAME);
    // …while the control's accessible name is the record's whole name, so the
    // abbreviation is a presentation of the item and never a rename of it.
    await expect(
      available.getByRole("button", { name: new RegExp(FULL_NAME) })
    ).toBeVisible();

    // A chip stays ONE line at phone width: the abbreviation exists so the run
    // wraps between chips rather than inside one.
    const box = await chip.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "the offered chip is laid out").not.toBeNull();
    expect(viewport, "the mobile project sets a viewport").not.toBeNull();
    expect(box!.width).toBeLessThan(viewport!.width);
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});
