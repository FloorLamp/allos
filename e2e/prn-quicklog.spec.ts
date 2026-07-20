import { test, expect } from "@playwright/test";
import { followLink, settledClick } from "./helpers";

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
  const todayPanel = page.getByTestId("medications-today");
  await expect(todayPanel).toBeVisible();
  const prnRow = todayPanel
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: MED });
  await expect(prnRow).toBeVisible();
  await expect(prnRow.getByTestId("prn-day-label")).toContainText(
    /\d+ today .* \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  // The med's clinical-record detail page keeps the day's administration ledger
  // ("N today · last …") and never a scheduled take/skip control for a PRN med.
  const rowLink = page
    .getByTestId("medication-row")
    .filter({ hasText: MED })
    .getByTestId("medication-row-link");
  await followLink(page, rowLink, /\/medications\/\d+/);
  const detail = page.getByTestId("medication-detail");
  const admin = detail.getByTestId("prn-administrations");
  await expect(admin).toBeVisible();
  await expect(admin).toContainText(/\d+ today/);
  await expect(admin).toContainText(
    /last \d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );
  await expect(
    admin.getByTestId("prn-administration-row").first()
  ).toContainText(
    /\d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  const overviewBox = await detail
    .getByTestId("medication-overview")
    .boundingBox();
  const guidanceBox = await detail
    .getByTestId("medication-guidance")
    .boundingBox();
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

  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();

  const item = widget
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: MED });
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
  const rowLink = page
    .getByTestId("medication-row")
    .filter({ hasText: MED })
    .getByTestId("medication-row-link");
  await followLink(page, rowLink, /\/medications\/\d+/);
  const detail = page.getByTestId("medication-detail");
  const admin = detail.getByTestId("prn-administrations");
  const rows = admin.getByTestId("prn-administration-row");
  await expect(rows.first()).toBeVisible();
  await settledClick(
    page,
    rows.first().getByTestId("prn-administration-remove")
  );
  // Back to the seeded count (the "Dose removed." undo toast is left to expire — the
  // removal must persist for cleanup, so we do NOT click Undo).
  await expect(admin).toContainText(`${before} today`);
});
