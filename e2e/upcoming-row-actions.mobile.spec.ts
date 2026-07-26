import { test, expect } from "./fixtures";
// Upcoming row composition at phone width (issue #1446, mobile project #1420).
//
// At 390px the per-item control row (status + CTA + "Book" + "Mark done" + "⋯")
// free-wrapped: the census found at least five cards whose wrapped tail was an
// ORPHANED "⋯" alone on its own line, and one card with two "⋯" stacked. The fix
// gives the trailing controls a line of their own and folds the secondary chips
// into the row's single overflow menu below `sm`, keeping the tail to
// [primary CTA][⋯] glued in one nowrap group.
//
// Assertions are about composition, not pixels:
//   1. still at most one overflow trigger per row at phone width,
//   2. the secondary chips are NOT inline here (they folded),
//   3. …and they're reachable in the menu — nothing became unreachable on
//      mobile, which on this care-tier surface matters (#449),
//   4. the trailing control line occupies ONE line (an orphan means two), and
//   5. no row overflows the viewport horizontally.
//
// Read-only over the shared seeded profile, same fixture policy as the desktop
// spec: per-row properties and "any preventive row", never an exact row count
// and never a named catalog rule. This file runs in the `mobile` project, so the
// default `page` already carries the 390×844 phone viewport.

// One control line is a 40px hit-target tall plus padding. A wrapped line (the
// orphaned-"⋯" defect) is at least double that.
const ONE_LINE_MAX_HEIGHT = 64;

test("each row keeps one overflow trigger, folds its secondary chips, and fits the viewport", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  await expect(main.getByTestId("upcoming-total")).toBeVisible();

  const allRows = main.locator('[data-testid^="upcoming-item-"]');
  const count = await allRows.count();
  expect(count).toBeGreaterThan(3);

  const viewportWidth = page.viewportSize()!.width;

  for (let i = 0; i < count; i++) {
    const row = allRows.nth(i);
    const testId = await row.getAttribute("data-testid");

    // (1) One kebab per row still holds at 390px — the census saw a card with
    // two of them STACKED here.
    const triggers = await row.getByTestId("overflow-menu-trigger").count();
    expect(
      triggers,
      `row ${testId} should render at most one overflow trigger at 390px`
    ).toBeLessThanOrEqual(1);

    // (5) The row never pushes past the viewport (the shell clips overflow-x,
    // which is how controls silently disappeared rather than wrapped).
    const rowBox = await row.boundingBox();
    if (rowBox) {
      expect(
        rowBox.x + rowBox.width,
        `row ${testId} should not overflow the ${viewportWidth}px viewport`
      ).toBeLessThanOrEqual(viewportWidth + 1);
    }

    // (4) The trailing control line stays a single line. An orphaned "⋯" means
    // the controls wrapped, which doubles this box's height.
    const actionLine = row.getByTestId("upcoming-row-actions");
    if ((await actionLine.count()) === 1) {
      const box = await actionLine.boundingBox();
      if (box) {
        expect(
          box.height,
          `row ${testId} trailing controls should occupy one line`
        ).toBeLessThanOrEqual(ONE_LINE_MAX_HEIGHT);
      }
    }
  }

  // (2)+(3) On a preventive row the secondary chips fold: "Mark done" is not an
  // inline control at this width, but it IS in the row's one menu. This half
  // keeps the fold honest — a care-tier action may be moved behind a kebab on a
  // phone, never removed (#449).
  const preventiveRow = main
    .locator(
      '[data-testid^="upcoming-item-visit:"], [data-testid^="upcoming-item-screening:"]'
    )
    .first(); // first-ok: any preventive row proves the fold — order-agnostic
  await expect(preventiveRow).toBeVisible();
  await expect(
    preventiveRow.getByRole("button", { name: "Mark done" })
  ).toBeHidden();

  await preventiveRow.getByLabel("More actions").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Mark done" })).toBeVisible();
  // The menu's always-present half is still there beneath the folded items.
  await expect(menu.getByRole("menuitem", { name: "1 week" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});
