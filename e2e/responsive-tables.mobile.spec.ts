import { test, expect } from "./fixtures";
import { expectNoClippedContent, followLink, settledSelect } from "./helpers";

// Mobile-viewport spec (390×844, the `mobile` project — #1420) because the feature
// IS what a wide `<table>` becomes on a phone. At 1280px every one of these
// assertions is vacuous: the table renders as a table, `thead` is visible, and no
// cell ever claims a card slot. Issue #1426.
//
// The seeded biomarker rows are shared fixtures, so nothing here counts rows or
// names a specific analyte — the assertions are structural (which slots render,
// which labels come back, where the tap goes) plus one ordering comparison that
// holds for any fixture with two distinct names.

const BIOMARKERS = "/results/biomarkers";

// The master list is an index of collapsed panel groups since #1499 section A, so a
// spec about the ROW's card shape has to open a group first. `?q=` narrows the list
// to one analyte AND auto-expands the groups that match it (a search hit must never
// look like no-results), which is both the shortest route to a rendered card and a
// bounded, fixture-agnostic one — "Cholesterol" is present in every seeded profile.
const CARD_ROWS = `${BIOMARKERS}?q=Cholesterol`;

test.describe("responsive tables: stacked card rows below sm (#1426)", () => {
  test("the biomarkers table stacks as cards — no header row, prominent value, no sideways scroll", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("biomarkers-table");
    await expect(table).toBeVisible();

    // The header strip is gone in card mode; each cell carries its own label instead.
    await expect(table.locator("thead")).toBeHidden();

    // Skip the group's own header row — the card under test is a READING.
    const card = table
      .locator("tbody tr")
      .filter({ has: page.locator('td[data-card="title"]') })
      .first(); // first-ok: the spec asserts the card SHAPE, never which row is first
    await expect(card.locator('td[data-card="title"]')).toBeVisible();
    // The value (with its out-of-range flag) is on the card, not scrolled off it.
    const value = card.locator('td[data-card="value"]');
    await expect(value).toBeVisible();

    // Category is hidden below `md` in TABLE mode — the phone used to lose it
    // outright. It comes back as a labeled meta line on the card.
    await expect(
      table
        .locator('td[data-card="meta"] .card-cell-label', {
          hasText: "Category",
        })
        .first() // first-ok: one labeled meta cell proves the label round-trip; which row owns it is irrelevant
    ).toBeVisible();

    // The point of the exercise: no element hangs off the right edge, and no
    // horizontal scroller is doing the work.
    await expectNoClippedContent(page);
  });

  test("tapping a card's name opens the same biomarker detail the desktop row links to", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("biomarkers-table");
    await expect(table).toBeVisible();
    // The canonical-name link is the SAME `biomarkerViewHref` anchor the desktop
    // table renders — the card is a re-layout of that cell, not a second one.
    const link = table
      .locator('td[data-card="title"] a[href*="/biomarkers/view"]')
      .first(); // first-ok: any canonical row's link proves the card keeps the desktop destination
    await followLink(page, link, /\/biomarkers\/view\?name=/);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("sorting still works in card mode, through the compact sort select", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("biomarkers-table");
    await expect(table).toBeVisible();
    const firstTitle = table.locator('td[data-card="title"]').first(); // first-ok: the assertion is that whatever is first CHANGES when the sort flips — an ordering, not a fixture identity
    const ascending = (await firstTitle.innerText()).trim();

    const select = page.getByTestId("table-sort-select");
    await settledSelect(page, select, "name:desc");

    // One sort model: the select writes the same `?sort=`/`?dir=` params the
    // (hidden) SortableHeader writes, and the server re-orders.
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect
      .poll(async () => (await firstTitle.innerText()).trim())
      .not.toBe(ascending);
  });

  test("the training analyze sessions table stacks as cards too", async ({
    page,
  }) => {
    await page.goto("/training?tab=analyze");
    const table = page.getByTestId("analyze-sessions");
    await expect(table).toBeVisible();
    await expect(table.locator("thead")).toBeHidden();
    const card = table.locator("tbody tr").first(); // first-ok: the spec asserts the card shape of a session row, not which session
    // Date is the card title (and still the deep link into the log); the view's
    // leading metric is the headline value.
    await expect(card.locator('td[data-card="title"] a')).toBeVisible();
    await expect(card.locator('td[data-card="value"]')).toBeVisible();
    await expectNoClippedContent(page);
  });
});
