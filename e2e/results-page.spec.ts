import { test, expect } from "@playwright/test";

// The merged Results page (#1042 phase 5): the Biomarkers / Imaging / Genomics
// index pages fold into ONE stacked-section page at real anchors
// (/results#biomarkers, #imaging, #genomics), the removed index routes
// 308-redirect there (query strings preserved), and the per-biomarker DETAIL
// route (/biomarkers/view) survives at its own URL. Section visibility mirrors
// the nav's predicate: none of the three constituent leaves carried a nav gate,
// so all three sections always render (each with its own empty state) — there is
// deliberately NO hidden-section case to assert.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns labs, imaging studies, and genomic variants via scripts/
// seed.ts). Presence-only assertions — never exact counts of shared-seed rows.

test("renders all three anchored sections with the seeded data (#1042)", async ({
  page,
}) => {
  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "Results", exact: true })
  ).toBeVisible();

  // The anchor jump row links each section.
  const jump = page.getByTestId("results-jump-links");
  await expect(jump.getByRole("link", { name: "Biomarkers" })).toBeVisible();
  await expect(jump.getByRole("link", { name: "Imaging" })).toBeVisible();
  await expect(jump.getByRole("link", { name: "Genomics" })).toBeVisible();

  // Biomarkers: the analyte browser rendered with seeded rows — the bounded
  // table always shows its pagination footer (#114).
  const biomarkers = page.getByTestId("results-biomarkers");
  await expect(
    biomarkers.getByRole("heading", { name: "Biomarkers" })
  ).toBeVisible();
  await expect(biomarkers.getByTestId("biomarkers-pagination")).toContainText(
    "Showing"
  );

  // Imaging: the seeded MRI study renders in the study list.
  const imaging = page.getByTestId("results-imaging");
  await expect(
    imaging.getByRole("heading", { name: "Imaging", exact: true })
  ).toBeVisible();
  await expect(
    imaging.getByTestId("imaging-study-list").getByText("MRI Left Knee").first()
  ).toBeVisible();

  // Genomics: the seeded pharmacogenomic variant renders in the variant list.
  const genomics = page.getByTestId("results-genomics");
  await expect(
    genomics.getByRole("heading", { name: "Genomic variants" })
  ).toBeVisible();
  await expect(
    genomics.getByTestId("genomic-variant-list").getByText("CYP2C19").first()
  ).toBeVisible();
});

test("the removed index routes 308-redirect to their anchored sections (#1042)", async ({
  page,
}) => {
  await page.goto("/biomarkers");
  await expect(page).toHaveURL(/\/results#biomarkers$/);
  await expect(page.getByTestId("results-biomarkers")).toBeVisible();

  await page.goto("/imaging");
  await expect(page).toHaveURL(/\/results#imaging$/);
  // The anchor scrolled the imaging section into the viewport (the biomarkers
  // browser above it fills well more than one screen for the seeded profile).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("imaging");
        if (!el) return Number.POSITIVE_INFINITY;
        return el.getBoundingClientRect().top;
      })
    )
    .toBeLessThan(200);

  await page.goto("/genomics");
  await expect(page).toHaveURL(/\/results#genomics$/);
  await expect(page.getByTestId("results-genomics")).toBeVisible();

  // Query strings ride through the redirect — the biomarkers section's filters
  // keep working from old deep links (?q= narrows to the matching analyte).
  await page.goto("/biomarkers?q=non-hdl");
  await expect(page).toHaveURL(/\/results\?q=non-hdl#biomarkers$/);
  await expect(
    page.getByTestId("results-biomarkers").getByTestId("derived-badge").first()
  ).toBeVisible();
});

test("the per-biomarker detail route survives at /biomarkers/view (#1042)", async ({
  page,
}) => {
  // Only the INDEX pages folded — the detail/series page keeps its route, and
  // its back-link points at the merged section.
  await page.goto("/biomarkers/view?name=" + encodeURIComponent("Glucose"));
  await expect(
    page.getByRole("heading", { name: "Glucose", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Back to biomarkers/ })
  ).toHaveAttribute("href", "/results#biomarkers");
});

test("the Medical nav group shows one Results leaf in place of the three old ones (#1042)", async ({
  page,
}) => {
  // Being on /results (a Medical child) force-expands the group — the children
  // are asserted with zero interaction flake (the nav-consolidation pattern).
  await page.goto("/results");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Results" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Biomarkers" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Imaging" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Genomics" })).toHaveCount(0);
});
