import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";

// The biomarker row says which band judged it, and what the verdict is called
// (#2315).
//
// WHAT WAS WRONG. The Reference cell printed `reference_range` — the free-text
// string the lab document stated — beside a flag `reconciledFlag` derived from the
// CANONICAL reference range and the CANONICAL optimal band. The printed string is
// provenance, not a threshold: it reaches that function only as an input to the
// #761 unit-mislabel detector. So the row showed the one range that never judges it
// and hid both that do, and the severity word ("High" vs "Above optimal") that
// separates a red row from an amber one travelled by color alone for a sighted
// reader.
//
// Fixture hygiene (#868): READ-ONLY against the shared seeded admin profile. Every
// assertion is bounded by an explicit filter and is presence-shaped — never an
// exact count of a shared-seed aggregate, and no writes.

// `sr-only` clips its element to a 1px box; a rendered word is wider. This is the
// assertion that separates "in the accessibility tree" from "in the visible text",
// which `toBeVisible()` cannot do — an sr-only span is visible to Playwright.
async function expectRenderedWide(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(4);
}

test("the Reference cell states the bands the flag came from, and keeps the lab's string as provenance", async ({
  page,
}) => {
  // A panel facet narrows the index AND expands every matching group (#1651), so
  // the readings are on the page without a disclosure tap.
  await page.goto("/results/biomarkers?panel=lipids&current=1");
  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  // ApoB is the issue's own example: the document printed `<90`, and the amber
  // "Above optimal" verdict comes from the canonical optimal band (≤60) that the
  // printed string never mentions. Both bands show, because which one you crossed
  // is exactly what the amber/red split means.
  const row = table
    .getByRole("row")
    .filter({ hasText: "Apolipoprotein B (ApoB)" });
  const cell = row.getByTestId("biomarker-reference");
  await expect(cell).toHaveText("ref ≤ 90 · optimal ≤ 60");
  await expect(cell).toHaveAttribute("data-judged", "true");
  // The lab's own string did not disappear — it moved from assertion to
  // provenance, on the cell that replaced it.
  await expect(cell).toHaveAttribute("title", "Lab reference: <90");

  // Nothing on this filtered view falls back: every lipid analyte is canonical, so
  // no row is still printing the lab's range as if it were the deciding one.
  await expect(
    table.locator('[data-testid="biomarker-reference"][data-judged="false"]')
  ).toHaveCount(0);
});

test("a flagged row's severity word is in the visible text, not only the accessibility tree", async ({
  page,
}) => {
  // Every row under this filter is out of range, so each one must carry a word.
  await page.goto("/results/biomarkers?range=oor&current=1");
  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  const words = table.locator(
    '[data-testid="medical-flag-text"][data-visible="true"]'
  );
  await expect(words).not.toHaveCount(0);
  await expectRenderedWide(words.first()); // first-ok: every row under this filter is flagged, so which word is measured is irrelevant — only that it is drawn, not clipped
  for (const t of await words.allTextContents()) {
    expect(["High", "Low", "Abnormal"]).toContain(t.trim());
  }

  // And the deciding band is rendered beside the value on the same rows.
  await expect(
    table.locator('[data-testid="biomarker-reference"][data-judged="true"]')
  ).not.toHaveCount(0);
});
