import { test, expect } from "@playwright/test";

// #817 Medications page redesign: the Today panel (scheduled dose check-off + PRN
// administration row), the /medications/[id] clinical-record detail page, and the
// "From your records" suggest-only bridge (Track this / dismiss). Fixtures come from
// e2e/seed-events.ts: "Adherence Refill Med (e2e)" (current daily, scheduled),
// "PRN Quicklog Med (e2e)" (PRN with administrations), and two untracked prescription
// records ("E2E Bridge Track Med" / "E2E Bridge Dismiss Med").

test("Today panel leads with a due scheduled dose and a PRN administration row", async ({
  page,
}) => {
  await page.goto("/medications");

  const today = page.getByTestId("medications-today");
  await expect(today).toBeVisible();

  // A scheduled, currently-due med shows its tri-state dose check-off inline.
  const scheduled = today
    .getByTestId("today-scheduled-med")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(scheduled).toBeVisible();
  await expect(scheduled.getByTestId("dose-status").first()).toBeVisible();

  // A PRN med shows a one-tap administration row (not a scheduled pill).
  await expect(
    today
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: "PRN Quicklog Med (e2e)" })
  ).toBeVisible();
});

test("a medication row links to its clinical-record detail page", async ({
  page,
}) => {
  await page.goto("/medications");

  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" })
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const detail = page.getByTestId("medication-detail");
  // Ride out the hydration window (#730): retry the navigation until detail shows.
  await expect(async () => {
    await link.click();
    await expect(detail).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expect(detail).toContainText("Adherence Refill Med (e2e)");
  // The detail page is the clinical-record home: its History disclosure (courses +
  // side effects) is open by default.
  await expect(detail).toContainText(/Courses/);
});

test("records bridge tracks an imported prescription that has no tracked med", async ({
  page,
}) => {
  await page.goto("/medications");

  const bridge = page.getByTestId("records-bridge");
  await expect(bridge).toBeVisible();
  const item = bridge
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Track Med" });
  await expect(item).toBeVisible();

  // "Track this" is a client onClick — retry the tap to ride out the hydration
  // window (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-track").click();
    await expect(
      page
        .getByTestId("records-bridge-item")
        .filter({ hasText: "E2E Bridge Track Med" })
    ).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The tracked med now appears as a current medication row.
  await expect(
    page
      .getByTestId("medication-row")
      .filter({ hasText: "E2E Bridge Track Med" })
  ).toBeVisible();
});

test("records bridge dismisses a suggestion via the findings bus", async ({
  page,
}) => {
  await page.goto("/medications");

  const item = page
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Dismiss Med" });
  await expect(item).toBeVisible();

  // Dismiss is a client onClick — retry the tap to ride out the hydration window
  // (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-dismiss").click();
    await expect(item).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The dismissal stays gone across a reload (persisted on the findings bus).
  await page.reload();
  await expect(
    page
      .getByTestId("records-bridge-item")
      .filter({ hasText: "E2E Bridge Dismiss Med" })
  ).toHaveCount(0);
});
