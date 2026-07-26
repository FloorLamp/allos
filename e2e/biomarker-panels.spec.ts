import { test, expect } from "./fixtures";
import { settledSelect } from "./helpers";

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
  await page.goto("/results/biomarkers");

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
  await page.goto(
    "/results/biomarkers?panel=Quest%20Diagnostics&q=Cholesterol"
  );
  await expect(
    page.getByTestId("biomarkers-table").getByText("LDL Cholesterol").first() // first-ok: presence check on the shared seed
  ).toBeVisible();
  await expect(page.getByTestId("panel-filter")).toHaveValue("");
});

test("biomarker detail links to the rest of its panel (#1502)", async ({
  page,
}) => {
  await page.goto(
    "/biomarkers/view?name=" + encodeURIComponent("LDL Cholesterol")
  );
  const siblings = page.getByTestId("panel-siblings");
  await expect(siblings).toBeVisible();
  await expect(siblings).toContainText("Lipids panel");

  // A sibling analyte from the same panel deep-links to its own detail page…
  await expect(
    siblings.getByRole("link", { name: "HDL Cholesterol" })
  ).toHaveAttribute("href", "/biomarkers/view?name=HDL%20Cholesterol");
  // …and the whole-panel link carries the slug facet.
  await expect(
    siblings.getByRole("link", { name: /See the whole panel/ })
  ).toHaveAttribute("href", "/results/biomarkers?panel=lipids");
});

test("an un-canonicalized reading keeps its stored heading as provenance (#1502)", async ({
  page,
}) => {
  // "E2E Novel Lab" (e2e/seed/imports.ts) is deliberately un-canonicalized under
  // the heading "E2E Iron Panel", so it resolves to the reserved `other` slug.
  // The taxonomy has nothing to say about it, so the Panel cell falls back to the
  // heading the document reported — as PLAIN TEXT, not a filter link, because
  // "everything under this heading" is exactly the useless facet #1502 removed.
  await page.goto(
    "/results/biomarkers?q=" + encodeURIComponent("E2E Novel Lab")
  );
  const table = page.getByTestId("biomarkers-table");
  await expect(table.getByText("E2E Novel Lab")).toBeVisible();
  await expect(table.getByText("E2E Iron Panel")).toBeVisible();
  await expect(table.getByRole("link", { name: "E2E Iron Panel" })).toHaveCount(
    0
  );
});
