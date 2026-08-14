import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_REPORTS_EMPTY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Results surface (#1079): Clinical results / Imaging / Reports / Genomics as
// route-per-tab (`/results/<tab>`), superseding the #1042 stacked-section page. The
// shared tab-first strip navigates between them; bare `/results` redirects to the
// mixed Clinical results catalog, and analyte detail lives beneath that route.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns labs, imaging studies, and genomic variants via scripts/seed.ts).
// Presence-only assertions — never exact counts of shared-seed rows.

test("bare /results redirects to Clinical results and renders it (#1079)", async ({
  page,
}) => {
  await page.goto("/results");
  await expect(page).toHaveURL(/\/results\/clinical-results$/);
  await expect(
    page.getByRole("heading", { name: "Results", exact: true })
  ).toBeVisible();
  // The browser renders as the collapsed panel index, whole — the #114 pager it used
  // to carry was retired in #1581, so the tab's proof of life is a group header.
  const catalog = page.getByTestId("results-clinical-results");
  await expect(
    catalog.getByTestId("clinical-result-panel-header").first() // first-ok: presence-only proof the index rendered — order-agnostic, no count asserted
  ).toBeVisible();
});

test("the empty Clinical results action opens the add-result modal", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_REPORTS_EMPTY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/results/clinical-results");
    await expect(
      page.getByText("No results yet.", { exact: false })
    ).toBeVisible();

    await followLink(
      page,
      page.getByRole("link", { name: /^Add result/ }),
      /\/results\/clinical-results\?new=1(?:#add-result)?$/
    );

    await expect(page.getByTestId("add-result-panel")).toHaveAttribute(
      "data-open",
      "true"
    );
    await expect(
      page.getByRole("dialog", { name: "Add result" })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("mobile Results starts with four shell-owned route tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/results/clinical-results");

  await expect(page.getByTestId("results-page-title")).toBeHidden();
  const shell = page.getByTestId("shell-chrome");
  const strip = shell.getByTestId("shell-tab-strip");
  const tabs = strip.getByTestId("results-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(4);

  await followLink(
    page,
    tabs.getByRole("tab", { name: "Imaging" }),
    /\/results\/imaging$/
  );
  await expect(
    page.getByTestId("shell-tab-strip").getByRole("tab", { name: "Imaging" })
  ).toHaveAttribute("aria-selected", "true");
  const imaging = page.getByTestId("imaging-study-list");
  const knee = imaging.getByRole("row").filter({ hasText: "Left Knee" });
  await expect(knee).toContainText("MRI Left Knee");
  await expect(knee).not.toContainText("MRI Left Left Knee");
  await expect(knee.getByLabel("Follow-up interval")).toBeVisible();
  await expect(
    knee.getByRole("button", { name: "Track follow-up" })
  ).toBeVisible();

  await followLink(
    page,
    page.getByTestId("shell-tab-strip").getByRole("tab", { name: "Genomics" }),
    /\/results\/genomics$/
  );
  const brca = page
    .getByTestId("genomic-variant-list")
    .getByRole("row")
    .filter({ hasText: "BRCA1" });
  await expect(
    brca.getByRole("cell").filter({ hasText: "Significance" })
  ).toContainText("Pathogenic");
  await expect(
    brca.getByRole("cell").filter({ hasText: "Type" })
  ).toContainText("Hereditary risk");
});

test("the Clinical results catalog carries the trajectory watch (#1164)", async ({
  page,
}) => {
  await page.goto("/results/clinical-results");
  const catalog = page.getByTestId("results-clinical-results");

  // The trajectory watch (#41) moved here from the deleted Trends tab —
  // the seeded eGFR decline fires it (its own reset/dismiss lifecycle lives in
  // trends-trajectory.spec; here we only prove the area landed on Results).
  await expect(catalog.getByTestId("trajectory-findings")).toBeVisible();
});

test("the tab strip navigates route-per-tab to Imaging and Genomics (#1079)", async ({
  page,
}) => {
  await page.goto("/results/clinical-results");
  const tabs = page.getByTestId("results-tabs");
  await expect(
    tabs.getByRole("tab", { name: "Clinical results" })
  ).toBeVisible();

  // Imaging tab → its own route + the seeded knee MRI in the study list.
  await followLink(
    page,
    tabs.getByRole("tab", { name: "Imaging" }),
    /\/results\/imaging$/
  );
  const imaging = page.getByTestId("results-imaging");
  await expect(imaging).toHaveClass(/\bmax-w-4xl\b/);
  await expect(
    imaging
      .getByTestId("imaging-study-list")
      .getByText(/Left Knee/)
      .first() // first-ok: asserts the seeded Left Knee imaging study renders in the scoped list — order-agnostic
  ).toBeVisible();

  // Genomics tab → its own route + the seeded pharmacogenomic variant.
  await followLink(
    page,
    page.getByTestId("results-tabs").getByRole("tab", { name: "Genomics" }),
    /\/results\/genomics$/
  );
  await expect(
    page
      .getByTestId("results-genomics")
      .getByTestId("genomic-variant-list")
      .getByText("CYP2C19")
      .first() // first-ok: asserts the seeded CYP2C19 variant renders in the scoped list — order-agnostic
  ).toBeVisible();
  await expect(page.getByTestId("results-genomics")).toHaveClass(
    /\bmax-w-4xl\b/
  );
});

test("the analyte detail route lives under Clinical results (#1079)", async ({
  page,
}) => {
  await page.goto(
    "/results/clinical-results/view?name=" + encodeURIComponent("Glucose")
  );
  await expect(
    page.getByRole("heading", { name: "Glucose", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Back to clinical results/ })
  ).toHaveAttribute("href", "/results/clinical-results");
});

test("the Medical nav group links to Results (#1079)", async ({ page }) => {
  await page.goto("/results/clinical-results");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Results" })).toBeVisible();
});
