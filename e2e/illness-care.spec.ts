import { test, expect } from "@playwright/test";

// Illness-care care finding (issue #805). The seed makes profile 1 currently sick —
// an ongoing "Illness" situation with a FEVER logged on four consecutive days
// (daysAgo 3→0), which crosses the cited "more than 3 days" line. The care-tier
// finding surfaces on Upcoming (the deterministic planning surface) via the SAME
// unified attention model the dashboard "Needs attention" hero subsets — so this
// asserts the model end-to-end where the render is cap-independent. Read-only
// against seeded data.
//
// The finding must state the logged FACT + the cited LINE + the SOURCE, and carry
// the mandatory "informational, not medical advice" tail — never a diagnosis.

test("a 4-day fever surfaces a cited illness-care finding on Upcoming", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const main = page.getByRole("main");

  // The illness-care row (domain-prefixed testid; the key carries the episode
  // anchor + symptom). One deterministic match for the seeded fever.
  const row = main
    .locator('[data-testid^="upcoming-item-illness-care:"]')
    .first();
  await expect(row).toBeVisible();

  // The logged fact.
  await expect(row).toContainText("Fever logged 4 days running");
  // The cited line + the source + the mandatory disclaimer tail.
  await expect(row).toContainText("more than 3 days");
  await expect(row).toContainText("Source:");
  await expect(row).toContainText("Informational, not medical advice.");
});
