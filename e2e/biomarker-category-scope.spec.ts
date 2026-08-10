import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// #1076: the biomarker surfaces scope to labs, and the physiologic vitals gain a
// Trends → Vitals home. These specs prove (a) the Biomarkers browser lists labs and
// excludes the re-homed classes with a dedicated home (a bio-age composite belongs on
// the Longevity hero, not the general catalog), (b) #2365's per-analyte refinement of
// the vitals half — a vitals analyte with a body-metric chart is gone, one without a
// chart is still there — and (c) the Trends Body vitals block renders its charts.
// (The DB tier pins the lab-only trajectory + flagged-hero scoping.)
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile 1, which
// owns labs (Total Cholesterol, …), a seeded AUDIT-C instrument score, seeded blood
// pressure vitals and seeded audiogram thresholds via scripts/seed.ts. Presence-only
// assertions bounded by the `?q=` filter — never exact counts.

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

test("the browser drops a vitals analyte with a metric home, keeps one without (#2365)", async ({
  page,
}) => {
  const section = page.getByTestId("results-biomarkers");

  // Blood pressure is a BodyMetricSlug quantity charted at /trends/metric/systolic, so
  // the flat catalog no longer duplicates it — the 131-of-145 population #1076's
  // per-category decision dragged along.
  await page.goto(
    "/results/biomarkers?q=" + encodeURIComponent("Blood Pressure Systolic")
  );
  await expect(
    section.getByText("Blood Pressure Systolic", { exact: true })
  ).toHaveCount(0);

  // An audiogram threshold has no chart anywhere, so the catalog is still its home —
  // the "nothing stranded" rule, kept and applied per analyte instead of per category.
  await page.goto(
    "/results/biomarkers?q=" + encodeURIComponent("Hearing Threshold")
  );
  await expect(
    section.getByText("Hearing Threshold", { exact: false }).first() // first-ok: read-only presence check; the seed holds several ear/frequency series
  ).toBeVisible();
});

test("the Trends Body section's vitals block renders the physiologic vitals (#1076/#1486)", async ({
  page,
}) => {
  // Reachable at its anchor — the Vitals tab retired into Body (#1486) and Body
  // itself into the Overview landing surface (#1644), so the census is a section of
  // the default view and its FIRST chart block is the vitals.
  await page.goto("/trends#body");
  const body = page.getByTestId("trends-body");
  await expect(body).toBeVisible();
  // The seeded blood-pressure readings render their chart card.
  await expect(body.getByTestId("vitals-systolic")).toBeVisible();
});
