import { test, expect } from "@playwright/test";

// Issue #516 — a documented POSITIVE durable-immunity antibody titer (hep A/B surface
// Ab, MMR/varicella IgG) is durable evidence and should never nag "retest overdue" on
// the flat 365-day clock, the way genomics never goes stale. The e2e fixture
// (e2e/seed-events.ts) plants "E2E Varicella IgG" = Immune, dated ~2 years ago. Before
// the fix its detail page rendered "These results are stale"; after, it's exempt.
test("a 2-year-old positive immunity titer is not marked stale (#516)", async ({
  page,
}) => {
  await page.goto("/biomarkers/view?name=E2E%20Varicella%20IgG");

  // Populated detail page for the titer (not the empty state).
  await expect(
    page.getByRole("heading", { name: "E2E Varicella IgG" })
  ).toBeVisible();

  // A positive durable-immunity result never goes stale, so the stale banner is
  // absent even though the only reading is well past a year old.
  await expect(page.getByText("These results are stale.")).toHaveCount(0);
});
