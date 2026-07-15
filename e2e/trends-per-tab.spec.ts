import { test, expect } from "@playwright/test";

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
//   Biomarkers → the seeded "trajectory-findings" card (eGFR decline fixture)
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

  // Biomarkers: the seeded trajectory card renders (also proves the tab's own
  // queries still run when it's the active tab).
  await page.goto("/trends?tab=biomarkers");
  await expect(page.getByRole("tab", { name: "Biomarkers" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByTestId("trajectory-findings")).toBeVisible();
});

test("clicking a tab switches which section is rendered (#105)", async ({
  page,
}) => {
  await page.goto("/trends");
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);

  // Click Insights → its form appears and the URL reflects the tab. Retry the
  // click until the URL updates: a click landing in the pre-hydration window is
  // swallowed on a not-yet-hydrated tree (CI's `next start` exposes this more
  // than local `next dev`).
  await expect(async () => {
    await page.getByRole("tab", { name: "Insights" }).click();
    await expect(page).toHaveURL(/tab=insights/, { timeout: 2000 });
  }).toPass();
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();
  await expect(page.getByText(FITNESS_MARKER)).toHaveCount(0);

  // Click Fitness → its content replaces the Insights form.
  await expect(async () => {
    await page.getByRole("tab", { name: "Fitness" }).click();
    await expect(page).toHaveURL(/tab=fitness/, { timeout: 2000 });
  }).toPass();
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

  // Clicking a nested tab navigates, preserving the outer tab. Retry the click
  // until the URL updates: a click landing in the pre-hydration window is
  // swallowed on a not-yet-hydrated tree (CI's `next start` exposes this more
  // than local `next dev`).
  await expect(async () => {
    await page.getByRole("tab", { name: "Sport" }).click();
    await expect(page).toHaveURL(/ftab=sport/, { timeout: 2000 });
  }).toPass();
  await expect(page).toHaveURL(/tab=fitness/);
  await expect(page.getByRole("tab", { name: "Sport" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});
