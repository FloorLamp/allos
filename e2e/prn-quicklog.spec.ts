import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { settledClick } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { shiftDateStr } from "@/lib/date";
import {
  medicationsToday,
  prnTodayItem,
  prnAdministrations,
  prnAdministrationRows,
  openMedDetailViaLink,
} from "./med-card-helpers";

// #797 PRN administration ledger: a PRN (as-needed) medication can be logged
// multiple times a day with real times, and both the Medications-page card and the
// dashboard "Log a PRN dose" atom surface the day's administrations. The seed
// (e2e/seed-events.ts) ships "PRN Quicklog Med (e2e)" — active, as_needed, with TWO
// administrations already logged earlier today.
//
// #868 hygiene: this med is a SHARED-seed row, so these specs never pin its exact
// count (a neighbor's write or a --repeat-each run bumps it); they assert the count
// PATTERN, and the log test CLEANS UP the administration it adds so the fixture returns
// to its seeded state (the seed only resets at boot). Navigations use followLink and the
// log/remove Server-Action clicks use settledClick — the blessed settled interactions.
const MED = "PRN Quicklog Med (e2e)";

test("Today panel shows the PRN med's administrations, detail shows the ledger (#797/#817)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/medications");

  // In the #817 redesign the daily-use surface is the Today panel: a PRN med is a
  // one-tap administration row (QuickLogPrnControl), NOT a scheduled dose pill.
  const todayPanel = medicationsToday(page);
  await expect(todayPanel).toBeVisible();
  const prnRow = prnTodayItem(todayPanel, MED);
  await expect(prnRow).toBeVisible();
  await expect(prnRow.getByTestId("prn-day-label")).toContainText(
    /\d+ today .* \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  // The med's clinical-record detail page keeps the day's administration ledger
  // ("N today · last …") and never a scheduled take/skip control for a PRN med.
  const detail = await openMedDetailViaLink(page, MED);
  const admin = prnAdministrations(detail);
  await expect(admin).toBeVisible();
  await expect(admin).toContainText(/\d+ today/);
  await expect(admin).toContainText(
    /last \d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );
  // The ledger renders newest-first, and this assertion checks a PROPERTY of the
  // newest row (it carries a relative-time label) — true of ANY recent administration,
  // not an exact-row identity — so "first" here is just "newest", not "whichever row
  // a neighbor left on a shared list".
  const newestAdmin = prnAdministrationRows(admin).first(); // eslint-disable-line no-restricted-properties -- first-ok: newest row on a newest-first ledger; the assertion is a property of "most recent", not a row identity
  await expect(newestAdmin).toContainText(
    /\d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  await expect(detail.getByTestId("dose-status")).toHaveCount(0);
});

// THE ROW STATES WHAT LANDED (#5663 ruling 1). A tap on Take leaves "Taken" on the row
// and the toast reads the one grammar. The medication is this test's own and is removed
// after, so the shared seed's counts and redose window never see the write.
const OWN_MED = "PRN Receipt Med (e2e)";

function removeOwnMed(): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    const row = db
      .prepare("SELECT id FROM intake_items WHERE profile_id = 1 AND name = ?")
      .get(OWN_MED) as { id: number } | undefined;
    if (!row) return;
    db.prepare("DELETE FROM intake_item_logs WHERE item_id = ?").run(row.id);
    db.prepare("DELETE FROM medication_courses WHERE item_id = ?").run(row.id);
    db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(row.id);
    db.prepare("DELETE FROM intake_items WHERE id = ?").run(row.id);
  } finally {
    db.close();
  }
}

function seedOwnMed(): void {
  removeOwnMed();
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    const todayLocal = frozenNow().toLocaleDateString("en-CA", {
      timeZone: pinnedTimezone(frozenNow().toISOString()).zone,
    });
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, obligation, kind, active)
           VALUES (1, ?, 'daily', 'may', 'medication', 1)`
        )
        .run(OWN_MED).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '200 mg', 'Anytime', 'any', 0)`
    ).run(itemId);
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
       VALUES (?, ?, NULL, NULL, 'PRN — e2e receipt fixture')`
    ).run(itemId, shiftDateStr(todayLocal, -5));
  } finally {
    db.close();
  }
}

test("a Take tap states Taken on the row, toasts Dose logged, and undoes (#5663)", async ({
  page,
}) => {
  seedOwnMed();
  try {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.goto("/medications");
    const row = prnTodayItem(medicationsToday(page), OWN_MED);
    await expect(row.getByTestId("prn-receipt")).toHaveCount(0);
    await settledClick(page, row.getByTestId("prn-log-now"));
    await expect(row.getByTestId("prn-receipt")).toHaveText(
      /^Taken · \d{1,2}:\d{2}/
    );
    await expect(
      page.getByTestId("toast").filter({ hasText: /^Dose logged · / })
    ).toBeVisible();
    // The row's Undo takes that dose back, and the receipt goes with it.
    await settledClick(page, row.getByTestId("prn-receipt-undo"));
    await expect(row.getByTestId("prn-receipt")).toHaveCount(0);
  } finally {
    removeOwnMed();
  }
});
