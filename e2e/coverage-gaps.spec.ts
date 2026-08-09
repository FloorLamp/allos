import { test, expect } from "./fixtures";
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

// #2318 — the surface the issue names. A CCD's non-measurement observations (a
// questionnaire ITEM's answer, a temperature's body site, a vaccine lot number) used
// to land here as things the user is invited to track or ask us to catalogue. They
// are stored and viewable on their document, but they carry no biomarker identity, so
// they must never be offered as a gap. The seed puts one row of each kind on the same
// profile, differing ONLY in category, so this is a real contrast and not an absence
// that would hold even if detection were broken.
const NON_ANALYTE = "Fictional screening item (e2e)";

test("a non-analyte assessment is never offered as an uncatalogued item (#2318)", async ({
  page,
}) => {
  await page.goto("/data?section=coverage");
  await expect(page.getByTestId("data-coverage")).toBeVisible();

  // Detection IS running on this profile: the analyte beside it is offered.
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();

  // The assessment is not — as a candidate, or as something already tracked.
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: NON_ANALYTE })
  ).toHaveCount(0);
  await expect(
    page.getByTestId("tracked-gap").filter({ hasText: NON_ANALYTE })
  ).toHaveCount(0);
});

// #2319 — the catalog side of the same surface. A DEXA scan's per-region
// decomposition is uncatalogued and always will be: there is no population reference
// band for left-arm fat percentage, so curating it would mean inventing ranges. It
// differs from the #2318 control above in exactly the way that matters — this row
// DOES carry biomarker identity (same `scan` category as the curated whole-body
// totals), so nothing upstream withholds it. What keeps it off the offered list is
// the DECLARATION, and the page states the reason rather than hiding the name.
const DEXA_REGIONAL = "Body Fat Percentage, Left Arm";

test("a declared DEXA regional label is stated, not offered as an uncatalogued item (#2319)", async ({
  page,
}) => {
  await page.goto("/data?section=coverage");
  await expect(page.getByTestId("data-coverage")).toBeVisible();

  // Detection IS running: the genuine gap beside it is still offered for tracking.
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();

  // The DEXA region is not offered — as a candidate, or as something tracked.
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: DEXA_REGIONAL })
  ).toHaveCount(0);
  await expect(
    page.getByTestId("tracked-gap").filter({ hasText: DEXA_REGIONAL })
  ).toHaveCount(0);

  // It is STATED instead, with the reason — and with no Track button and no
  // catalog-request link, which would ask for work that must never happen.
  const declined = page
    .getByTestId("coverage-declined")
    .filter({ hasText: DEXA_REGIONAL });
  await expect(declined).toBeVisible();
  await expect(declined).toContainText("per-region decomposition");
  await expect(declined.getByTestId("track-gap")).toHaveCount(0);
  await expect(declined.getByTestId("request-gap-link")).toHaveCount(0);

  // The out-of-scope shape has nothing to point at, so it renders no link. That is
  // the contrast the covered-elsewhere case below is written against.
  await expect(declined.getByTestId("coverage-declined-instead")).toHaveCount(
    0
  );
});

// #2322 — the declaration's OTHER shape. A stress test's resting blood pressure IS
// an ordinary resting blood pressure; the "Stress Test" prefix names the visit, not a
// different measurement. So it is declined as `covered-elsewhere`, and the whole
// point of that shape is the link: the reader is sent to the series that genuinely
// carries the quantity instead of being left to deduce that one exists. The DEXA
// case above cannot exercise it, because out-of-scope has no target by construction.
const STRESS_RESTING_BP = "Stress Test Resting Blood Pressure Systolic";

test("a covered-elsewhere declined analyte links to the series that carries it (#2322)", async ({
  page,
}) => {
  await page.goto("/data?section=coverage");
  await expect(page.getByTestId("data-coverage")).toBeVisible();

  // Detection IS running: the genuine gap beside it is still offered for tracking.
  await expect(
    page.getByTestId("coverage-candidate").filter({ hasText: GAP })
  ).toBeVisible();

  // Curating it would fork the blood-pressure series, so it is never offered.
  await expect(
    page
      .getByTestId("coverage-candidate")
      .filter({ hasText: STRESS_RESTING_BP })
  ).toHaveCount(0);
  await expect(
    page.getByTestId("tracked-gap").filter({ hasText: STRESS_RESTING_BP })
  ).toHaveCount(0);

  const declined = page
    .getByTestId("coverage-declined")
    .filter({ hasText: STRESS_RESTING_BP });
  await expect(declined).toBeVisible();
  await expect(declined).toContainText("names the appointment");
  await expect(declined.getByTestId("track-gap")).toHaveCount(0);
  await expect(declined.getByTestId("request-gap-link")).toHaveCount(0);

  // …and the link resolves to a REAL destination — the systolic metric surface —
  // rather than promising a series that doesn't exist.
  const instead = declined.getByTestId("coverage-declined-instead");
  await expect(instead).toHaveText("See Blood Pressure Systolic");
  await instead.click();
  await expect(page).toHaveURL(/\/trends\/metric\/systolic/);
});
