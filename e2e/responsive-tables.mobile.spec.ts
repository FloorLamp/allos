import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import {
  expectNoClippedContent,
  followLink,
  forgeBrokenCardPair,
  hydratedClick,
  restoreForgedPair,
  scanCardMetaPairs,
  settledSelect,
} from "./helpers";

// Mobile-viewport spec (390×844, the `mobile` project — #1420) because the feature
// IS what a wide `<table>` becomes on a phone. At 1280px every one of these
// assertions is vacuous: the table renders as a table, `thead` is visible, and no
// cell ever claims a card slot. Issue #1426.
//
// The seeded biomarker rows are shared fixtures, so nothing here counts rows or
// names a specific analyte — the assertions are structural (which slots render,
// which labels come back, where the tap goes) plus one ordering comparison that
// holds for any fixture with two distinct names.

const CLINICAL_RESULTS = "/results/clinical-results";

// The master list is an index of collapsed panel groups since #1499 section A, so a
// spec about the ROW's card shape has to open a group first. `?q=` narrows the list
// to one analyte AND auto-expands the groups that match it (a search hit must never
// look like no-results), which is both the shortest route to a rendered card and a
// bounded, fixture-agnostic one — "Cholesterol" is present in every seeded profile.
const CARD_ROWS = `${CLINICAL_RESULTS}?q=Cholesterol`;

test.describe("responsive tables: stacked rows below sm (#1426)", () => {
  test("the clinical results table stacks as flat rows — no header row, prominent value, no sideways scroll", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("clinical-results-table");
    await expect(table).toBeVisible();

    // The header strip is gone in card mode; each cell carries its own label instead.
    await expect(table.locator("thead")).toBeHidden();

    // Skip the group's own header row — the row under test is a READING.
    const card = table
      .locator("tbody tr")
      .filter({ has: page.locator('td[data-card="title"]') })
      .first(); // first-ok: the spec asserts the card SHAPE, never which row is first
    await expect(card.locator('td[data-card="title"]')).toBeVisible();
    // The value (with its out-of-range flag) is on the card, not scrolled off it.
    const value = card.locator('td[data-card="value"]');
    await expect(value).toBeVisible();

    // A meta cell carries its own label in card mode, because `thead` is hidden.
    // Date is the one every reading has, so it proves the label round-trip.
    await expect(
      table
        .locator('td[data-card="meta"] .card-cell-label', { hasText: "Date" })
        .first() // first-ok: one labeled meta cell proves the label round-trip; which row owns it is irrelevant
    ).toBeVisible();
    // Panel and Category claim NO card line (#2316). The mechanism is unchanged —
    // a cell with no `slot` is desktop-only detail — but these two stopped
    // distinguishing anything once grouping landed: inside a group headed "Lipids"
    // every card reprinted `PANEL Lipids`, and every real panel is one category.
    await expect(
      table.locator('td[data-card="meta"] .card-cell-label', {
        hasText: "Panel",
      })
    ).toHaveCount(0);
    await expect(
      table.locator('td[data-card="meta"] .card-cell-label', {
        hasText: "Category",
      })
    ).toHaveCount(0);

    // The point of the exercise: no element hangs off the right edge, and no
    // horizontal scroller is doing the work.
    await expectNoClippedContent(page);
  });

  test("tapping a row's name opens the same biomarker detail the desktop row links to", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("clinical-results-table");
    await expect(table).toBeVisible();
    // The canonical-name link is the SAME `clinicalResultDetailHref` anchor the desktop
    // table renders — the card is a re-layout of that cell, not a second one.
    const link = table
      .locator(
        'td[data-card="title"] a[href*="/results/clinical-results/view"]'
      )
      .first(); // first-ok: any canonical row's link proves the card keeps the desktop destination
    const destinationName = (await link.textContent())?.trim();
    expect(destinationName).toBeTruthy();
    await followLink(page, link, /\/results\/clinical-results\/view\?name=/);
    await expect(
      page.getByRole("heading", { name: destinationName!, exact: true })
    ).toBeVisible();
  });

  test("sorting still works in stacked-row mode, through the compact sort select", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("clinical-results-table");
    await expect(table).toBeVisible();
    const firstTitle = table.locator('td[data-card="title"]').first(); // first-ok: the assertion is that whatever is first CHANGES when the sort flips — an ordering, not a fixture identity
    const ascending = (await firstTitle.innerText()).trim();

    // The select moved into the filter block's phone disclosure (#2316): "narrow
    // this list" and "reorder this list" are one job on a phone, so they are one
    // strip of chrome instead of two stacked above the first reading.
    await hydratedClick(page, page.getByTestId("medical-filters-toggle"));
    const select = page.getByTestId("table-sort-select");
    await settledSelect(page, select, "name:desc", {
      destination: /sort=name&dir=desc/,
    });

    // One sort model: the select writes the same `?sort=`/`?dir=` params the
    // (hidden) SortableHeader writes, and the server re-orders.
    await expect
      .poll(async () => (await firstTitle.innerText()).trim())
      .not.toBe(ascending);
  });

  // ── ATOMIC LABEL–VALUE PAIRS (#3499) ──────────────────────────────────────
  //
  // The defect the owner's phone review named ("the table is unreadable", on the
  // imaging study list): a meta cell was a plain block box, so its label and its
  // value shared one inline flow and the line could break BETWEEN them. Three
  // pairs then read as one strip — "MODALITY Ultrasound DATE Oct 10, 2024 SOURCE
  // Document" — with nothing binding a label to the value it names.
  //
  // THIS MEASURES GEOMETRY, NOT A DECLARATION, and that is the whole point of it
  // living here rather than in the `components/**` jsdom tier (#3446). "No label
  // is separated from its value by a line break" is a fact about where boxes
  // landed; jsdom does no layout at all, so every rect it could offer is zero, and
  // the closest a DOM tier could get is `getComputedStyle(...).display ===
  // "inline-flex"` — the DECLARATION, which is a different claim. #3466 is the
  // receipt: its guard read the stepped 16px seam off the exact element it styled
  // and passed, while the seam the user saw stayed 24px because it collapsed
  // against an unstepped parent two files away.
  //
  // EACH SCAN CARRIES ITS OWN DISCRIMINATOR. "No pair is broken" is an absence,
  // and an absence over a selector passes the moment the selector stops matching
  // (#3509) — so every surface here (a) names labels it must have SEEN, and (b)
  // forges a break and requires the scan to flag exactly it, then restores and
  // re-runs the control.
  const expectAtomicPairs = async (scope: Locator, mustSee: string[]) => {
    const scan = await scanCardMetaPairs(scope);
    // (a) The scan SAW what it is meant to see. Without this the two assertions
    // below are both satisfied by a scan that found no pairs at all.
    expect(scan.labels, `pairs seen: ${scan.pairs.join(" | ")}`).toEqual(
      expect.arrayContaining(mustSee)
    );
    expect(
      scan.breaks,
      "a card-mode meta cell put its value on a different line from its own " +
        "label. The pair is supposed to be one non-wrapping flex line " +
        "(`table-cards` in app/globals.css); wrapping belongs BETWEEN pairs."
    ).toEqual([]);

    // (b) …and it can still SEE a break. The forgery is the pre-#3499 layout on
    // one cell, so this fails if the rect reads have gone blind.
    const forged = await forgeBrokenCardPair(scope);
    const forgedScan = await scanCardMetaPairs(scope);
    expect(
      forgedScan.breaks,
      "the scan did not flag a pair broken ON PURPOSE — it cannot see the " +
        "defect it is here to catch, so its clean sweep above meant nothing."
    ).toEqual([forged]);

    // The control AFTER the restore, not only before it.
    await restoreForgedPair(scope);
    expect((await scanCardMetaPairs(scope)).breaks).toEqual([]);
  };

  test("an imaging study card reads as distinct label-value pairs, and they wrap between pairs (#3499)", async ({
    page,
  }) => {
    await page.goto("/results/imaging");
    const list = page.getByTestId("imaging-study-list");
    // Wait for a rendered ROW, never the container: a region that has not painted
    // its content yet satisfies every geometry assertion made about it (#3384).
    const table = list.locator("table").first(); // first-ok: the claim is about the card SHAPE of a study row, not which table on the page owns it
    await expect(table.locator('td[data-card="title"]').first()).toBeVisible(); // first-ok: same — any rendered study row proves the pair layout
    await expectAtomicPairs(table, ["Modality", "Date"]);

    // The pairing has to be READABLE, not merely unbroken: label and value were
    // the same slate-500 before #3499, which is why the strip ran together. This
    // one IS a declaration question — "do these two resolve to different colours"
    // — so a computed read is the right instrument, in both themes.
    const cell = table
      .locator('td[data-card="meta"]:has(.card-cell-label)')
      .first(); // first-ok: every meta cell takes the one shared rule — any of them resolves the cascade
    const tones = async () =>
      cell.evaluate((td) => {
        const label = td.querySelector(".card-cell-label")!;
        return {
          value: getComputedStyle(td).color,
          label: getComputedStyle(label).color,
        };
      });
    const light = await tones();
    expect(light.value).not.toBe(light.label);
    await page.evaluate(() =>
      document.documentElement.classList.add("dark")
    );
    const dark = await tones();
    expect(dark.value).not.toBe(dark.label);
    // …and the theme switch really took, so the second check is not the first one
    // re-read under another name.
    expect(dark.value).not.toBe(light.value);
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark")
    );

    await expectNoClippedContent(page);
  });

  test("the clinical results catalog's cards keep their pairs atomic too (#3499)", async ({
    page,
  }) => {
    await page.goto(CARD_ROWS);
    const table = page.getByTestId("clinical-results-table");
    await expect(table).toBeVisible();
    await expect(
      table.locator('td[data-card="meta"] .card-cell-label').first() // first-ok: any labeled meta cell proves the pairs painted before they are measured
    ).toBeVisible();
    await expectAtomicPairs(table, ["Date"]);
  });

  test("the training analyze sessions table stacks as flat rows too", async ({
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
