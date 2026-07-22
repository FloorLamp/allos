import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// #1076: the biomarker surfaces scope to labs, and the physiologic vitals gain a
// Trends → Vitals home. These specs prove (a) the Biomarkers browser lists labs and
// excludes the re-homed classes with a dedicated home (a bio-age composite belongs on
// the Longevity hero, not the general catalog), and (b) the new Vitals section renders
// its charts. (Domain vitals such as audiogram thresholds stay catalogued on the flat
// browser — they have no dedicated chart surface — so the browser is not asserted
// "labs only" here; the DB tier pins the lab-only trajectory + flagged-hero scoping.)
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile 1, which
// owns labs (Total Cholesterol, …) and a seeded AUDIT-C instrument score via
// scripts/seed.ts. Presence-only assertions bounded by the `?q=` filter — never exact
// counts.

test("the Biomarkers browser lists labs but not a re-homed instrument score (#1076)", async ({
  page,
}) => {
  // A lab is present.
  await page.goto("/results/biomarkers?q=Cholesterol");
  const section = page.getByTestId("results-biomarkers");
  const cholesterol = section.getByText("Total Cholesterol").first(); // first-ok: read-only presence check; shared seed may hold several Total Cholesterol readings
  await expect(cholesterol).toBeVisible();

  // A screening instrument (the seeded AUDIT-C substance-use score) is NOT browsable
  // here — the SENSITIVITY case: a substance/depression score belongs on its own
  // surface, never the general biomarker catalog.
  await page.goto("/results/biomarkers?q=" + encodeURIComponent("AUDIT-C"));
  await expect(
    page.getByTestId("results-biomarkers").getByText("AUDIT-C", { exact: true })
  ).toHaveCount(0);
});

test("the Trends Vitals section renders the physiologic vitals (#1076)", async ({
  page,
}) => {
  // Reachable via the tab strip.
  await page.goto("/trends?tab=body");
  await followLink(
    page,
    page.getByRole("tab", { name: "Vitals" }),
    /tab=vitals/
  );
  const vitals = page.getByTestId("trends-vitals");
  await expect(vitals).toBeVisible();
  await expect(page.getByRole("tab", { name: "Vitals" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // The seeded blood-pressure readings render their chart card.
  await expect(vitals.getByTestId("vitals-blood-pressure")).toBeVisible();
});
