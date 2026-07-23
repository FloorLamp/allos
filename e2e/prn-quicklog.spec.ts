import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";
import {
  medicationsToday,
  prnTodayItem,
  prnAdministrations,
  prnAdministrationRows,
  medicationOverview,
  medicationGuidance,
  openMedDetailViaLink,
} from "./med-card-helpers";

// #797 PRN administration ledger: a PRN (as-needed) medication can be logged
// multiple times a day with real times, and both the Medications-page card and the
// dashboard "Log a PRN dose" widget surface the day's administrations. The seed
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

  const overviewBox = await medicationOverview(detail).boundingBox();
  const guidanceBox = await medicationGuidance(detail).boundingBox();
  expect(overviewBox).not.toBeNull();
  expect(guidanceBox).not.toBeNull();
  expect(Math.abs(overviewBox!.y - guidanceBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(overviewBox!.width - guidanceBox!.width)).toBeLessThanOrEqual(
    2
  );
  expect(
    Math.abs(overviewBox!.height - guidanceBox!.height)
  ).toBeLessThanOrEqual(2);
  await expect(detail.getByTestId("dose-status")).toHaveCount(0);
});

test("dashboard quick-log widget logs an administration and updates the count (#797)", async ({
  page,
}) => {
  await page.goto("/");

  // The seed leaves profile 1 with an OPEN illness episode, so the acting profile's PRN
  // quick-log lives in the illness-hero cockpit (which embeds the SAME logger). The
  // folded "Take any meds?" branch of the "How are you today?" check-in deliberately
  // steps aside while illness is active (#1221) — the cockpit is the single dashboard
  // instance of the `quick-log-prn` control, so this locator stays unambiguous. (The
  // well-day check-in meds branch is covered by e2e/dashboard-daily-loop.spec.ts.)
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();

  const item = prnTodayItem(widget, MED);
  if (!(await item.isVisible())) {
    const more = widget.getByTestId("quick-log-prn-more");
    await expect(more).toContainText(/More medications/);
    await more.locator("summary").click();
  }
  await expect(item).toBeVisible();
  const label = item.getByTestId("prn-day-label");
  const before = parseCount(await label.textContent());
  expect(before).toBeGreaterThanOrEqual(1);

  await expect(item.getByTestId("prn-log-now")).toHaveAccessibleName(
    "Taken now"
  );
  await expect(item.getByTestId("prn-log-more")).toHaveAccessibleName(
    "Earlier dose"
  );

  // One-tap "Taken now" records a fresh administration NOW → the count rises by one.
  // settledClick awaits the log Server-Action POST so the count assertion can't race it.
  await settledClick(page, item.getByTestId("prn-log-now"));
  await expect(label).toContainText(`${before + 1} today`);

  // A second immediate tap is deduplicated. Make that explicit instead of showing
  // the same success copy as a newly persisted administration.
  await settledClick(page, item.getByTestId("prn-log-now"));
  await expect(
    page.getByRole("status").filter({
      hasText: `${MED} was already logged just now.`,
    })
  ).toBeVisible();
  await expect(label).toContainText(`${before + 1} today`);

  // The retro-time affordance reveals the offset / custom-time options.
  await item.getByTestId("prn-log-more").click();
  await expect(item.getByTestId("prn-log-options")).toBeVisible();
  await expect(item.getByTestId("prn-log-30m")).toBeVisible();
  await expect(item.getByTestId("prn-log-time")).toBeVisible();

  // CLEAN UP (#868): remove the administration just logged so the shared fixture returns
  // to its seeded count — otherwise a --repeat-each run accumulates doses and the dedup
  // window collapses the next log. The dashboard widget has no remove affordance, so do
  // it on the med's detail page (the most-recent row is the one logged "now").
  await page.goto("/medications");
  const detail = await openMedDetailViaLink(page, MED);
  const admin = prnAdministrations(detail);
  const rows = prnAdministrationRows(admin);
  // The ledger is newest-first and this spec just logged an administration "now"
  // (settledClick-awaited above); CI runs workers=1 (sequential), so no neighbor can
  // interleave a newer row between the log and here — the newest row is deterministically
  // this spec's own just-logged one, so removing it undoes exactly this spec's write.
  const newestRow = rows.first(); // first-ok: newest row this spec just logged "now" on a newest-first ledger, under CI's sequential workers=1
  await expect(newestRow).toBeVisible();
  await settledClick(page, newestRow.getByTestId("prn-administration-remove"));
  // Back to the seeded count (the "Dose removed." undo toast is left to expire — the
  // removal must persist for cleanup, so we do NOT click Undo).
  await expect(admin).toContainText(`${before} today`);
});
