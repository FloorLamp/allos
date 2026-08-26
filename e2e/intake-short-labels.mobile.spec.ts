import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// Issue #2858 — the curated intake CONTROL label on the web's tight spots, and the
// hazard that comes with it.
//
// Phone width deliberately: the abbreviation only buys anything where width is
// actually scarce. Upcoming renders each offered item as ONE CHIP in a wrapped run
// (#2579-F), and at 390px "Coenzyme Q10 · Morning" spends most of a line on a word
// the reader already reads as "CoQ10". A desktop-only assertion would pass on the
// version that fixed nothing.
//
// THE HAZARD, and why two of these tests exist. Shortening is MANY-TO-ONE: the
// curated map aliases on purpose, most of its values are plausible names in their
// own right, and the product fallback needs no curated entry at all. On these two
// surfaces the label sits on a control whose TAP WRITES A DOSE, so two rows wearing
// one label is a wrong-subject defect — the wrong item gets a taken row, the wrong
// supply is decremented, the wrong redose window moves, the intended dose is left
// open, and on the household card it is a dose confirmed on a member's behalf that
// they never took. The gather resolves collisions across the profile's whole item
// set so no renderer can emit an ambiguous control; these prove it in a browser.
//
// Item names are the curated map's own keys, not decorated fixture names: the
// resolver is a LOOKUP, so a "(e2e)"-suffixed name would resolve to itself and the
// tests would assert nothing. Every item is deleted in `finally`. Dates derive from
// frozenNow(), never wall-clock (#1417).

// The curated pair under test. The map sends both names to one short form.
const FULL_NAME = "Coenzyme Q10";
const SHORT_NAME = "CoQ10";
const ALIAS_NAME = "Ubiquinone";
const EITHER_NAME = new RegExp(`${FULL_NAME}|${ALIAS_NAME}|${SHORT_NAME}`);

const SEEDED_PROFILE_2 = 2; // "Sam Rivers" — the household card admin can confirm for.

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function createdAt(): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - 30);
  return `${d.toISOString().slice(0, 10)} 08:00:00`;
}

// One daily supplement with a single morning dose. `may` lands it in Upcoming's
// availability disclosure; `should` makes it a due row on the household card.
function seedItem(
  db: Database.Database,
  profileId: number,
  name: string,
  obligation: "may" | "should"
): number {
  const at = createdAt();
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at)
         VALUES (?, ?, 1, 'supplement', ?, 'daily', 'manual', ?)`
      )
      .run(profileId, name, obligation, at).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses
       (item_id, amount, time_of_day, food_timing, sort, created_at)
     VALUES (?, '100 mg', 'Morning', 'any', 0, ?)`
  ).run(itemId, at);
  return itemId;
}

function dropItems(db: Database.Database, itemIds: number[]): void {
  for (const itemId of itemIds) {
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE dose_id IN (SELECT id FROM intake_item_doses WHERE item_id = ?)`
    ).run(itemId);
    db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(itemId);
    db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
  }
}

async function openAvailable(page: Page): Promise<Locator> {
  await page.goto("/upcoming");
  const available = page.getByTestId("available-section");
  await expect(available).toBeVisible();
  await available.locator("summary").click();
  return available;
}

// A household card FOLDS its due-dose list past the shared threshold (#1504/#2615),
// so how many rows a card lays out is a neighbour's business. A plain <details>, so
// opening it is a pure client toggle and never a POST.
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

test("an offered item's chip wears the short name and still announces the full one", async ({
  page,
}) => {
  const db = openDb();
  const seeded: number[] = [];
  try {
    seeded.push(seedItem(db, 1, FULL_NAME, "may"));

    const available = await openAvailable(page);
    const chip = available
      .getByTestId("available-row")
      .filter({ hasText: SHORT_NAME });
    await expect(chip).toBeVisible();

    // Both halves of the promise, asserted EXACTLY rather than by containment —
    // "contains CoQ10" is also true of the unshortened text, which is what let the
    // first draft of this spec pass against a build that had not shortened anything.
    const control = chip.getByTestId("available-mark-taken");
    await expect(control).toHaveText(`${SHORT_NAME} · Morning`);
    // The compact visible name leads the accessible name, followed by the full
    // record name, so speech users can target what they see without losing identity.
    await expect(control).toHaveAttribute(
      "aria-label",
      `${SHORT_NAME} · Morning — ${FULL_NAME} · Morning`
    );
    const fullLabel = chip.getByRole("button", {
      name: `Full label: ${FULL_NAME} · Morning`,
    });
    await fullLabel.click();
    await expect(page.getByRole("tooltip")).toHaveText(
      `Full label: ${FULL_NAME} · Morning`
    );
  } finally {
    dropItems(db, seeded);
    db.close();
  }
});

test("two items that shorten alike keep distinct logging chips", async ({
  page,
}) => {
  const db = openDb();
  const seeded: number[] = [];
  try {
    seeded.push(seedItem(db, 1, FULL_NAME, "may"));
    seeded.push(seedItem(db, 1, ALIAS_NAME, "may"));

    const available = await openAvailable(page);
    const chips = available.getByTestId("available-row").filter({
      hasText: EITHER_NAME,
    });
    await expect(chips).toHaveCount(2);

    // THE assertion: two controls that write different doses never read alike.
    const texts = (await chips.allInnerTexts()).map((t) => t.trim()).sort();
    expect(texts).toEqual(
      [`${ALIAS_NAME} · Morning`, `${FULL_NAME} · Morning`].sort()
    );

    // …and each label really does sit over its own dose, so what the eye separates
    // is exactly what the tap posts.
    const doseIds = await chips
      .locator('input[name="dose_id"]')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLInputElement).value).sort()
      );
    expect(doseIds).toHaveLength(2);
    expect(new Set(doseIds).size).toBe(2);
  } finally {
    dropItems(db, seeded);
    db.close();
  }
});

test("a household card never shows two identical Confirm rows for two items", async ({
  page,
}) => {
  const db = openDb();
  const seeded: number[] = [];
  try {
    // On a member's card the same collision would confirm a dose on their behalf
    // that they did not take — the #2615 wrong-subject defect by a new mechanism.
    seeded.push(seedItem(db, SEEDED_PROFILE_2, FULL_NAME, "should"));
    seeded.push(seedItem(db, SEEDED_PROFILE_2, ALIAS_NAME, "should"));

    await page.goto("/household");
    const card = page.locator(
      `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
    );
    await revealDoseRows(page, card);
    const rows = card.getByTestId("household-due-dose").filter({
      hasText: EITHER_NAME,
    });
    await expect(rows).toHaveCount(2);

    // The row's first line is the item's name; the slot/amount line follows it.
    const titles = (await rows.allInnerTexts()).map((t) =>
      t.trim().split("\n")[0].trim()
    );
    expect(titles.sort()).toEqual([ALIAS_NAME, FULL_NAME].sort());
  } finally {
    dropItems(db, seeded);
    db.close();
  }
});
