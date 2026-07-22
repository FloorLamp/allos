import { test, expect } from "@playwright/test";

// AI narrative surfaces (issue #20): the weekly/monthly recap generator on the
// Trends "Insights" tab. (The lab-trend interpretation card — #20's second
// narrative — was REMOVED with the Trends → Biomarkers tab in #1164; the tests
// below prove the recap generator still renders and the lab-trend control is gone
// everywhere.) These assert the controls RENDER (server-rendered forms) without
// submitting — generating would write a narratives row into the shared seeded e2e
// DB, and this spec deliberately leaves no state behind.

test("Insights tab renders the weekly/monthly recap generator (#20)", async ({
  page,
}) => {
  await page.goto("/trends?tab=insights");
  await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  const form = page.getByTestId("recap-narrative-form");
  await expect(form).toBeVisible();
  await expect(
    form.getByRole("button", { name: /Weekly recap/ })
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: /Monthly recap/ })
  ).toBeVisible();

  // The daily-insight generator still renders alongside the recap controls.
  await expect(page.getByText("Date to analyze")).toBeVisible();

  // The removed AI lab-trend interpretation card is absent on the Insights tab.
  await expect(page.getByTestId("lab-trend-interpretation")).toHaveCount(0);
});

test("the AI lab-trend interpretation card is gone everywhere (#1164/#20)", async ({
  page,
}) => {
  // On the canonical biomarker browser (Results), where the Trends duplicate was
  // merged in — the trajectory watch moved here, but the AI lab-trend card did NOT.
  await page.goto("/results/biomarkers");
  await expect(page.getByTestId("results-biomarkers")).toBeVisible();
  await expect(page.getByTestId("lab-trend-interpretation")).toHaveCount(0);
  await expect(page.getByText("Lab-trend interpretation")).toHaveCount(0);

  // And a stale ?tab=biomarkers deep link (now a fallback to the Trends default
  // tab) shows no lab-trend card either.
  await page.goto("/trends?tab=biomarkers");
  await expect(page.getByTestId("lab-trend-interpretation")).toHaveCount(0);
});
