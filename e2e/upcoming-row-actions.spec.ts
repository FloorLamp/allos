import { test, expect, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_UPCOMING_ROWS, E2E_MEMBER_PASSWORD } from "./fixture-logins";

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
// These specs assert the row's CONTRACT rather than a pixel layout:
//   1. no row ever renders more than one overflow trigger,
//   2. a preventive row renders exactly one, and that one menu still offers BOTH
//      halves (the overrides and snooze/dismiss) — the merge, not a deletion,
//   3. the status label ("Overdue" / "3 days left") is a LEADING column, so it
//      lands at the same x on every row in a group instead of right-aligning
//      against variable-width CTA pills.
//
// They run against a spec-owned fixture (#868): an adult profile with a
// birthdate and no clinical records, so its /upcoming is dense with the
// preventive rows this issue is about. The shared seed's preventive rows are
// marked-done / overridden by other specs, so neither their identity nor their
// count is stable enough to assert row composition against.

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

function rows(main: Locator): Locator {
  return main.locator('[data-testid^="upcoming-item-"]');
}

test.describe("Upcoming row actions (#1446)", () => {
  test("no row renders more than one overflow trigger, and a preventive row's single menu keeps both halves", async ({
    browser,
  }) => {
    test.slow();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_UPCOMING_ROWS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const main = await openUpcoming(page);
      const allRows = rows(main);
      const count = await allRows.count();
      // The fixture is a record-free adult, so the preventive catalog fills the
      // page. A lower bound (not an exact count) keeps this robust to catalog
      // edits while still proving we're asserting against real rows.
      expect(count).toBeGreaterThan(3);

      // THE regression assertion: never more than one kebab per row, page-wide.
      // Before the fix every preventive row here reported 2. (A row with nothing
      // to put behind a kebab — a structural signal that is neither suppressible
      // nor preventive — legitimately renders none, so the bound is ≤ 1 rather
      // than exactly 1; the exactly-one case is pinned on a preventive row
      // below.)
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
      // both an override menu and a snooze menu to offer. Locate one by its key
      // prefix rather than by a specific rule, so a catalog change can't break
      // the spec.
      const preventiveRow = main
        .locator(
          '[data-testid^="upcoming-item-visit:"], [data-testid^="upcoming-item-screening:"]'
        )
        .first(); // first-ok: spec-owned fixture — any preventive row proves the shape
      await expect(preventiveRow).toBeVisible();
      await expect(
        preventiveRow.getByTestId("overflow-menu-trigger")
      ).toHaveCount(1);

      // The single menu still carries BOTH halves — the override items AND
      // snooze/dismiss. This is what distinguishes the fix (merge) from simply
      // deleting one of the two menus.
      await preventiveRow.getByLabel("More actions").click();
      const menu = page.getByRole("menu");
      await expect(
        menu.getByRole("menuitem", { name: "Not applicable" })
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Declined" })
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "1 week" })
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Dismiss" })
      ).toBeVisible();
      // Escape closes without writing anything, keeping this spec read-only.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("the status label is a leading column, aligned across a group's rows", async ({
    browser,
  }) => {
    test.slow();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_UPCOMING_ROWS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const main = await openUpcoming(page);

      // Take one group section that has several rows — alignment is a
      // within-group property (each band is its own card).
      const sections = main.locator("section");
      const sectionCount = await sections.count();
      let measured: number[] = [];
      for (let i = 0; i < sectionCount; i++) {
        const statuses = sections.nth(i).getByTestId("upcoming-status");
        if ((await statuses.count()) < 3) continue;
        const n = await statuses.count();
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

      const min = Math.min(...measured);
      const max = Math.max(...measured);
      // Before the fix the label right-aligned against each row's own CTA pills,
      // so this spread was hundreds of px.
      expect(
        max - min,
        `status labels should share one x; got ${JSON.stringify(measured)}`
      ).toBeLessThanOrEqual(ALIGN_TOLERANCE);
    } finally {
      await page.context().close();
    }
  });
});
