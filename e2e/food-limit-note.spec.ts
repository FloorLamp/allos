import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledClick } from "./helpers";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { shiftDateStr } from "@/lib/date";

// The curated limit direction at the LOG TAP (issue #2377). The reduce direction has
// been curated since #775 and reached only the biomarker page and the coaching tab; the
// moment a food decision is made is the tap, and this pins what arrives there.
//
// Three things are on the surface and only here:
//   • the note is the tap's own answer — non-blocking, AFTER the write, and the serving
//     lands either way (#559: context gates order, never what can be logged);
//   • it names the marker that SELECTED the guidance, cites a source, and says out loud
//     that it is guidance for the marker rather than a claim about this serving;
//   • it fires once and then stops — a second tap of the same group the same day is
//     silent, which is the whole reason this is tolerable on a one-tap bar.
//
// Fixture discipline (shared seeded DB): this spec OWNS its rows — one uniquely named
// flagged LDL reading, and the profile's `fried_food` history, which is saved and
// restored exactly. `fried_food` must have NO servings on or after the reading's date
// for the note to be armed, so the seed clears that window and the teardown puts it
// back. Idempotent across --repeat-each and retries.

const READING = "LDL Cholesterol";
const GROUP = "fried_food";
const TODAY = frozenNow().toISOString().slice(0, 10);
// The reading's collection date — three days back, so "first serving since the limit
// became active" is a short, fully-owned window. Shifted through the app's own
// day arithmetic rather than a hand-built instant (the #2377 spec has no instants in it
// at all: every fact it seeds is day-grained).
const COLLECTED = shiftDateStr(TODAY, -3);

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// Every fried_food row in the arming window, exactly as found.
let priorRows: { date: string; servings: number }[] = [];
let seededReadingId: number | null = null;

function cleanup(): void {
  const db = openDb();
  try {
    if (seededReadingId != null) {
      db.prepare("DELETE FROM medical_records WHERE id = ?").run(
        seededReadingId
      );
      seededReadingId = null;
    }
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = 1 AND signal_key = 'food-reduce:ldl-apob'"
    ).run();
    db.prepare(
      "DELETE FROM food_log WHERE profile_id = 1 AND group_key = ? AND date >= ?"
    ).run(GROUP, COLLECTED);
    for (const row of priorRows) {
      db.prepare(
        `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (1, ?, ?, ?)
         ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
      ).run(row.date, GROUP, row.servings);
    }
    priorRows = [];
  } finally {
    db.close();
  }
}

function seed(): void {
  const db = openDb();
  try {
    priorRows = db
      .prepare(
        "SELECT date, servings FROM food_log WHERE profile_id = 1 AND group_key = ? AND date >= ?"
      )
      .all(GROUP, COLLECTED) as { date: string; servings: number }[];
    // Nothing logged since the reading — the state the note is armed in.
    db.prepare(
      "DELETE FROM food_log WHERE profile_id = 1 AND group_key = ? AND date >= ?"
    ).run(GROUP, COLLECTED);
    seededReadingId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, flag)
           VALUES (1, ?, 'lab', ?, '188', 'mg/dL', ?, 'high')`
        )
        .run(COLLECTED, READING, READING).lastInsertRowid
    );
  } finally {
    db.close();
  }
}

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

test.describe("the curated limit note at the log tap (#2377)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("the first serving of a limited group answers with cited guidance, and the second is silent", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();
    await revealFoodGroup(page, GROUP);

    const count = page.getByTestId(`count-${GROUP}`);
    const before = Number((await count.textContent())?.trim() || "0");

    await settledClick(page, page.getByTestId(`log-${GROUP}`));

    // The write is what matters and it happened: the note is a NOTE, never a gate.
    await expect(count).toHaveText(String(before + 1));

    const toast = page
      .getByTestId("toast")
      .filter({ hasText: "foods to limit" });
    await expect(toast).toBeVisible();
    // Names the marker that selected the guidance — the #577 shape, beside ONE act.
    await expect(toast).toContainText(READING);
    await expect(toast).toContainText("Source:");
    await expect(toast).toContainText("Informational, not medical advice.");
    // And says out loud that it is guidance for the marker, not a verdict on the
    // serving that was just logged (#992/#716, and the #2572 border).
    await expect(toast).toContainText("not a claim about this serving");
    await expect(toast).not.toContainText(/you should|shouldn't|avoid eating/i);
    // #998: a limit is a cap, and a cap has no run.
    await expect(toast).not.toContainText(/streak|in a row|to go|on pace/i);

    // The gate that makes this tolerable on a one-tap bar: at most one note per group
    // per day. The second tap logs and says nothing.
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
    // The reload is load-bearing twice over. It clears the #2007 post-success cooldown,
    // without which a second tap of the SAME write key is absorbed as an accidental
    // double and never reaches the server at all; and it proves the once-a-day gate is
    // the server's (`servings - 1`), not a client flag a fresh mount would re-arm.
    await page.reload();
    await revealFoodGroup(page, GROUP);
    await settledClick(page, page.getByTestId(`log-${GROUP}`));
    await expect(count).toHaveText(String(before + 2));
    await expect(toast).toHaveCount(0);

    // Restore the two owned servings. An undo is a DIFFERENT write from the log above
    // it, so the first is never absorbed by that tap's cooldown — but the second undo
    // shares a key with the first and needs the window cleared again.
    await settledClick(page, page.getByTestId(`undo-${GROUP}`));
    await expect(count).toHaveText(String(before + 1));
    await page.reload();
    await revealFoodGroup(page, GROUP);
    await settledClick(page, page.getByTestId(`undo-${GROUP}`));
    await expect(count).toHaveText(String(before));
  });
});
