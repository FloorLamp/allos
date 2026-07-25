import { test, expect } from "@playwright/test";

// #1447 — /biomarkers/view with no `?name=` was the weakest empty state in the
// all-pages census: a generic "Biomarker" h1, no subtitle, a bare no-CTA "No
// biomarker selected." line, and an otherwise blank canvas.
//
// Nothing in the app links there: `biomarkerViewHref` (lib/hrefs.ts) already
// returns the biomarkers LIST when it has no canonical name, so the paramless
// route is only reachable by a hand-typed URL or a stale bookmark. It now
// redirects to the same list that helper falls back to — one constant
// (BIOMARKERS_LIST_HREF) owns both, so the link rule and the redirect cannot
// drift apart.
test("a paramless /biomarkers/view redirects to the biomarkers list", async ({
  page,
}) => {
  await page.goto("/biomarkers/view");

  await page.waitForURL((u) => u.pathname === "/results/biomarkers", {
    timeout: 20_000,
  });
  // The degenerate page is gone, not merely re-skinned.
  await expect(page.getByText("No biomarker selected")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Biomarker", exact: true })
  ).toHaveCount(0);
});

// The named-but-empty case is NOT a redirect: the name is a real request the page
// can answer ("you have no readings for this marker"), so it keeps a titled empty
// state — now with a way onward, which the census flagged as missing.
test("an unknown ?name= keeps a titled empty state with a way back to the list", async ({
  page,
}) => {
  const name = "Nonexistent Marker (e2e)";
  await page.goto(`/biomarkers/view?name=${encodeURIComponent(name)}`);

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(`No readings found for “${name}”`)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Browse biomarkers/ })
  ).toBeVisible();
});
