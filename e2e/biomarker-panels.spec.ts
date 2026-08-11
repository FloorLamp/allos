import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  expectInView,
  followLink,
  hydratedClick,
  settledClick,
  settledSelect,
} from "./helpers";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import {
  E2E_LOGIN_MVBIO,
  MVBIO_RO_PROFILE,
  MVBIO_RO_ANALYTE,
} from "./logins/household";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The normalized biomarker panel taxonomy's three user-visible surfaces (#1502).
//
// Before this, `medical_records.panel` was the document's free-text section
// heading — in the seeded corpus (and in real imports) the LAB VENDOR. So the
// Timeline announced "Quest Diagnostics results", the browser's panel facet
// filtered by vendor, and a single-analyte detail page was a dead end. These
// assertions pin the replacements: clinical titles on the feed, a slug-backed
// clinical dropdown on the browser, and "the rest of this panel" on detail.
//
// Fixture hygiene (#868): READ-ONLY against the shared seeded admin profile, whose
// scripts/seed.ts lab draws carry canonical lipid analytes (Total/LDL/HDL
// Cholesterol, Triglycerides, ApoB, Lp(a)) under vendor panel strings. Every
// assertion is presence/absence bounded by an explicit filter — never an exact
// count of a shared-seed aggregate, and no writes.

// The vendor strings scripts/seed.ts stores in `medical_records.panel`. Every
// seeded lab analyte is canonicalized, so after #1502 none of these can title a
// timeline event or label a Panel cell.
const VENDOR_TITLES = /(Quest Diagnostics|LabCorp|BioReference) results/;

test("the Timeline titles lab draws by clinical panel, not the lab vendor (#1502)", async ({
  page,
}) => {
  await page.goto("/timeline?category=medical");

  // A clinically-named event is present…
  await expect(
    page.getByRole("heading", { name: "Lipids results" })
  ).not.toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Complete blood count results" })
  ).not.toHaveCount(0);

  // …and the vendor titles the feed used to lead with are gone. (Safe as an
  // absence assertion because every seeded lab reading carries a canonical name
  // the taxonomy places; an un-canonicalized row would still fall back to its
  // stored heading, which is the deliberate `other` behavior.)
  await expect(page.getByText(VENDOR_TITLES)).toHaveCount(0);
});

test("the biomarkers browser filters by a clinical panel slug (#1502)", async ({
  page,
}) => {
  await page.goto("/results/readings");

  // The facet is a first-class dropdown now, offering the curated taxonomy —
  // not a chip that only appeared after clicking a vendor string.
  const panelFilter = page.getByTestId("panel-filter");
  await expect(panelFilter).toBeVisible();
  await expect(panelFilter.getByRole("option", { name: "Lipids" })).toHaveCount(
    1
  );
  await expect(
    panelFilter.getByRole("option", { name: "Complete blood count" })
  ).toHaveCount(1);

  await settledSelect(page, panelFilter, "lipids");
  // The URL carries the stable SLUG, so a bookmark survives a reword.
  await page.waitForURL((u) => u.searchParams.get("panel") === "lipids", {
    timeout: 20_000,
  });

  const table = page.getByTestId("biomarkers-table");
  await expect(
    table.getByText("LDL Cholesterol").first() // first-ok: presence check; the shared seed holds several LDL readings
  ).toBeVisible();
  // A marker from a DIFFERENT panel is filtered out — proof the facet is
  // clinical, not "everything drawn at this vendor" (the seed puts lipids and
  // thyroid on the SAME vendor draws).
  await expect(table.getByText("Free T4")).toHaveCount(0);
  // The Panel cells read the clinical label, and no vendor string survives.
  const panelCell = table.getByRole("link", { name: "Lipids" }).first(); // first-ok: under this filter every row's Panel cell reads "Lipids" — which one is irrelevant
  await expect(panelCell).toBeVisible();
  await expect(
    table.getByText(/Quest Diagnostics|LabCorp|BioReference/)
  ).toHaveCount(0);
});

test("an unknown ?panel= slug is ignored rather than emptying the table (#1502)", async ({
  page,
}) => {
  // The shape of a stale bookmark from before the taxonomy: the old free-text
  // vendor facet. It must not filter the table to nothing.
  // `?q=` bounds the view to a known-present analyte, so a table that still
  // renders it proves the bogus panel value filtered NOTHING (a slug that reached
  // the query would have matched no row and emptied the table).
  await page.goto("/results/readings?panel=Quest%20Diagnostics&q=Cholesterol");
  await expect(
    page.getByTestId("biomarkers-table").getByText("LDL Cholesterol").first() // first-ok: presence check on the shared seed
  ).toBeVisible();
  await expect(page.getByTestId("panel-filter")).toHaveValue("");
});

test("biomarker detail links to the rest of its panel (#1502)", async ({
  page,
}) => {
  await page.goto(
    "/results/readings/view?name=" + encodeURIComponent("LDL Cholesterol")
  );
  const siblings = page.getByTestId("panel-siblings");
  await expect(siblings).toBeVisible();
  await expect(siblings).toContainText("Lipids panel");

  // A sibling analyte from the same panel deep-links to its own detail page…
  await expect(
    siblings.getByRole("link", { name: "HDL Cholesterol" })
  ).toHaveAttribute("href", "/results/readings/view?name=HDL%20Cholesterol");
  // …and the whole-panel link carries the slug facet.
  await expect(
    siblings.getByRole("link", { name: /See the whole panel/ })
  ).toHaveAttribute("href", "/results/readings?panel=lipids");
});

test("an un-canonicalized reading keeps its stored heading as provenance (#1502)", async ({
  page,
}) => {
  // "E2E Novel Lab" (e2e/seed/imports.ts) is deliberately un-canonicalized under
  // the heading "E2E Iron Panel", so it resolves to the reserved `other` slug.
  // The taxonomy has nothing to say about it, so the Panel cell falls back to the
  // heading the document reported — as PLAIN TEXT, not a filter link, because
  // "everything under this heading" is exactly the useless facet #1502 removed.
  await page.goto("/results/readings?q=" + encodeURIComponent("E2E Novel Lab"));
  const table = page.getByTestId("biomarkers-table");
  await expect(table.getByText("E2E Novel Lab")).toBeVisible();
  await expect(table.getByText("E2E Iron Panel")).toBeVisible();
  await expect(table.getByRole("link", { name: "E2E Iron Panel" })).toHaveCount(
    0
  );
});

// ── What a biomarker reading spends its lines on (#2316) ──────────────────────
//
// A reading cost ~300px on a phone, and four of its eight card lines carried
// nothing the reader could not already see: `PANEL Lipids` under a group heading
// reading "Lipids", `CATEGORY lab` on a row whose whole panel is lab, and a DATE
// stack printing the same instant twice with a provenance link under it. Panel and
// Category went back to being desktop-only detail (no `slot`), the date became one
// line, and the source link moved into the row's ⋯ menu.
//
// These assertions live in THIS spec because the Panel cell is what it already
// owns: the same cell whose filter link the taxonomy tests above pin at desktop
// width is the one that stops claiming a card line below `sm`.

const PHONE = { width: 390, height: 844 };

// The un-canonicalized import row (e2e/seed/imports.ts) — the one biomarker in the
// shared seed that carries a `document_id`, so it is the row whose ⋯ menu must be
// able to reach a source document. `?q=` bounds the view to it.
const IMPORT_ROW = "E2E Novel Lab";
const IMPORT_ROW_URL = "/results/readings?q=" + encodeURIComponent(IMPORT_ROW);

// The card labels a row is currently spending lines on. `.card-cell-label` is
// rendered ONLY for a cell that claims a `meta`/`value` slot (components/
// ResponsiveTable.tsx), so reading them back IS the "which cells made the card"
// question — the `<th>` strip is hidden in card mode and contributes nothing here.
async function cardLabels(page: Page, rowText: string): Promise<string[]> {
  const row = page
    .getByTestId("biomarkers-table")
    .locator("tr")
    .filter({ hasText: rowText });
  await expect(row).toHaveCount(1);
  return (await row.locator(".card-cell-label").allTextContents()).map((t) =>
    t.trim()
  );
}

test.describe("the phone card (#2316)", () => {
  test.use({ viewport: PHONE });

  test("spends no line on PANEL or CATEGORY, and none on a Source document link", async ({
    page,
  }) => {
    await page.goto(IMPORT_ROW_URL);
    const table = page.getByTestId("biomarkers-table");
    await expect(table.getByText(IMPORT_ROW)).toBeVisible();

    const labels = await cardLabels(page, IMPORT_ROW);
    // Panel is the group's own heading reprinted, and every real panel resolves to
    // one category — neither distinguishes anything inside the group it sits in.
    expect(labels).not.toContain("Panel");
    expect(labels).not.toContain("Category");
    // The Date cell keeps its slot: it is the row's only date line now.
    expect(labels).toContain("Date");

    // The link that used to cost a third line under DATE is gone from the card.
    await expect(
      table.getByText("Source document", { exact: true })
    ).toHaveCount(0);
  });

  test("prints the date and its compact age as ONE line", async ({ page }) => {
    await page.goto(IMPORT_ROW_URL);
    const row = page
      .getByTestId("biomarkers-table")
      .locator("tr")
      .filter({ hasText: IMPORT_ROW });
    // The age token sits inside the same cell as the ISO date — one `<td>`, one
    // line, at both viewports. Its text is the #1216 compact bucket, so it is
    // never the "2 months ago" long form the stack used to carry.
    const dateCell = row.locator('td[data-card="meta"]').filter({
      has: page.getByTestId("biomarker-age"),
    });
    await expect(dateCell).toHaveCount(1);
    await expect(dateCell).toContainText("2026-06-20");
    await expect(dateCell.getByTestId("biomarker-age")).not.toHaveText(/ago/);
  });

  test("reaches the source document from the row's ⋯ menu", async ({
    page,
  }) => {
    await page.goto(IMPORT_ROW_URL);
    const row = page
      .getByTestId("biomarkers-table")
      .locator("tr")
      .filter({ hasText: IMPORT_ROW });
    await hydratedClick(page, row.getByTestId("overflow-menu-trigger"));

    // The menu is portaled to <body>, so it is addressed from the page.
    const link = page.getByTestId("biomarker-source-document-link");
    await expect(link).toHaveText("View source document");
    await expect(link).toHaveAttribute("href", "/import/908");
    await expect(link).toHaveAttribute("role", "menuitem");
  });
});

test.describe("the phone filter block (#2316)", () => {
  test.use({ viewport: PHONE });

  test("collapses by default, keeping the search field out", async ({
    page,
  }) => {
    // `?q=` is NOT a facet: the search box stays visible at every width, so it can
    // never be a hidden filter — and the trigger's count is about hidden ones.
    await page.goto(IMPORT_ROW_URL);
    const toggle = page.getByTestId("medical-filters-toggle");
    await expect(toggle).toHaveText("Filters");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("medical-filters-facets")).toBeHidden();
    await expect(
      page.getByLabel("Search records by name or panel")
    ).toBeVisible();

    // One disclosure over one DOM: opening it reveals the SAME facet controls the
    // desktop layout renders inline, plus the card-mode sort select.
    await hydratedClick(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("panel-filter")).toBeVisible();
    await expect(page.getByLabel("Current values only")).toBeVisible();
    await expect(page.getByTestId("table-sort-select")).toBeVisible();
  });

  test("arrives OPEN and states the active count when the view is filtered", async ({
    page,
  }) => {
    // Two non-default facets — a filtered list may never look unfiltered.
    await page.goto("/results/readings?panel=lipids&current=1");
    const toggle = page.getByTestId("medical-filters-toggle");
    await expect(toggle).toHaveText("Filters · 2");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("panel-filter")).toBeVisible();
  });
});

test("Panel and Category keep their columns, filter links and sorting at desktop width (#2316)", async ({
  page,
}) => {
  await page.goto("/results/readings?panel=lipids&current=1");
  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  // Both columns are still in the header strip …
  await expect(page.getByRole("columnheader", { name: "Panel" })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Category" })
  ).toBeVisible();

  // … and both cells are still the filter links they were, on a real row.
  const row = table
    .getByRole("row")
    .filter({ hasText: "Apolipoprotein B (ApoB)" });
  await expect(row.getByRole("link", { name: "Lipids" })).toHaveAttribute(
    "href",
    /panel=lipids/
  );
  await expect(row.getByRole("link", { name: "lab" })).toHaveAttribute(
    "href",
    /category=lab/
  );

  // Header sorting is untouched: the Date header still opens newest-first, and the
  // params it writes are the ones the server orders by. The direction is asserted on
  // the HREF rather than after the click — followLink may re-click past the
  // hydration window, and a second click on the active column legitimately toggles.
  const dateSort = page
    .getByRole("columnheader", { name: "Date" })
    .getByRole("link");
  await expect(dateSort).toHaveAttribute("href", /sort=date&dir=desc/);
  await followLink(page, dateSort, /sort=date/);
  await expect(table).toBeVisible();
  // The sort select is the phone's stand-in for that strip and stays hidden here,
  // even though it now renders inside the filter block.
  await expect(page.getByTestId("table-sort-select")).toBeHidden();
});

// The regression this change could most easily introduce (#2316). The ⋯ menu was
// `canWrite ? <OverflowMenu…> : null` (#1331), which was right while every item was
// a WRITE — moving the provenance link into it would have silently deleted that link
// from every household-granted READ-ONLY row. The menu now renders whenever it has
// at least one item, so a read-only row with a source document gets a menu holding
// exactly that one.
//
// Spec-OWNED fixture (E2E_LOGIN_MVBIO — a WRITE base profile plus a READ-ONLY second
// one, whose unique analyte the seed gives a document). Read-only here: it only
// toggles the view-set and opens a menu, so it never races a neighbour.
test("a read-only household row keeps a ⋯ menu holding only the source document (#2316)", async ({
  browser,
}) => {
  test.slow();
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  let roId: number;
  try {
    db.pragma("busy_timeout = 5000");
    roId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(MVBIO_RO_PROFILE) as { id: number }
    ).id;
  } finally {
    db.close();
  }

  const page = await loginAs(browser, {
    username: E2E_LOGIN_MVBIO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The read-only member's rows only exist in MULTI-view: a single-view row is
    // always the acting profile's, so it is always writable. Toggle at the default
    // viewport, where the switcher's desktop mount lives, then narrow to a phone.
    const trigger = page.getByTestId("profile-identity-bar");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${roId}`));
    await expectInView(page, 2);

    await page.setViewportSize(PHONE);
    await page.goto(
      "/results/readings?q=" + encodeURIComponent(MVBIO_RO_ANALYTE)
    );
    const row = page
      .getByTestId("biomarkers-table")
      .locator("tr")
      .filter({ hasText: MVBIO_RO_ANALYTE });
    await expect(row).toHaveCount(1);
    // The chip proves this is the READ-ONLY member's row, not the acting one's.
    await expect(row.getByTestId(`subject-chip-${roId}`)).toBeVisible();

    // The menu is THERE — this is the assertion the change exists to keep true.
    const menuTrigger = row.getByTestId("overflow-menu-trigger");
    await expect(menuTrigger).toHaveCount(1);
    await hydratedClick(page, menuTrigger);

    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await expect(menu.getByRole("menuitem")).toHaveText("View source document");
    // …and it is still not a write affordance.
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
