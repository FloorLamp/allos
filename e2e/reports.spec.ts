import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_REPORTS_EMPTY,
  E2E_LOGIN_REPORTS_SOURCE,
  REPORTS_SOURCE_NAME,
  REPORTS_SOURCE_PROVIDER,
} from "./fixture-logins";

// Results › Reports (#708): narrative diagnostic report bodies (microbiology culture /
// gram stain / cytopathology) imported from a CCD/XDM land as `report` medical_records
// rows and surface here — text viewable, never in the analyte catalog.
//
// Fixture hygiene (#868): the shared-seed tests are read-only against the seeded admin
// profile (profile 1 owns two `report` rows — a culture Final Report + a Gram Stain
// Report — via scripts/seed.ts). Presence-only assertions; never exact counts of
// shared-seed rows. The pane's two OTHER shapes cannot be reached from that profile at
// all — it always has reports, and its rows carry neither a performing provider nor a
// source document — so each gets a dedicated, read-only fixture login (#1598).
const CULTURE_BODY = /Escherichia coli/;

test("the Reports tab renders a narrative report body (#708)", async ({
  page,
}) => {
  await page.goto("/results/readings");
  const tabs = page.getByTestId("results-tabs");
  await followLink(
    page,
    tabs.getByRole("tab", { name: "Reports" }),
    /\/results\/reports$/
  );
  const reports = page.getByTestId("results-reports");
  await expect(
    reports.getByText("Final Report").first() // first-ok: presence of the seeded culture report in the scoped list — order-agnostic
  ).toBeVisible();
  // The body renders through NotesText — the report text is viewable inline.
  await expect(reports.getByText(CULTURE_BODY)).toBeVisible();

  // …as a structured row in one divided list, not a pile of nested cards. The
  // seeded rows are unattributed, so neither optional line rides along.
  const row = reports
    .getByTestId("report-card")
    .filter({ hasText: CULTURE_BODY });
  await expect(reports.getByTestId("reports-list")).not.toHaveClass(/\bcard\b/);
  await expect(row).not.toHaveClass(/\bcard\b/);
  await expect(row.getByTestId("report-body")).toContainText(CULTURE_BODY);
  await expect(
    row.getByRole("heading", { name: "Final Report" })
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: /View source document/ })
  ).toHaveCount(0);
});

test("the Reports pane renders on a direct deep link, with its tab selected (#1598)", async ({
  page,
}) => {
  // Reaching the pane by URL is the other half of "it renders": Reports is its own
  // route, and a bookmark or an out-of-app link lands on it with no tab click.
  await page.goto("/results/reports");
  const reports = page.getByTestId("results-reports");
  await expect(reports).toBeVisible();
  await expect(reports).toHaveClass(/\bmax-w-3xl\b/);
  await expect(reports.getByText(/Narrative diagnostic reports/)).toHaveCount(
    0
  );
  await expect(page.getByTestId("reports-list")).toBeVisible();
  await expect(
    page.getByTestId("results-tabs").getByRole("tab", { name: "Reports" })
  ).toHaveAttribute("aria-selected", "true");
});

test("a narrative report never appears in the Biomarkers analyte catalog (#708)", async ({
  page,
}) => {
  // The `report` category is excluded from RESULTS_CATALOG_CATEGORIES, so the analyte
  // browser must never list a report body as a row. The culture body text is a
  // report-only marker — its absence here proves the exclusion.
  await page.goto("/results/readings");
  const biomarkers = page.getByTestId("results-readings");
  await expect(biomarkers).toBeVisible();
  await expect(biomarkers.getByText(CULTURE_BODY)).toHaveCount(0);
});

test("a profile with no narrative reports gets the pane's empty state (#1598)", async ({
  browser,
}) => {
  // Unreachable on profile 1, which always owns reports. Read-only on a dedicated
  // report-less profile, so it stays repeat-safe with no reset.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_REPORTS_EMPTY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/results/reports");
    const reports = page.getByTestId("results-reports");
    await expect(reports).toBeVisible();
    await expect(reports.getByText(/No narrative reports yet/)).toBeVisible();
    await expect(
      reports.getByRole("link", { name: /Import records/ })
    ).toHaveAttribute("href", "/data?section=import");
    // The empty state REPLACES the list — an empty card list would look the same from
    // the outside, and the nudge (import a CCD/XDM record) is what makes the pane
    // usable at all for someone who has never imported one.
    await expect(page.getByTestId("reports-list")).toHaveCount(0);
    await expect(page.getByTestId("report-card")).toHaveCount(0);
    // Still the Reports route — an empty tab is not a bounce back to Biomarkers.
    await expect(page).toHaveURL(/\/results\/reports$/);
  } finally {
    await page.context().close();
  }
});

test("an attributed report shows its performing lab and links to its source document (#1598)", async ({
  browser,
}) => {
  // The card's two optional lines, both conditional on import provenance the shared
  // seed's rows don't carry — so this needs its own fixture: one narrative report with
  // a performing lab AND the imported CCD it was recovered from.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_REPORTS_SOURCE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/results/reports");
    const card = page
      .getByTestId("report-card")
      .filter({ hasText: REPORTS_SOURCE_NAME });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("report-body")).toContainText(
      /Negative for intraepithelial lesion/
    );
    // The performing lab, resolved from providers.
    await expect(card.getByText(REPORTS_SOURCE_PROVIDER)).toBeVisible();
    // …and the way back to what it was imported from.
    await expect(
      card.getByRole("link", { name: /View source document/ })
    ).toHaveAttribute("href", /^\/import\/\d+$/);
  } finally {
    await page.context().close();
  }
});
