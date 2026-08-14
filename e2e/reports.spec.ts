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
  await page.goto("/results/clinical-results");
  const tabs = page.getByTestId("results-tabs");
  await followLink(
    page,
    tabs.getByRole("tab", { name: "Reports" }),
    /\/results\/reports$/
  );
  const reports = page.getByTestId("results-reports");
  // The body renders through NotesText in one divided list, not a pile of nested cards.
  const row = reports
    .getByTestId("report-card")
    .filter({ hasText: CULTURE_BODY });
  await expect(reports.getByTestId("reports-list")).not.toHaveClass(/\bcard\b/);
  await expect(row).not.toHaveClass(/\bcard\b/);
  await expect(row.getByTestId("report-body")).toContainText(CULTURE_BODY);
  await expect(
    row.getByRole("heading", { name: "Final Report" })
  ).toBeVisible();
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
  await expect(page.getByTestId("reports-list")).toBeVisible();
  await expect(
    page.getByTestId("results-tabs").getByRole("tab", { name: "Reports" })
  ).toHaveAttribute("aria-selected", "true");
});

test("a narrative report never appears in the Clinical results analyte catalog (#708)", async ({
  page,
}) => {
  // The `report` category is excluded from RESULTS_CATALOG_CATEGORIES, so the analyte
  // browser must never list a report body as a row. The culture body text is a
  // report-only marker — its absence here proves the exclusion.
  await page.goto("/results/clinical-results");
  const results = page.getByTestId("results-clinical-results");
  await expect(results).toBeVisible();
  await expect(results.getByText(CULTURE_BODY)).toHaveCount(0);
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
    await expect(reports.getByText(/No narrative reports yet/)).toBeVisible();
    await expect(
      reports.getByRole("link", { name: /Import records/ })
    ).toHaveAttribute("href", "/data?section=import");
    // Still the Reports route — an empty tab is not a bounce back to Clinical results.
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
