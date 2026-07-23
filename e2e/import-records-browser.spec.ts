import { test, expect } from "@playwright/test";
import { followLink, settledClick } from "./helpers";

// Import detail — tabbed per-category records browser (issue #271). The e2e seed
// (e2e/seed-events.ts) plants document 908 with produced rows across several
// kinds: 2 labs + 1 projected medication (intake_items — the single medication
// entity an imported prescription becomes, #1178/#1232), a visit, a condition,
// an immunization, and one referenced provider. The browser must expose EVERY
// produced type as a browsable tab (visits & co. used to be invisible), keep the
// counts as the tab labels, link rows category-correctly (the medication →
// biomarker-page regression), and expose providers as their own tab (#1182 —
// the per-document Providers listing is covered by import-produced-panels.spec).
test.describe("Import detail: tabbed records browser", () => {
  test("tab strip lists every produced type with counts; default = first tab", async ({
    page,
  }) => {
    await page.goto("/import/908");

    const strip = page.getByTestId("import-tab-strip");
    await expect(strip.getByTestId("import-tab-lab")).toHaveText("Labs 2");
    await expect(strip.getByTestId("import-tab-medications")).toHaveText(
      "Medications 1"
    );
    await expect(strip.getByTestId("import-tab-visits")).toHaveText("Visits 1");
    await expect(strip.getByTestId("import-tab-conditions")).toHaveText(
      "Conditions 1"
    );
    await expect(strip.getByTestId("import-tab-immunizations")).toHaveText(
      "Immunizations 1"
    );
    // Providers are now a real tab (#1182) — #275 gave them a page, so the old
    // count-chip-into-the-global-registry placeholder is gone; its ?tab= selects a
    // per-document Providers listing (asserted in import-produced-panels.spec).
    await expect(strip.getByTestId("import-tab-providers")).toHaveText(
      "Providers 1"
    );

    // Default tab (no ?tab=) is the FIRST non-empty tab — Labs — marked current,
    // and its editable table renders the lab rows.
    await expect(strip.getByTestId("import-tab-lab")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByRole("heading", { name: /^Labs/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Ferritin/ })).toBeVisible();
    // A canonicalized lab row's name still links to its biomarker series view.
    await expect(
      page.getByRole("link", { name: "Ferritin", exact: true })
    ).toHaveAttribute("href", "/biomarkers/view?name=Ferritin");
    // The lab table keeps its editing affordances inside the tab.
    await page.getByRole("button", { name: "Record actions" }).first().click(); // first-ok: any lab row's Record actions menu carries Edit — order-agnostic (asserted next)
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("REGRESSION: the document's medication links to /medications, never a biomarker page", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=medications");

    await expect(page.getByTestId("import-tab-medications")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(
      page.getByRole("heading", { name: /^Medications/ })
    ).toBeVisible();
    const listing = page.getByTestId("produced-listing");
    const item = listing.getByTestId("produced-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("E2E Loratadine");
    await expect(item.getByRole("link")).toHaveAttribute(
      "href",
      "/medications"
    );
    // Nothing in the medications panel may point at a biomarker series page.
    const biomarkerLinks = listing.locator('a[href^="/biomarkers/view"]');
    await expect(biomarkerLinks).toHaveCount(0);
  });

  test("visits tab lists the visit and deep-links to its detail page", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=visits");

    const listing = page.getByTestId("produced-listing");
    await expect(
      listing.getByRole("heading", { name: /^Visits/ })
    ).toBeVisible();
    const item = listing.getByTestId("produced-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("E2E Browser Visit");
    await expect(item).toContainText("E2E annual physical");
    const link = item.getByRole("link");
    await expect(link).toHaveAttribute("href", /^\/encounters\/\d+$/);
    // Nav anchor → followLink rides out the pre-hydration swallow (#889 sweep).
    await followLink(page, link, /\/encounters\/\d+$/);
    await expect(page.getByText("E2E annual physical")).toBeVisible();
  });

  test("other produced kinds are browsable too (conditions, immunizations)", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=conditions");
    const conditions = page.getByTestId("produced-listing");
    await expect(conditions.getByTestId("produced-item")).toContainText(
      "E2E Hay fever"
    );
    await expect(
      conditions.getByTestId("produced-item").getByRole("link")
    ).toHaveAttribute("href", "/records/problems");

    await page.goto("/import/908?tab=immunizations");
    const imms = page.getByTestId("produced-listing");
    await expect(imms.getByTestId("produced-item")).toContainText("E2E Tdap");
    await expect(
      imms.getByTestId("produced-item").getByRole("link")
    ).toHaveAttribute("href", "/records/history/immunizations");

    // An unknown ?tab= falls back to the default (first) tab instead of a
    // broken panel.
    await page.goto("/import/908?tab=bogus");
    await expect(page.getByTestId("import-tab-lab")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  // The preview-first re-extraction panel (ReprocessDiffPanel) — the SOLE
  // per-document reprocess after the #1071 verb consolidation. The e2e env has NO
  // extractor configured, so a preview reports it can't re-extract and the panel
  // offers "Re-extract anyway" rather than a diff/commit — which is exactly the
  // reachable state here. It proves the panel still renders and drives its preview
  // Server Action end-to-end; the committed-preview vs re-extracted-fallback
  // outcome + its fallback note need a live extractor and are covered at the
  // action tier. The no-change disabled-commit decision is unit-tested
  // (lib/__tests__/reprocess-preview-view.test.ts) since the ok/no-change branch is
  // unreachable without an extractor.
  test("re-extraction is preview-first only — no immediate fire-and-replace (#1071)", async ({
    page,
  }) => {
    await page.goto("/import/908");

    // The consolidated verb: "Preview changes" reads the diff (never writes) —
    // there is no bare "Reprocess" control anymore (the removed unsafe path can't
    // return), and no immediate ExtractedRecords fire-and-replace icon.
    await expect(
      page.getByRole("button", { name: "Reprocess document" })
    ).toHaveCount(0);
    const preview = page.getByTestId("reprocess-preview");
    await expect(preview).toHaveText(/Preview changes/);
    await settledClick(page, preview);

    // Extractor-less env → the panel reports it can't re-extract and offers the
    // "we didn't run it" override, distinct from a committed diff.
    await expect(page.getByTestId("reprocess-anyway")).toHaveText(
      /Re-extract anyway/
    );
  });

  // #1318: the shared RawDataViewer renders the document's raw extraction as a
  // collapsible tree (doc 908's raw is a synthetic CCD → XML mode) with a copy
  // button, replacing the old flat <pre>. Fold/expand + copy are exercised here.
  test("raw extraction renders through the collapsible RawDataViewer (#1318)", async ({
    page,
  }) => {
    await page.goto("/import/908");
    // Open the Debug → Raw extraction disclosure (native <details>).
    await page.getByText("Raw extraction", { exact: true }).click();
    const viewer = page.getByTestId("raw-data-viewer");
    await expect(viewer).toBeVisible();
    // XML mode: the root element + an attribute value render in the tree.
    await expect(viewer).toContainText("ClinicalDocument");

    // Expand-all reveals deep content; collapse-all hides it (the fold machinery).
    await viewer.getByTestId("raw-expand-all").click();
    await expect(viewer).toContainText("Results");
    await viewer.getByTestId("raw-collapse-all").click();
    await expect(viewer).not.toContainText("Results");

    // Copy grabs the full raw text and flashes the transient confirmation.
    await viewer.getByTestId("raw-copy").click();
    await expect(viewer.getByTestId("raw-copied")).toBeVisible();
  });

  // The destructive verb (#1071 item 5) keeps a confirm, and the confirm names
  // exactly what it removes — the document AND its records.
  test("Delete confirms and names its scope (#1071)", async ({ page }) => {
    await page.goto("/import/908");
    // The document-level delete (not a per-record row delete) — scoped by testid.
    await page.getByTestId("delete-document").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Delete document & its records/);
    await expect(dialog).toContainText(/every record it imported/);
  });
});
