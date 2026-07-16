import { test, expect, type Page, type Locator } from "@playwright/test";

// #852 Medications UX round 2: the time-aware Today panel (item 1), PRN→detail links in
// both hosts (item 2), the one-tap "Refilled" action + run-out date (item 3), the
// printable/shareable current-medication list (item 4), the detail-page month adherence
// calendar (item 5), and recoverable records-bridge dismissals (item 6). Fixtures come
// from e2e/seed-events.ts: "Zeta Morning Med (e2e)" / "Alpha Evening Med (e2e)" (scheduled,
// distinct buckets), "Low Supply Med (e2e)" (below the refill threshold), "Adherence
// Refill Med (e2e)" (scheduled with taken-logs), "PRN Quicklog Med (e2e)" (PRN), and
// "E2E Bridge Restore Med" (an untracked prescription for the dismiss→restore round-trip).

// The vertical position of the first element matching `name` within `scope`.
async function topOf(scope: Locator, name: string): Promise<number> {
  const box = await scope
    .getByText(name, { exact: false })
    .first()
    .boundingBox();
  if (!box) throw new Error(`not found: ${name}`);
  return box.y;
}

test("item 1: Today panel orders scheduled rows by bucket — same order as Upcoming", async ({
  page,
}) => {
  const ZETA = "Zeta Morning Med (e2e)"; // Morning bucket
  const ALPHA = "Alpha Evening Med (e2e)"; // Evening bucket

  await page.goto("/medications");
  const today = page.getByTestId("medications-today");
  await expect(today).toBeVisible();
  await expect(
    today.getByTestId("today-scheduled-med").filter({ hasText: ZETA })
  ).toBeVisible();

  // Morning outranks Evening, so Zeta leads Alpha despite the reversed alphabetical order.
  expect(await topOf(today, ZETA)).toBeLessThan(await topOf(today, ALPHA));

  // Upcoming derives the SAME order from the shared doseSortKey sortHint.
  await page.goto("/upcoming");
  await expect(page.getByText(ZETA).first()).toBeVisible();
  expect(await topOf(page.getByRole("main"), ZETA)).toBeLessThan(
    await topOf(page.getByRole("main"), ALPHA)
  );
});

test("item 2: a PRN row's name links to the med detail in the dashboard host", async ({
  page,
}) => {
  const MED = "PRN Quicklog Med (e2e)";
  await page.goto("/");
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();
  const link = widget
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: MED })
    .getByRole("link", { name: MED });
  await expect(link).toHaveAttribute("href", /\/medications\/\d+/);
});

test("item 3: low-supply med shows the run-out date and one-tap Refilled increases supply", async ({
  page,
}) => {
  const MED = "Low Supply Med (e2e)";
  await page.goto("/medications");
  const row = page.getByTestId("medication-row").filter({ hasText: MED });
  await expect(row).toBeVisible();

  // The refill badge projects a run-out DATE ("runs out ~<Mon Day>"), not just days-left.
  await expect(row.getByTestId("refill-run-out")).toContainText(/runs out ~/);

  // One-tap "Refilled" reuses the remembered fill size and records the refill. The
  // success toast is the repeat-safe signal (the fixture stays low across runs, so the
  // button persists and each tap just tops it up again).
  const refill = row.getByTestId("refill-button");
  await expect(refill).toBeVisible();
  await refill.click();
  await expect(page.getByText("Refill recorded.")).toBeVisible({
    timeout: 4000,
  });
});

async function extractShareUrl(page: Page): Promise<string> {
  await page.goto("/medications");
  const create = page.getByTestId("medication-share-create");
  // Ride out the hydration window (#730): retry opening the modal until its Create
  // button (a client-state toggle) actually appears.
  await expect(async () => {
    await page.getByTestId("medication-share-open").click();
    await expect(create).toBeVisible({ timeout: 2000 });
  }).toPass();
  await create.click();
  const url = page.getByTestId("medication-share-url");
  await expect(url).toBeVisible();
  return (await url.inputValue()).replace(/^https?:\/\/[^/]+/, "");
}

test("item 4: printable list renders current meds and the share link opens the same list", async ({
  page,
}) => {
  await page.goto("/medications");
  const printLink = page.getByTestId("medication-print-link");
  const print = page.getByTestId("medication-print");
  // Ride out the hydration window (#730): retry the navigation until the print page shows.
  await expect(async () => {
    await printLink.click();
    await expect(print).toBeVisible({ timeout: 2000 });
  }).toPass();
  const list = print.getByTestId("medication-list-view");
  await expect(list).toContainText("Adherence Refill Med (e2e)");
  await expect(list).toContainText("Dr. Test Provider"); // prescriber column

  // The tokenized share link opens the SAME MedicationListView (one computation), with
  // no app chrome and no login required (the /share/* public path).
  const sharePath = await extractShareUrl(page);
  expect(sharePath).toMatch(/^\/share\/[0-9a-f]+$/);
  await page.context().clearCookies();
  await page.goto(sharePath);
  await expect(page.getByTestId("medication-list-view")).toContainText(
    "Adherence Refill Med (e2e)"
  );
});

test("item 5: the detail page shows a month adherence calendar over the existing data", async ({
  page,
}) => {
  await page.goto("/medications");
  const rowLink = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" })
    .getByTestId("medication-row-link");
  const detail = page.getByTestId("medication-detail");
  // Ride out the hydration window (#730): retry the navigation until detail shows.
  await expect(async () => {
    await rowLink.click();
    await expect(detail).toBeVisible({ timeout: 2000 });
  }).toPass();
  const month = detail.getByTestId("medication-adherence-month");
  await expect(month).toBeVisible();
  await expect(month.getByTestId("adherence-calendar")).toBeVisible();
  // The seed logged 14 taken days, so at least one "taken" cell renders.
  await expect(
    month.getByTestId("adherence-cal-day").filter({ hasText: /\d/ }).first()
  ).toBeVisible();
  await expect(
    month
      .locator('[data-testid="adherence-cal-day"][data-state="taken"]')
      .first()
  ).toBeVisible();
});

test("item 6: a dismissed records-bridge suggestion is recoverable", async ({
  page,
}) => {
  const MED = "E2E Bridge Restore Med";
  await page.goto("/medications");
  const bridge = page.getByTestId("records-bridge");
  const active = bridge
    .getByTestId("records-bridge-item")
    .filter({ hasText: MED });

  // Dismiss it (it may already be dismissed from a prior run — handle both).
  if (await active.count()) {
    await active.getByTestId("records-bridge-dismiss").click();
    await expect(active).toHaveCount(0, { timeout: 3000 });
  }

  // It now lives in the collapsed "Dismissed (N)" disclosure with a Restore.
  const dismissed = bridge.getByTestId("records-bridge-dismissed");
  await expect(dismissed).toBeVisible();
  await dismissed.locator("summary").click();
  const dismissedItem = bridge
    .getByTestId("records-bridge-dismissed-item")
    .filter({ hasText: MED });
  await expect(dismissedItem).toBeVisible();

  // Restore puts it back into the active suggestions.
  await dismissedItem.getByTestId("records-bridge-restore").click();
  await expect(
    bridge.getByTestId("records-bridge-item").filter({ hasText: MED })
  ).toBeVisible({ timeout: 3000 });
});
