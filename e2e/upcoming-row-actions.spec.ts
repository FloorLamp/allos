import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
// Upcoming row composition (issue #1446).
//
// The all-pages census found every overdue row on /upcoming rendering TWO
// identical "⋯" overflow buttons side by side. The cause was never an
// overdue-specific branch: a preventive visit/screening item carries a
// `preventiveRuleKey` (→ the override menu) AND the default suppressible flag
// (→ the snooze/dismiss menu), and those were two independent OverflowMenu
// components. The overdue band merely happened to be all-preventive on the
// census's fresh profile.
//
// These specs assert the row CONTRACT rather than a pixel layout:
//   1. no row ever renders more than one overflow trigger,
//   2. a preventive row renders exactly one, and that one menu still offers BOTH
//      halves (the overrides and snooze/dismiss) — the merge, not a deletion,
//   3. the status label ("Overdue" / "3 days left") is a LEADING column, so it
//      lands at the same x on every row in a group instead of right-aligning
//      against variable-width CTA pills.
//
// Fixture policy (#868): these are READ-ONLY assertions over the shared seeded
// profile — they open a menu and press Escape, and never write. So they take no
// exact counts of shared rows (a neighbour spec marks preventive items done or
// overrides them) and never name a single catalog rule: every assertion is
// either per-row, a lower bound, or "any preventive row". Deliberately NOT a
// dedicated fixture profile: an extra profile is visible to every OTHER spec's
// dashboard (household strip), and adding one measurably destabilised the
// already-racy needs-attention-menu spec.

// The x-position tolerance for "the status column is aligned", in CSS px. Text
// rendering can shift a box by a subpixel; a regression to the old right-aligned
// layout moved it by hundreds of px (the census measured ~677–941).
const ALIGN_TOLERANCE = 1.5;

async function openUpcoming(page: Page): Promise<Locator> {
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  // The header count renders only once the attention model has been collected,
  // so it is the page's "ready" signal.
  await expect(main.getByTestId("upcoming-total")).toBeVisible();
  return main;
}

test.describe("Upcoming row actions (#1446)", () => {
  test("no row renders more than one overflow trigger, and a preventive row's single menu keeps both halves", async ({
    page,
  }) => {
    const main = await openUpcoming(page);
    const allRows = main.locator('[data-testid^="upcoming-item-"]');
    const count = await allRows.count();
    // A lower bound, never an exact count — neighbours mutate this shared list.
    expect(count).toBeGreaterThan(3);

    // THE regression assertion: never more than one kebab per row, page-wide.
    // Before the fix every preventive row here reported 2. (A row with nothing
    // to put behind a kebab — a structural signal that is neither suppressible
    // nor preventive — legitimately renders none, so the bound is ≤ 1; the
    // exactly-one case is pinned on a preventive row below.)
    for (let i = 0; i < count; i++) {
      const row = allRows.nth(i);
      const testId = await row.getAttribute("data-testid");
      const triggers = await row.getByTestId("overflow-menu-trigger").count();
      expect(
        triggers,
        `row ${testId} should render at most one overflow trigger`
      ).toBeLessThanOrEqual(1);
    }

    // A preventive row (visit/screening) is the shape that regressed: it has
    // both an override menu and a snooze menu to offer. Located by key prefix,
    // never by a specific rule, so a catalog edit or a neighbour's "mark done"
    // can't break the spec.
    const preventiveRow = main
      .locator(
        '[data-testid^="upcoming-item-visit:"], [data-testid^="upcoming-item-screening:"]'
      )
      .first(); // first-ok: any preventive row proves the shape — order-agnostic
    await expect(preventiveRow).toBeVisible();
    await expect(
      preventiveRow.getByTestId("overflow-menu-trigger")
    ).toHaveCount(1);

    // The single menu still carries BOTH halves — the override items AND
    // snooze/dismiss. This is what distinguishes the fix (a merge) from simply
    // deleting one of the two menus.
    await preventiveRow.getByLabel("More actions").click();
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Not applicable" })
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Declined" })
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "1 week" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Dismiss" })).toBeVisible();
    // Escape closes without writing anything, keeping this spec read-only.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("the status label is a leading column, aligned across a group's rows", async ({
    page,
  }) => {
    const main = await openUpcoming(page);

    // Measure within ONE group section — alignment is a within-group property
    // (each band is its own card).
    const sections = main.locator("section");
    const sectionCount = await sections.count();
    let measured: number[] = [];
    for (let i = 0; i < sectionCount; i++) {
      const statuses = sections.nth(i).getByTestId("upcoming-status");
      const n = await statuses.count();
      if (n < 3) continue;
      const xs: number[] = [];
      for (let j = 0; j < n; j++) {
        const box = await statuses.nth(j).boundingBox();
        if (box) xs.push(box.x);
      }
      if (xs.length >= 3) {
        measured = xs;
        break;
      }
    }
    expect(
      measured.length,
      "expected a group with at least 3 status labels to measure"
    ).toBeGreaterThanOrEqual(3);

    // Before the fix the label right-aligned against each row's own CTA pills,
    // so this spread was hundreds of px.
    expect(
      Math.max(...measured) - Math.min(...measured),
      `status labels should share one x; got ${JSON.stringify(measured)}`
    ).toBeLessThanOrEqual(ALIGN_TOLERANCE);
  });
});
