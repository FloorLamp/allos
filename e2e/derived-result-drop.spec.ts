import { test, expect } from "./fixtures";

// #2678 Tier 3 — a drop by design still has to be visible.
//
// A printed BMI is dropped at ingest because the chart is a computation over the weight
// and height that arrived beside it, so there is no destination row to project into
// (#2646). Every OTHER ingest outcome leaves something behind — a stored row, an
// uncatalogued name, a sync count — and this one left nothing at all, which is what made
// it the outcome nobody could notice had happened. Now it is reported like the rest.
//
// The fixture (e2e/seed/imports.ts, document 912) is built by running the REAL shape
// pipeline over a synthetic paediatric visit, so these assertions fail if
// withoutDerivedResults stops reporting — not merely if the card stops rendering.
// Document 912 is owned entirely by this spec: the second test's precondition is an
// ABSENCE (no derived-result drop for a percentile), which no shared fixture could carry.
test.describe("Data → Review: the derived-result drop leaves a trail", () => {
  test("names the three printed derived results in the document's Dropped card", async ({
    page,
  }) => {
    // Straight to the document's Review detail rather than clicking through the feed:
    // the Imports feed is a SHARED, newest-first, 40-row list that every spec seeding a
    // document competes for, and this fixture's position in it is a co-residency
    // accident, not a property of the drop. Nothing in this PR changes the feed row.
    await page.goto("/import/912");

    const card = page.getByTestId("dropped-card");
    await expect(card.getByText("Dropped (3)")).toBeVisible();

    // One reason group, labelled for what it is: the row was not rejected, it was
    // answered elsewhere. Its badge carries the raw total; the identical rows collapse
    // to a single ×3 line.
    const group = card
      .getByTestId("drop-group")
      .filter({ hasText: "Derived result (charted from its inputs)" });
    await expect(group).toHaveCount(1);
    const row = group.getByTestId("drop-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Body Mass Index");
    await expect(row.getByTestId("drop-row-count")).toHaveText("×3");
  });

  test("keeps the percentile spellings as stored rows, out of the Dropped list", async ({
    page,
  }) => {
    // The half that used to be data loss: `Body Mass Index Percentile (BMI%)` and a
    // bare `BMI%` both resolved to the `bmi` slug and were deleted at ingest with no
    // record that they had existed. A percentile is not a BMI — it is the clinically
    // meaningful number for a child — so it stores.
    await page.goto("/import/912?tab=vitals");

    const produced = page.getByTestId("records-browser");
    await expect(produced.getByTestId("import-tab-vitals")).toContainText("2");

    // Both spellings are on the page as rows the import produced…
    const rows = page.getByTestId("extracted-observations");
    await expect(
      rows.getByText("Body Mass Index Percentile (BMI%)")
    ).toBeVisible();
    // Exact, because the longer spelling above contains this one as a substring.
    await expect(rows.getByText("BMI%", { exact: true })).toHaveCount(1);
    // …and the BMI itself is on no tab, because it genuinely was dropped.
    await expect(
      rows.getByText("Body Mass Index", { exact: true })
    ).toHaveCount(0);

    // …and neither appears in the Dropped card, whose only group is the BMI itself.
    const card = page.getByTestId("dropped-card");
    await expect(card.getByTestId("drop-group")).toHaveCount(1);
    await expect(card.getByText("Percentile")).toHaveCount(0);
  });
});
