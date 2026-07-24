import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Results › Reports (#708): narrative diagnostic report bodies (microbiology culture /
// gram stain / cytopathology) imported from a CCD/XDM land as `report` medical_records
// rows and surface here — text viewable, never in the analyte catalog.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile (profile 1
// owns two `report` rows — a culture Final Report + a Gram Stain Report — via
// scripts/seed.ts). Presence-only assertions; never exact counts of shared-seed rows.
const CULTURE_BODY = /Escherichia coli/;

test("the Reports tab renders a narrative report body (#708)", async ({
  page,
}) => {
  await page.goto("/results/biomarkers");
  const tabs = page.getByTestId("results-tabs");
  await followLink(
    page,
    tabs.getByRole("link", { name: "Reports" }),
    /\/results\/reports$/
  );
  const reports = page.getByTestId("results-reports");
  await expect(
    reports.getByText("Final Report").first() // first-ok: presence of the seeded culture report in the scoped list — order-agnostic
  ).toBeVisible();
  // The body renders through NotesText — the report text is viewable inline.
  await expect(reports.getByText(CULTURE_BODY)).toBeVisible();
});

test("a narrative report never appears in the Biomarkers analyte catalog (#708)", async ({
  page,
}) => {
  // The `report` category is excluded from BIOMARKER_CATEGORIES, so the analyte
  // browser must never list a report body as a row. The culture body text is a
  // report-only marker — its absence here proves the exclusion.
  await page.goto("/results/biomarkers");
  const biomarkers = page.getByTestId("results-biomarkers");
  await expect(biomarkers).toBeVisible();
  await expect(biomarkers.getByText(CULTURE_BODY)).toHaveCount(0);
});
