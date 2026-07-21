import { test, expect } from "@playwright/test";

// #550 / #1086 — Coverage gaps surfaces an uncatalogued biomarker/med/condition as
// a trackable gap and offers the two fill paths (private AI enrichment + a
// de-identified maintainer request). It's a catalog / data-management workflow, so
// #1086 moved it off the Health record page (`/records#coverage`) to its own
// **Coverage** tab on Data (`/data?section=coverage`). The e2e fixture
// (e2e/seed-events.ts) seeds an uncatalogued lab analyte "Serum Fictionase (e2e)"
// on profile 1, so detection lists it as a candidate. AI is not configured in e2e,
// so this drives the always-available paths: opt-in/track, the de-identified
// request link, and untrack.

const GAP = "Serum Fictionase (e2e)";

test("the Coverage tab deep-links via ?section=coverage and is a first-class Data tab (#1086)", async ({
  page,
}) => {
  await page.goto("/data?section=coverage");

  // The Coverage tab is present in the Data tab strip and is the active tab (the
  // server resolved the section from the URL, so the strip highlights it).
  const coverageTab = page.getByRole("tab", { name: "Coverage", exact: true });
  await expect(coverageTab).toBeVisible();
  await expect(coverageTab).toHaveAttribute("aria-selected", "true");

  // The coverage section content renders (its wrapper + the seeded candidate).
  await expect(page.getByTestId("data-coverage")).toBeVisible();
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();
});

test("track an uncatalogued biomarker and get a de-identified catalog request (#550/#1086)", async ({
  page,
}) => {
  await page.goto("/data?section=coverage");

  // The seeded uncatalogued analyte appears as a trackable candidate.
  const candidate = page
    .getByTestId("coverage-candidate")
    .filter({ hasText: GAP });
  await expect(candidate).toBeVisible();

  // Opt in to track it.
  await candidate.getByTestId("track-gap").click();

  // It moves into the tracked list and is no longer offered as a candidate.
  const tracked = page.getByTestId("tracked-gap").filter({ hasText: GAP });
  await expect(tracked).toBeVisible();
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toHaveCount(0);

  // The de-identified maintainer request is available: a prefilled GitHub-issue
  // link carrying ONLY the item's name (no values/dates), which the user reviews
  // and files themselves (never an auto-POST).
  const requestLink = tracked.getByTestId("request-gap-link");
  await expect(requestLink).toBeVisible();
  const href = await requestLink.getAttribute("href");
  expect(href).toContain("github.com/FloorLamp/allos/issues/new");
  expect(href).toContain(encodeURIComponent("Serum Fictionase"));
  expect(href).toContain("labels=catalog-coverage");

  // The "Copy request" affordance is present (the copy-to-clipboard path).
  await expect(tracked.getByTestId("request-gap")).toBeVisible();

  // Untrack restores it to the candidate list (also cleans up the shared-seed
  // mutation this spec makes).
  await tracked.getByTestId("untrack-gap").click();
  await expect(
    page.getByTestId("tracked-gap").filter({ hasText: GAP })
  ).toHaveCount(0);
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();
});

test("/coverage 308-redirects to Data → Coverage (#1086)", async ({ page }) => {
  // The old /coverage index route (once → /records#coverage) now repoints to the
  // Data tab. Request-level assertion — the config redirect fires before auth.
  const res = await page.request.get("/coverage", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toBe("/data?section=coverage");
});
