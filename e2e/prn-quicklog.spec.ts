import { test, expect } from "./fixtures";
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

// Parse "N today · last …" → N.
function parseCount(text: string | null): number {
  const m = (text ?? "").match(/(\d+)\s+today/);
  return m ? Number(m[1]) : NaN;
}

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
  const newestAdmin = prnAdministrationRows(admin).first(); // first-ok: newest row on a newest-first ledger; the assertion is a property of "most recent", not a row identity
  await expect(newestAdmin).toContainText(
    /\d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  await expect(detail.getByTestId("dose-status")).toHaveCount(0);
});
