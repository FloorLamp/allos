import { test, expect } from "./fixtures";
// #1447 — /results/clinical-results/view with no `?name=` used to be a blank detail state.
//
// Nothing in the app links there: `clinicalResultDetailHref` (lib/hrefs.ts) already
// returns the Clinical results LIST when it has no canonical name, so the paramless
// route is only reachable by a hand-typed URL or a stale bookmark. It now
// redirects to the same list that helper falls back to — one constant
// (CLINICAL_RESULTS_LIST_HREF) owns both, so the link rule and the redirect cannot
// drift apart.
test("a paramless /results/clinical-results/view redirects to the Clinical results list", async ({
  page,
}) => {
  await page.goto("/results/clinical-results/view");

  await page.waitForURL((u) => u.pathname === "/results/clinical-results", {
    timeout: 20_000,
  });
});

// The named-but-empty case is NOT a redirect: the name is a real request the page
// can answer ("you have no clinical results for this marker"), so it keeps a titled empty
// state — now with a way onward, which the census flagged as missing.
test("an unknown ?name= keeps a titled empty state with a way back to the list", async ({
  page,
}) => {
  const name = "Nonexistent Marker (e2e)";
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(name)}`
  );

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(
    page.getByText(`No clinical results found for “${name}”`)
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Browse clinical results/ })
  ).toBeVisible();
});
