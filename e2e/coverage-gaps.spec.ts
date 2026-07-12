import { test, expect } from "@playwright/test";

// #550 — the Coverage gaps page surfaces an uncatalogued biomarker/med/condition as
// a trackable gap and offers the two fill paths (private AI enrichment + a
// de-identified maintainer request). The e2e fixture (e2e/seed-events.ts) seeds an
// uncatalogued lab analyte "Serum Fictionase (e2e)" on profile 1, so detection lists
// it as a candidate. AI is not configured in e2e, so this drives the always-available
// paths: opt-in/track, the de-identified request link, and untrack.

const GAP = "Serum Fictionase (e2e)";

test("track an uncatalogued biomarker and get a de-identified catalog request (#550)", async ({
  page,
}) => {
  await page.goto("/coverage");

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

  // Untrack restores it to the candidate list.
  await tracked.getByTestId("untrack-gap").click();
  await expect(
    page.getByTestId("tracked-gap").filter({ hasText: GAP })
  ).toHaveCount(0);
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();
});
