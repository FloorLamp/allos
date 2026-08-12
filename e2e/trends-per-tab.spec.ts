import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";

// Issue #105: the Trends hub must render ONLY the active tab's section
// server-side (previously all six sections rendered — and ran their queries —
// on every request). Tabs still switch via a URL navigation, so each view is a
// fresh, single-tab server render. These specs prove (a) direct navigation
// renders the requested tab's content and NOT the other tabs' content (the
// server-side gating), and (b) clicking a tab switches which section is
// rendered.
//
// #1644 folded the body census into Overview and left FOUR tabs — Overview ·
// Fitness · Nutrition · Insights, permanent by owner ruling. The #105 contract is
// unchanged and is what keeps that merge honest: the landing surface must not drag
// the other domains' queries along with it. e2e/trends-landing.spec.ts owns the
// merged surface's own composition.

// Markers that are data-independent (always rendered by their section's chrome):
//   Insights → the "Date to analyze" generate form
//   Fitness  → its four windowed sections (#1492 replaced the nested
//              Strength/Cardio/Sport strip and its "Full Training →" link with
//              sections, so the marker is the section container's testid)
// (Biomarkers left the Trends hub in #1164 — merged into Results.)
const INSIGHTS_MARKER = "Date to analyze";
const FITNESS_MARKER = "trends-fitness";

test("direct navigation renders only the requested tab's section (#105)", async ({
  page,
}) => {
  // Overview (default): neither the Insights form nor the Fitness sections render —
  // even though this tab now also carries the body census (#1644).
  await page.goto("/trends");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
  await expect(page.getByTestId(FITNESS_MARKER)).toHaveCount(0);
  await expect(page.getByTestId("trajectory-findings")).toHaveCount(0);

  // The Overview tiles render (fed by the deduped one-source-per-day series and the
  // robust-endpoint change badge — #395/#398). Since #1487 the grid is the profile's
  // SAVED set: the seed's standard metric saves are why the "Weight" tile is here,
  // and its full header links to the metric detail page.
  await expect(page.getByTestId("trend-mini-card").first()).toBeVisible(); // first-ok: asserts a trend mini-card renders on the tab at all — order-agnostic presence
  const weightTile = page.locator(
    '[data-testid="saved-tile"][data-tile-key="metric:weight"]'
  );
  await expect(weightTile).toBeVisible();
  await expect(
    weightTile.getByTestId("trend-mini-header-link")
  ).toHaveAttribute("href", "/trends/metric/weight");

  // Insights: its generate form renders; the Fitness link does not.
  await page.goto("/trends?tab=insights");
  await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();
  await expect(page.getByTestId(FITNESS_MARKER)).toHaveCount(0);

  // Fitness: its four windowed sections render; the Insights form does not. There
  // is NO nested tab strip any more (#1492) — the section navigation is in-page
  // anchors, so no "Strength" tab exists to select.
  await page.goto("/trends?tab=fitness");
  await expect(page.getByRole("tab", { name: "Fitness" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByTestId(FITNESS_MARKER)).toBeVisible();
  await expect(page.getByTestId("fitness-volume")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Strength", exact: true })
  ).toHaveCount(0);
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});

test("the Trends tab strip lists neither Biomarkers nor Body, and a stale ?tab= falls back to the default tab (#1164/#1644)", async ({
  page,
}) => {
  await page.goto("/trends");
  // Biomarkers is gone from the strip (merged into Results, #1164) and Body with it
  // (merged into Overview, #1644); the surviving tabs stay.
  await expect(page.getByRole("tab", { name: "Biomarkers" })).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Body", exact: true })
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Nutrition" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();

  // A stale external bookmark to a removed tab falls through the hub's unknown-?tab=
  // fallback to the default (Overview) — no redirect, no 404, no shim (#1635). That
  // covers #1164's biomarkers and, since #1644, body/vitals — whose census the
  // default view happens to render, which is why they need no mapping of their own.
  for (const stale of ["biomarkers", "body", "vitals"]) {
    await page.goto(`/trends?tab=${stale}`);
    await expect(page).toHaveURL(new RegExp(`\\/trends\\?tab=${stale}$`));
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // A live page, not an error: the hub heading renders and no biomarker section
    // shows.
    await expect(
      page.getByRole("heading", { name: "Trends", exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("trajectory-findings")).toHaveCount(0);
  }
  // …and the body census the retired names wanted is right there on that default
  // view, which is what makes dropping their aliases honest rather than lossy.
  await expect(page.getByTestId("trends-section-body")).toBeVisible();
});

test("clicking a tab switches which section is rendered (#105)", async ({
  page,
}) => {
  await page.goto("/trends");
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);

  // Each tab is a real server-rendered anchor pointing at its ?tab= URL (#830) —
  // this is what makes a pre-hydration click navigate natively instead of being
  // swallowed. Assert the element is an <a> with the right href.
  const insightsTab = page.getByRole("tab", { name: "Insights" });
  await expect(insightsTab).toHaveJSProperty("tagName", "A");
  await expect(insightsTab).toHaveAttribute("href", /tab=insights/);

  // Click Insights → its form appears and the URL reflects the tab. Each tab is a
  // real NavTabs Next <Link>; a click landing in the pre-hydration window can
  // still have its router.push dropped (#830/#889), so followLink retries the tab
  // click until the URL commits — the whole nav-anchor class goes through it.
  await followLink(
    page,
    page.getByRole("tab", { name: "Insights" }),
    /tab=insights/
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();
  await expect(page.getByTestId(FITNESS_MARKER)).toHaveCount(0);

  // Click Fitness → its content replaces the Insights form.
  await followLink(
    page,
    page.getByRole("tab", { name: "Fitness" }),
    /tab=fitness/
  );
  await expect(page.getByTestId(FITNESS_MARKER)).toBeVisible();
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});

test("a retired ?ftab= deep link lands on the Fitness tab, param ignored (#1492)", async ({
  page,
}) => {
  // The nested Fitness strip (Strength|Cardio|Sport) retired with #1492 — the tab
  // is four windowed SECTIONS now. Its param is a retired VOCABULARY, not a
  // redirect: an old deep link (the coaching engine shipped `?ftab=cardio` for
  // months) names the Fitness tab and the value is then ignored, because the zone
  // content it wanted is simply a section of the page it lands on.
  await page.goto("/trends?tab=fitness&ftab=cardio");
  await expect(page.getByRole("tab", { name: "Fitness" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByTestId("fitness-zones")).toBeVisible();
  // No nested tab of that name exists to select.
  await expect(
    page.getByRole("tab", { name: "Cardio", exact: true })
  ).toHaveCount(0);
  // A mapping, not a redirect: the URL is left exactly as the old link wrote it.
  await expect(page).toHaveURL(/ftab=cardio/);

  // The sections navigate by plain in-page anchor, which does not renavigate the
  // tab — the hub's own strip stays the only tab level. Options mount only while
  // the compact Jump to menu is open.
  await hydratedClick(page, page.getByTestId("chart-jump-menu-trigger"));
  await page.getByTestId("chart-jump-sport").click();
  await expect(page).toHaveURL(/tab=fitness/);
  await expect(page.getByTestId("fitness-sport")).toBeVisible();
});
