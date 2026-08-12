import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// "Check these first" → the row it names (issue #2339). The card ranked the rows
// the extractor hedged on but could not open any of them, so a reviewer had to
// eyeball-match a label against a tabbed table. The seed (e2e/seed/imports.ts,
// seedTriageLinks) plants document 910 with all three resolutions at once:
//
//   • "E2E Faded Marker"        → exactly one lab row      → link, tab, highlight
//   • "E2E Uncertain Condition" → one row on ANOTHER tab   → link switches tabs
//   • "E2E Twin Marker"         → two lab rows             → filters, picks none
//   • "E2E Vanished Marker"     → no row at all            → says so, no link
//
// The last two are the contract: sending a reviewer to the wrong row is worse
// than sending them to a filtered list, because they may edit it.
test.describe("Import triage: the confidence card links to the row it names", () => {
  test("a label naming one row scrolls to it, highlighted, on its own tab", async ({
    page,
  }) => {
    await page.goto("/import/910");

    const card = page.getByTestId("confidence-card");
    await expect(
      card.getByText("Check these first (4 of 6 rows)")
    ).toBeVisible();
    const row = card
      .getByTestId("confidence-row")
      .filter({ hasText: "E2E Faded Marker" });
    const link = row.getByTestId("confidence-row-link");
    await expect(link).toBeVisible();
    // Resolved by LABEL, never by a stored row id (which reprocessing invalidates).
    await expect(link).toHaveAttribute(
      "href",
      "/import/910?tab=lab&focus=E2E+Faded+Marker"
    );

    await followLink(page, link, /focus=E2E\+Faded\+Marker/);

    // The owning tab is now the current one…
    await expect(page.getByTestId("import-tab-lab")).toHaveAttribute(
      "aria-current",
      "page"
    );
    // …and exactly one row is selected: the one the label named.
    const focused = page.locator('tr[data-focused="true"]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toBeVisible();
    await expect(focused).toContainText("E2E Faded Marker");
    // "Highlighted" has to mean something a person could see: on screen, and
    // wearing a tint of its own rather than the table's transparent default.
    await expect(focused).toBeInViewport();
    const background = await focused.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    );
    expect(background).not.toBe("rgba(0, 0, 0, 0)");

    // Nothing was filtered away — a single match selects, it does not hide.
    await expect(
      page.getByRole("cell", { name: "E2E Settled Marker" })
    ).toBeVisible();
    await expect(page.getByTestId("triage-focus-notice")).toHaveCount(0);

    // The follow-through (#2339): the row now carries the extractor's hedge and
    // its reason, so the table says what the card says.
    await expect(focused.getByTestId("row-confidence-badge")).toBeVisible();
    await expect(focused.getByTestId("row-confidence-badge")).toHaveText(
      "low confidence"
    );
    await expect(
      focused.getByText("printed figure partly illegible")
    ).toBeVisible();
  });

  test("a label on another tab switches to that tab and highlights its row", async ({
    page,
  }) => {
    await page.goto("/import/910");

    const link = page
      .getByTestId("confidence-row")
      .filter({ hasText: "E2E Uncertain Condition" })
      .getByTestId("confidence-row-link");
    await expect(link).toHaveAttribute(
      "href",
      "/import/910?tab=conditions&focus=E2E+Uncertain+Condition"
    );
    await followLink(page, link, /tab=conditions/);

    await expect(page.getByTestId("import-tab-conditions")).toHaveAttribute(
      "aria-current",
      "page"
    );
    const focused = page.locator('li[data-focused="true"]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toBeVisible();
    await expect(focused).toContainText("E2E Uncertain Condition");
    await expect(focused).toBeInViewport();
    await expect(focused.getByTestId("row-confidence-badge")).toHaveText(
      "medium confidence"
    );
    await expect(focused.getByTestId("row-confidence-badge")).toBeVisible();
  });

  test("a label naming several rows filters the tab instead of picking one", async ({
    page,
  }) => {
    await page.goto("/import/910");

    const row = page
      .getByTestId("confidence-row")
      .filter({ hasText: "E2E Twin Marker" });
    // The card says up front that this one is ambiguous.
    await expect(row.getByTestId("confidence-row-ambiguous")).toBeVisible();
    await expect(row.getByTestId("confidence-row-ambiguous")).toHaveText(
      "several rows share this name"
    );
    await followLink(
      page,
      row.getByTestId("confidence-row-link"),
      /focus=E2E\+Twin\+Marker/
    );

    // No row is selected — that is the whole point: a reviewer sent to the wrong
    // row may edit it.
    await expect(page.locator('tr[data-focused="true"]')).toHaveCount(0);
    const notice = page.getByTestId("triage-focus-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("More than one row here is named");

    // The table shows the rows carrying that name, and only those. The analyte
    // grid prints a repeated name once per contiguous group, so the pair reads as
    // two rows under one name — and the count in the heading says so out loud.
    const table = page.getByTestId("extracted-observations");
    await expect(
      table.getByRole("heading", { name: "Labs (2)" })
    ).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(
      table.getByRole("cell", { name: "E2E Twin Marker" })
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "E2E Settled Marker" })
    ).toHaveCount(0);

    // And there is a way back out of the filter.
    await followLink(
      page,
      notice.getByRole("link", { name: "Show all rows" }),
      /\/import\/910\?tab=lab$/
    );
    await expect(
      page.getByRole("cell", { name: "E2E Settled Marker" })
    ).toBeVisible();
  });

  test("a label naming nothing says so instead of offering a dead link", async ({
    page,
  }) => {
    await page.goto("/import/910");

    const row = page
      .getByTestId("confidence-row")
      .filter({ hasText: "E2E Vanished Marker" });
    await expect(row).toBeVisible();
    // Its reason still reads — the row is listed, just not linked.
    await expect(row).toContainText("value read from a torn corner");
    await expect(row.getByTestId("confidence-row-missing")).toBeVisible();
    await expect(row.getByTestId("confidence-row-missing")).toHaveText(
      "no longer in this import"
    );
    await expect(row.getByTestId("confidence-row-link")).toHaveCount(0);

    // Reaching the same label by hand answers honestly rather than doing nothing.
    await page.goto("/import/910?tab=lab&focus=E2E%20Vanished%20Marker");
    const notice = page.getByTestId("triage-focus-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Nothing on this tab is named");
    await expect(page.locator('tr[data-focused="true"]')).toHaveCount(0);
    // The tab's own rows are untouched by a label that matched nothing.
    await expect(
      page.getByRole("cell", { name: "E2E Settled Marker" })
    ).toBeVisible();
  });
});
