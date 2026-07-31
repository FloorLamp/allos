import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// Per-record extraction confidence (#1601) on the two review surfaces. The seed
// (e2e/seed/imports.ts, seedExtractionConfidence) plants AI-extracted document 906
// whose stored import_report reports 6 rows: 3 high, 2 medium, 1 low — so the detail
// page must rank the 3 hedged rows lowest-first and the Review feed must badge the
// row "· 3 to check". The neighbouring drop-report document 907 carries NO confidence
// block, which is the graceful-degradation half of the contract.
test.describe("Extraction confidence: ranking what deserves scrutiny", () => {
  test("ranks the hedged rows lowest-first on the import detail page", async ({
    page,
  }) => {
    await page.goto("/import/906");

    const card = page.getByTestId("confidence-card");
    // Framed as a share of the document's rows, not a bare count.
    await expect(
      card.getByText("Check these first (3 of 6 rows)")
    ).toBeVisible();
    // The posture is on the surface: nothing was withheld, this only orders review.
    await expect(card.getByText("were all imported")).toBeVisible();

    const rows = card.getByTestId("confidence-row");
    await expect(rows).toHaveCount(3);
    // Lowest confidence first, then the medium rows in document order.
    await expect(rows.nth(0)).toContainText("E2E Smudged Marker");
    await expect(rows.nth(0)).toContainText("low confidence");
    await expect(rows.nth(0)).toContainText("printed figure partly illegible");
    await expect(rows.nth(1)).toContainText("E2E Ambiguous Marker");
    await expect(rows.nth(1)).toContainText("medium confidence");
    // A hedged row with no stated reason still renders, with its domain label.
    await expect(rows.nth(2)).toContainText("E2E Possible Condition");
    await expect(rows.nth(2)).toContainText("Condition");
    await expect(rows.nth(2)).toContainText("medium confidence");

    // Every listed row carries a tier badge, and the confident rows are NOT listed.
    await expect(card.getByTestId("confidence-badge")).toHaveCount(3);
    await expect(card.getByText("high confidence")).toHaveCount(0);

    // Viewport-bounded like the Dropped card, so a heavily-hedged import can't
    // dominate the page.
    const scroller = card.getByTestId("confidence-scroll");
    const box = await scroller.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      maxHeight: getComputedStyle(el).maxHeight,
    }));
    expect(box.overflowY).toBe("auto");
    expect(box.maxHeight).not.toBe("none");
  });

  test("stays away for a document whose import reported no confidence", async ({
    page,
  }) => {
    // Document 907 is a deterministic CCD import: no model was asked, so there is no
    // signal to rank — and the card must not invent one (its other debug cards, which
    // the drop-report spec owns, still render).
    await page.goto("/import/907");
    await expect(page.getByTestId("confidence-card")).toHaveCount(0);
    await expect(page.getByTestId("dropped-card")).toBeVisible();
  });

  test("badges the Review feed row with how many rows to check", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");

    const row = feed
      .getByRole("listitem")
      .filter({ hasText: "e2e-confidence-labs.pdf" });
    await expect(row).toHaveCount(1);
    // The badge is additive: the produced-count detail still reads normally beside it.
    await expect(row.getByTestId("feed-scrutiny")).toHaveText("· 3 to check");
    await expect(row).toContainText("6 items");

    // A document with no confidence signal carries no badge.
    const plain = feed
      .getByRole("listitem")
      .filter({ hasText: "e2e-drop-report.xml" });
    await expect(plain).toHaveCount(1);
    await expect(plain.getByTestId("feed-scrutiny")).toHaveCount(0);

    // The badge is not itself a link — the row title still opens the detail page
    // where the ranked card lives.
    await followLink(
      page,
      row.getByRole("link", { name: "e2e-confidence-labs.pdf" }),
      /\/import\/906/
    );
    await expect(page.getByTestId("confidence-card")).toBeVisible();
  });
});
