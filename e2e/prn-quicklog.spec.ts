import { test, expect } from "@playwright/test";

// #797 PRN administration ledger: a PRN (as-needed) medication can be logged
// multiple times a day with real times, and both the Medications-page card and the
// dashboard "Log a PRN dose" widget surface the day's administrations. The seed
// (e2e/seed-events.ts) ships "PRN Quicklog Med (e2e)" — active, as_needed, with TWO
// administrations already logged earlier today — so the card reads "2 today" and the
// widget offers one-tap logging that makes it three.
const MED = "PRN Quicklog Med (e2e)";

test("Today panel shows the PRN med's administrations, detail shows the ledger (#797/#817)", async ({
  page,
}) => {
  await page.goto("/medications");

  // In the #817 redesign the daily-use surface is the Today panel: a PRN med is a
  // one-tap administration row (QuickLogPrnControl), NOT a scheduled dose pill.
  const todayPanel = page.getByTestId("medications-today");
  await expect(todayPanel).toBeVisible();
  const prnRow = todayPanel
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: MED });
  await expect(prnRow).toBeVisible();
  await expect(prnRow.getByTestId("prn-day-label")).toContainText("2 today");

  // The med's clinical-record detail page keeps the day's administration ledger
  // ("2 today · last …") and never a scheduled take/skip control for a PRN med.
  await page
    .getByTestId("medication-row")
    .filter({ hasText: MED })
    .getByTestId("medication-row-link")
    .click();
  const detail = page.getByTestId("medication-detail");
  await expect(detail).toBeVisible();
  const admin = detail.getByTestId("prn-administrations");
  await expect(admin).toBeVisible();
  await expect(admin).toContainText("2 today");
  await expect(admin).toContainText(/last \d{1,2}:\d{2}(am|pm)/);
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
  await expect(item).toBeVisible();
  await expect(item.getByTestId("prn-day-label")).toContainText("2 today");

  // One-tap "Log" records a fresh administration NOW → the count becomes three
  // (the two seeded ones are well outside the double-tap dedup window).
  await item.getByTestId("prn-log-now").click();
  await expect(item.getByTestId("prn-day-label")).toContainText("3 today");

  // The retro-time affordance reveals the offset / custom-time options.
  await item.getByTestId("prn-log-more").click();
  await expect(item.getByTestId("prn-log-options")).toBeVisible();
  await expect(item.getByTestId("prn-log-30m")).toBeVisible();
  await expect(item.getByTestId("prn-log-time")).toBeVisible();
});
