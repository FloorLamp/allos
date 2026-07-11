import { test, expect } from "@playwright/test";

// Drug-/supplement-interaction checking (issue #144). The seed gives profile 1 a
// known-interacting pair — Warfarin (rxcui-keyed) + Ibuprofen (name-matched), a MAJOR
// bleeding-risk interaction. /medicine must show a severity-ranked warning row, and
// the SAME finding must appear on Upcoming and stay hidden once dismissed. Assertions
// are scoped to the page's main region; the Upcoming dismiss mutates seeded state, so
// this test owns that side effect for the run.

test("shows the seeded warfarin + ibuprofen interaction warning on /medicine", async ({
  page,
}) => {
  await page.goto("/medicine");
  const main = page.getByRole("main");

  const warnings = main.getByTestId("interaction-warnings");
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("Warfarin");
  await expect(warnings).toContainText("Ibuprofen");
  // Severity + the informational, never-prescriptive framing + a source citation.
  await expect(warnings).toContainText("MAJOR");
  await expect(warnings).toContainText("discuss with your");
  await expect(warnings).toContainText("Source:");
});

test("the interaction surfaces on Upcoming and stays hidden once dismissed", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const main = page.getByRole("main");

  // The finding is keyed on the item-id pair: `interaction:<lo>-<hi>`.
  const finding = main
    .locator('[data-testid^="upcoming-item-interaction:"]')
    .first();
  await expect(finding).toBeVisible();
  await expect(finding).toContainText("Warfarin");
  await expect(finding).toContainText("Ibuprofen");

  // Open its snooze/dismiss menu and dismiss it.
  await finding.getByRole("button", { name: "Snooze or dismiss" }).click();
  await finding.getByRole("button", { name: "Dismiss" }).click();

  // After the server action + reload, the finding is gone from the live list.
  await expect(
    main.locator('[data-testid^="upcoming-item-interaction:"]')
  ).toHaveCount(0);
});
