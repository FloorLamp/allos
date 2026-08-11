import { test, expect } from "./fixtures";
// #1447 — /results/readings/view with no `?name=` used to be a blank detail state.
//
// Nothing in the app links there: `readingDetailHref` (lib/hrefs.ts) already
// returns the biomarkers LIST when it has no canonical name, so the paramless
// route is only reachable by a hand-typed URL or a stale bookmark. It now
// redirects to the same list that helper falls back to — one constant
// (READINGS_LIST_HREF) owns both, so the link rule and the redirect cannot
// drift apart.
test("a paramless /results/readings/view redirects to the readings list", async ({
  page,
}) => {
  await page.goto("/results/readings/view");

  await page.waitForURL((u) => u.pathname === "/results/readings", {
    timeout: 20_000,
  });
  // The degenerate page is gone, not merely re-skinned.
  await expect(page.getByText("No biomarker selected")).toHaveCount(0);
});

test("the retired biomarker routes preserve list and detail query parameters", async ({
  page,
}) => {
  await page.goto("/results/biomarkers?q=vitamin+d&current=1");
  await page.waitForURL(
    (url) =>
      url.pathname === "/results/readings" &&
      url.searchParams.get("q") === "vitamin d" &&
      url.searchParams.get("current") === "1"
  );

  const name = "Legacy route marker (e2e)";
  await page.goto(`/biomarkers/view?name=${encodeURIComponent(name)}`);
  await page.waitForURL(
    (url) =>
      url.pathname === "/results/readings/view" &&
      url.searchParams.get("name") === name
  );
  await expect(page.getByRole("heading", { name })).toBeVisible();
});

// The named-but-empty case is NOT a redirect: the name is a real request the page
// can answer ("you have no readings for this marker"), so it keeps a titled empty
// state — now with a way onward, which the census flagged as missing.
test("an unknown ?name= keeps a titled empty state with a way back to the list", async ({
  page,
}) => {
  const name = "Nonexistent Marker (e2e)";
  await page.goto(`/results/readings/view?name=${encodeURIComponent(name)}`);

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(`No readings found for “${name}”`)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Browse readings/ })
  ).toBeVisible();
});
