import { test, expect } from "./fixtures";
// AI narrative surfaces (issue #20): the weekly/monthly recap generator on the
// Trends "Insights" tab. These assert the controls RENDER (server-rendered forms) without
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
});
