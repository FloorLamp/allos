import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_REPORTS_EMPTY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Results surface (#1079): the Readings / Imaging / Genomics result stores as
// route-per-tab (`/results/<tab>`), superseding the #1042 stacked-section page. A
// The shared tab-first strip navigates between them; bare `/results` redirects to
// `/results/readings`; the removed index routes now 404 (#1635 dropped the
// compatibility table); the per-biomarker DETAIL route (/results/readings/view) survives.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns labs, imaging studies, and genomic variants via scripts/seed.ts).
// Presence-only assertions — never exact counts of shared-seed rows.

test("bare /results redirects to the Readings tab and renders it (#1079)", async ({
  page,
}) => {
  await page.goto("/results");
  await expect(page).toHaveURL(/\/results\/biomarkers$/);
  await expect(
    page.getByRole("heading", { name: "Results", exact: true })
  ).toBeVisible();
  await expect(page.getByTestId("results-container")).toHaveClass(
    /\bmax-w-6xl\b/
  );
  await expect(page.getByText(/Your result records in one place/)).toHaveCount(
    0
  );
  // The browser renders as the collapsed panel index, whole — the #114 pager it used
  // to carry was retired in #1581, so the tab's proof of life is a group header.
  const biomarkers = page.getByTestId("results-readings");
  await expect(biomarkers.getByTestId("biomarkers-table")).toBeVisible();
  await expect(
    biomarkers.getByTestId("biomarker-panel-header").first() // first-ok: presence-only proof the index rendered — order-agnostic, no count asserted
  ).toBeVisible();
  await expect(biomarkers.getByTestId("biomarkers-pagination")).toHaveCount(0);
  const addBox = await biomarkers
    .getByTestId("add-result-panel-toggle")
    .boundingBox();
  const searchBox = await biomarkers
    .getByLabel("Search records by name or panel")
    .boundingBox();
  expect(addBox).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(Math.abs(addBox!.y - searchBox!.y)).toBeLessThan(3);
});

test("the empty Readings action opens the add-result modal", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_REPORTS_EMPTY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/results/readings");
    await expect(
      page.getByText("No results yet.", { exact: false })
    ).toBeVisible();

    await followLink(
      page,
      page.getByRole("link", { name: /^Add result/ }),
      /\/results\/biomarkers\?new=1(?:#add-result)?$/
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
  await page.goto("/results/readings");

  await expect(page.getByTestId("results-page-title")).toBeHidden();
  const shell = page.getByTestId("shell-chrome");
  const strip = shell.getByTestId("shell-tab-strip");
  const tabs = strip.getByTestId("results-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS("overflow-y", "hidden");
  await expect(tabs.getByRole("tab")).toHaveCount(4);

  const boxes = await Promise.all(
    ["Readings", "Imaging", "Reports", "Genomics"].map(async (name) => {
      const tab = tabs.getByRole("tab", { name });
      await expect(tab).toHaveCSS("font-size", "14px");
      return tab.boundingBox();
    })
  );
  expect(boxes.every(Boolean)).toBe(true);
  expect(boxes[0]!.height).toBeGreaterThanOrEqual(44);
  for (const box of boxes.slice(1)) {
    expect(box!.width).toBeCloseTo(boxes[0]!.width, 0);
  }

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

test("the Readings browser carries the trajectory watch but no fitness-percentile inline (#1164)", async ({
  page,
}) => {
  await page.goto("/results/readings");
  const biomarkers = page.getByTestId("results-readings");
  await expect(biomarkers).toBeVisible();

  // The trajectory watch (#41) moved here from the deleted Trends → Readings tab —
  // the seeded eGFR decline fires it (its own reset/dismiss lifecycle lives in
  // trends-trajectory.spec; here we only prove the area landed on Results).
  await expect(biomarkers.getByTestId("trajectory-findings")).toBeVisible();

  // The fitness-percentile inline was DROPPED, not ported (#1164): the biomarker table
  // is for labs, and the peer-percentile context for fitness-test vitals lives on the
  // Fitness surface. Pin it absent so the dropped inline can't sneak back.
  await expect(page.getByTestId("fitness-percentile-inline")).toHaveCount(0);
});

test("the tab strip navigates route-per-tab to Imaging and Genomics (#1079)", async ({
  page,
}) => {
  await page.goto("/results/readings");
  const tabs = page.getByTestId("results-tabs");
  await expect(tabs.getByRole("tab", { name: "Readings" })).toBeVisible();

  // Imaging tab → its own route + the seeded knee MRI in the study list.
  await followLink(
    page,
    tabs.getByRole("tab", { name: "Imaging" }),
    /\/results\/imaging$/
  );
  const imaging = page.getByTestId("results-imaging");
  await expect(imaging).toHaveClass(/\bmax-w-4xl\b/);
  await expect(imaging.getByText(/Your radiology studies/)).toHaveCount(0);
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
  await expect(
    page.getByTestId("results-genomics").getByText(/Structured genetic results/)
  ).toHaveCount(0);
});

test("the per-biomarker detail route survives at /results/readings/view (#1079)", async ({
  page,
}) => {
  // Only the INDEX pages folded — the detail/series page keeps its route, and its
  // back-link points at the Readings tab.
  await page.goto(
    "/results/readings/view?name=" + encodeURIComponent("Glucose")
  );
  await expect(
    page.getByRole("heading", { name: "Glucose", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Back to readings/ })
  ).toHaveAttribute("href", "/results/readings");
});

test("the Medical nav group shows one Results leaf in place of the three old ones (#1079)", async ({
  page,
}) => {
  await page.goto("/results/readings");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Results" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Imaging" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Genomics" })).toHaveCount(0);
});
