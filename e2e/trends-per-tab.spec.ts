import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Issue #105: the Trends hub must render ONLY the active tab's section
// server-side (previously all six sections rendered — and ran their queries —
// on every request). Tabs still switch via a URL navigation, so each view is a
// fresh, single-tab server render. These specs prove (a) direct navigation
// renders the requested tab's content and NOT the other tabs' content (the
// server-side gating), and (b) clicking a tab switches which section is
// rendered.

// Markers that are data-independent (always rendered by their section's chrome):
//   Insights → the "Date to analyze" generate form
//   Fitness  → the "Full Training →" link + nested Strength/Cardio/Sport strip
// (Biomarkers left the Trends hub in #1164 — merged into Results.)
const INSIGHTS_MARKER = "Date to analyze";
const FITNESS_MARKER = "Full Training";

test("direct navigation renders only the requested tab's section (#105)", async ({
  page,
}) => {
  // Overview (default): neither the Insights form nor the Fitness link render.
  await page.goto("/trends");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
  await expect(page.getByText(FITNESS_MARKER)).toHaveCount(0);
  await expect(page.getByTestId("trajectory-findings")).toHaveCount(0);

  // The Overview metric tiles render (fed by the deduped one-source-per-day series
  // and the robust-endpoint change badge — #395/#398). At least the standard
  // body/training tiles are present, and the "Weight" tile links to the Body tab.
  await expect(page.getByTestId("trend-mini-card").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Weight", exact: true })
  ).toBeVisible();

  // Insights: its generate form renders; the Fitness link does not.
  await page.goto("/trends?tab=insights");
  await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();
  await expect(page.getByText(FITNESS_MARKER)).toHaveCount(0);

  // Fitness: its link + nested strip render; the Insights form does not.
  await page.goto("/trends?tab=fitness");
  await expect(page.getByRole("tab", { name: "Fitness" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(FITNESS_MARKER)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Strength" })).toBeVisible();
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});

test("the Trends tab strip no longer lists Biomarkers, and a stale ?tab=biomarkers falls back to the default tab (#1164)", async ({
  page,
}) => {
  await page.goto("/trends");
  // Biomarkers is gone from the strip (merged into Results); the surviving tabs stay.
  await expect(page.getByRole("tab", { name: "Biomarkers" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Nutrition" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Body" })).toBeVisible();

  // A stale external bookmark to the removed tab falls through the hub's unknown-?tab=
  // fallback to the default (Overview) — no redirect, no 404.
  await page.goto("/trends?tab=biomarkers");
  await expect(page).toHaveURL(/\/trends\?tab=biomarkers$/);
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // A live page, not an error: the hub heading renders and no biomarker section shows.
  await expect(
    page.getByRole("heading", { name: "Trends", exact: true })
  ).toBeVisible();
  await expect(page.getByTestId("trajectory-findings")).toHaveCount(0);
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
  await expect(page.getByText(FITNESS_MARKER)).toHaveCount(0);

  // Click Fitness → its content replaces the Insights form.
  await followLink(
    page,
    page.getByRole("tab", { name: "Fitness" }),
    /tab=fitness/
  );
  await expect(page.getByText(FITNESS_MARKER)).toBeVisible();
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});

test("the Fitness nested strip is URL-driven and deep-linkable (#105)", async ({
  page,
}) => {
  // Direct deep link into a nested Fitness tab selects it.
  await page.goto("/trends?tab=fitness&ftab=cardio");
  await expect(page.getByRole("tab", { name: "Fitness" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("tab", { name: "Cardio" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // Clicking a nested tab navigates, preserving the outer tab. The nested strip is
  // the same NavTabs component (real <a href>); a machine-speed click landing
  // mid-hydration on the heavy Fitness section (charts + deeply-nested strip) can
  // still have its router.push dropped (#830). followLink retries the tab click
  // until the nested URL commits — the blessed replacement for the old networkidle
  // readiness gate (#868). Re-clicking the same tab is idempotent (same href).
  await followLink(
    page,
    page.getByRole("tab", { name: "Sport" }),
    /ftab=sport/
  );
  await expect(page).toHaveURL(/tab=fitness/);
  await expect(page.getByRole("tab", { name: "Sport" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});
