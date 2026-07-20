import { test, expect } from "@playwright/test";

// #381 — the pinned starred-biomarker tile must judge staleness on the LATEST
// RECORD's category, like the detail page and table. A genomics result never goes
// stale (genetics don't change), but the tile used the canonical entry's category
// (null for this analyte) and mislabelled a 2-year-old genotype "stale". The e2e
// fixture (e2e/seed-events.ts) stars "E2E APOE Genotype", a genomics record dated
// 2023.
test("a starred genomics tile is not marked stale (#381)", async ({ page }) => {
  await page.goto("/results");

  const card = page.getByTestId("starred-biomarkers");
  await expect(card).toBeVisible();

  // The pinned tile for the genomics marker (scoped to the starred card, not the
  // table row that shares the same href).
  const tile = card.getByRole("link", { name: /E2E APOE Genotype/ });
  await expect(tile).toBeVisible();
  // Judged on the RECORD's 'genomics' category → never stale, so no stale note.
  await expect(tile).not.toContainText("stale");
});
