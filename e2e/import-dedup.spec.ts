import { test, expect } from "@playwright/test";

// Dogfoods the Data → Review duplicate/conflict resolver (issue #10, Phase 2). The
// e2e seed (e2e/seed-events.ts) plants a cross-source ACTIVITY pair on 2026-07-07:
// a manual "Morning run" and a Strava "Afternoon Run" with overlapping clock times,
// which detection flags as a HIGH-confidence duplicate. We assert it surfaces, then
// MERGE it and assert (a) the pair is gone, (b) it stays gone after a reload (the
// decision is durable), and (c) the profile badge decrements.
test.describe("Data → Review duplicate resolver", () => {
  test("surfaces a cross-source duplicate and merges it durably", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");

    // The badge sums the always-failing Strava integration (1) and the seeded
    // unresolved duplicate pair (1) = 2. This spec owns that fixture, so the exact
    // count is deterministic here.
    await expect(page.getByTestId("review-badge").first()).toHaveText("2");

    // The detected pair renders under "Possible duplicates" with both rows and a
    // High-confidence chip.
    await expect(review.getByText("Possible duplicates (1)")).toBeVisible();
    const pair = review.getByTestId("dup-activity-pair");
    await expect(pair).toHaveCount(1);
    await expect(pair.getByText("High confidence")).toBeVisible();
    await expect(pair.getByText("Morning run")).toBeVisible();
    await expect(pair.getByText("Afternoon Run")).toBeVisible();

    // Merge, keeping the default (integration/Strava) row. This deletes the manual
    // row, folds any missing fields in, and records a durable 'merged' decision.
    await pair.getByTestId("dup-merge-primary").click();

    // The pair is resolved — the duplicates section disappears.
    await expect(review.getByTestId("dup-activity-pair")).toHaveCount(0);
    await expect(review.getByText("Possible duplicates")).toHaveCount(0);

    // Durability: reloading re-runs detection against the live rows. The Strava row
    // still exists, but the decision (keyed on the stable pair signature) keeps the
    // pair suppressed — it must NOT resurface.
    await page.reload();
    await expect(
      page.getByTestId("review-inbox").getByTestId("dup-activity-pair")
    ).toHaveCount(0);

    // Only the kept (Afternoon Run) activity survives on that day; the merged-away
    // manual "Morning run" row is actually deleted, not just hidden.
    await page.goto("/timeline?from=2026-07-07&to=2026-07-07");
    await expect(page.getByText("Afternoon Run").first()).toBeVisible();
    await expect(page.getByText("Morning run")).toHaveCount(0);

    // The badge drops to 1 (just the still-failing Strava integration).
    await page.goto("/");
    await expect(page.getByTestId("review-badge").first()).toHaveText("1");
  });
});
