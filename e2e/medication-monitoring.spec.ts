import { test, expect } from "@playwright/test";

// Medication → required-monitoring-lab bridge (issue #995). The seed's ACTIVE "Warfarin"
// medication (kind medication, course started ~90 days ago, NO INR reading on file) is a
// care-tier monitored drug (→ INR), so it deterministically renders:
//   1. the "Requires monitoring: INR" note on its Medications row, and
//   2. a "Monitoring labs for Warfarin" retest item on the Upcoming page.
// Both are READ-ONLY presence assertions against the shared seed (no mutation, no
// count-assert on a shared row — safe under --repeat-each per e2e hygiene #868).

test("the Medications row shows a 'requires monitoring' note for a monitored drug", async ({
  page,
}) => {
  await page.goto("/medications");

  const warfarinRow = page
    .getByTestId("medication-row")
    .filter({ hasText: "Warfarin" });
  await expect(warfarinRow).toBeVisible();

  const note = warfarinRow.getByTestId("medication-monitoring-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/Requires monitoring/i);
  await expect(note).toContainText("INR");
});

test("a med-driven monitoring retest surfaces on the Upcoming page", async ({
  page,
}) => {
  await page.goto("/upcoming");

  // The retest clock CREATED by taking warfarin — "Monitoring labs for Warfarin".
  await expect(
    page.getByText("Monitoring labs for Warfarin", { exact: false }).first()
  ).toBeVisible();
});
