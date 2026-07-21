import { test, expect } from "@playwright/test";
import { medicationRow, medicationRowLink } from "./med-card-helpers";

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

  const warfarinRow = medicationRow(page, "Warfarin");
  await expect(warfarinRow).toBeVisible();

  const note = warfarinRow.getByTestId("medication-monitoring-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/Requires monitoring/i);
  await expect(note).toContainText("INR");

  const detailHref =
    await medicationRowLink(warfarinRow).getAttribute("href");
  await page.goto(detailHref!);
  const detailNote = page.getByTestId("medication-monitoring-detail");
  await expect(detailNote).toBeVisible();
  await expect(detailNote).toContainText("may need periodic INR monitoring");
  await expect(detailNote).toContainText(
    "Ask your prescriber which tests you need and how often"
  );
  await expect(
    detailNote.getByRole("link", { name: "View results" })
  ).toHaveAttribute("href", "/results?q=INR#biomarkers");
  const addResult = detailNote.getByRole("link", { name: "Add INR result" });
  const addResultHref = await addResult.getAttribute("href");
  expect(addResultHref).toBe("/results?name=INR#add-result");
  // Navigate through the verified href directly. Under dev-server load, the
  // detail RSC can detach after hydration while the destination has already
  // rendered, leaving a click-retry locator on the old page with no live node.
  await page.goto(addResultHref!);
  await expect(page).toHaveURL(/\/results\?name=INR#add-result$/);
  await expect(
    page.locator("#add-result").getByLabel("Name", { exact: true })
  ).toHaveValue("INR");
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
