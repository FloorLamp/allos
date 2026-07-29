import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// The Results surface (#1079): the Biomarkers / Imaging / Genomics result stores as
// route-per-tab (`/results/<tab>`), superseding the #1042 stacked-section page. A
// The shared tab-first strip navigates between them; bare `/results` redirects to
// `/results/biomarkers`; the removed index routes 308-redirect to the tab routes
// (query preserved); the per-biomarker DETAIL route (/biomarkers/view) survives.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns labs, imaging studies, and genomic variants via scripts/seed.ts).
// Presence-only assertions — never exact counts of shared-seed rows.

test("bare /results redirects to the Biomarkers tab and renders it (#1079)", async ({
  page,
}) => {
  await page.goto("/results");
  await expect(page).toHaveURL(/\/results\/biomarkers$/);
  await expect(
    page.getByRole("heading", { name: "Results", exact: true })
  ).toBeVisible();
  // The browser renders as the collapsed panel index, whole — the #114 pager it used
  // to carry was retired in #1581, so the tab's proof of life is a group header.
  const biomarkers = page.getByTestId("results-biomarkers");
  await expect(biomarkers.getByTestId("biomarkers-table")).toBeVisible();
  await expect(
    biomarkers.getByTestId("biomarker-panel-header").first() // first-ok: presence-only proof the index rendered — order-agnostic, no count asserted
  ).toBeVisible();
  await expect(biomarkers.getByTestId("biomarkers-pagination")).toHaveCount(0);
});

test("mobile Results starts with four shell-owned route tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/results/biomarkers");

  await expect(page.getByTestId("results-page-title")).toBeHidden();
  const shell = page.getByTestId("shell-chrome");
  const strip = shell.getByTestId("shell-tab-strip");
  const tabs = strip.getByTestId("results-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS("overflow-y", "hidden");
  await expect(tabs.getByRole("tab")).toHaveCount(4);

  const boxes = await Promise.all(
    ["Biomarkers", "Imaging", "Reports", "Genomics"].map(async (name) => {
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
});

test("the Biomarkers browser carries the trajectory watch but no fitness-percentile inline (#1164)", async ({
  page,
}) => {
  await page.goto("/results/biomarkers");
  const biomarkers = page.getByTestId("results-biomarkers");
  await expect(biomarkers).toBeVisible();

  // The trajectory watch (#41) moved here from the deleted Trends → Biomarkers tab —
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
  await page.goto("/results/biomarkers");
  const tabs = page.getByTestId("results-tabs");
  await expect(tabs.getByRole("tab", { name: "Biomarkers" })).toBeVisible();

  // Imaging tab → its own route + the seeded knee MRI in the study list.
  await followLink(
    page,
    tabs.getByRole("tab", { name: "Imaging" }),
    /\/results\/imaging$/
  );
  const imaging = page.getByTestId("results-imaging");
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
});

test("the removed index routes 308-redirect to their tab routes (#1079)", async ({
  page,
}) => {
  // Request-level assertion — each removed index route answers a 308 whose Location
  // IS the tab route (Next's config-level redirect fires before auth; page.request
  // shares the session cookies anyway).
  const redirects = [
    { from: "/biomarkers", to: "/results/biomarkers" },
    { from: "/imaging", to: "/results/imaging" },
    { from: "/genomics", to: "/results/genomics" },
  ];
  for (const r of redirects) {
    const res = await page.request.get(r.from, { maxRedirects: 0 });
    expect(res.status(), r.from).toBe(308);
    expect(res.headers()["location"], r.from).toBe(r.to);
  }

  // Query strings ride through the redirect — old biomarker deep links keep their
  // ?q= filter on the way to the Biomarkers tab.
  const withQuery = await page.request.get("/biomarkers?q=non-hdl", {
    maxRedirects: 0,
  });
  expect(withQuery.status()).toBe(308);
  expect(withQuery.headers()["location"]).toBe("/results/biomarkers?q=non-hdl");
});

test("the per-biomarker detail route survives at /biomarkers/view (#1079)", async ({
  page,
}) => {
  // Only the INDEX pages folded — the detail/series page keeps its route, and its
  // back-link points at the Biomarkers tab.
  await page.goto("/biomarkers/view?name=" + encodeURIComponent("Glucose"));
  await expect(
    page.getByRole("heading", { name: "Glucose", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Back to biomarkers/ })
  ).toHaveAttribute("href", "/results/biomarkers");
});

test("the Medical nav group shows one Results leaf in place of the three old ones (#1079)", async ({
  page,
}) => {
  await page.goto("/results/biomarkers");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Results" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Imaging" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Genomics" })).toHaveCount(0);
});
