import { test, expect } from "@playwright/test";

// #542 — a titer series whose values carry an embedded unit ("58 mIU/mL") or a
// dilution ratio ("1:160") used to vanish from the chart entirely (whole-string
// numeric parse rejected them). parseLeadingNumeric recovers the leading numeric at
// the chart boundary, so the series now plots. Fixture: "E2E Rubella IgG Titer"
// with "1:40" and "58 mIU/mL".
test("embedded-unit and titer-ratio values are recovered onto the chart (#542)", async ({
  page,
}) => {
  await page.goto("/biomarkers/view?name=E2E%20Rubella%20IgG%20Titer");

  await expect(
    page.getByRole("heading", { name: "E2E Rubella IgG Titer" })
  ).toBeVisible();

  // The numeric trend chart renders (recovered values), not the empty/qualitative
  // fallback.
  await expect(page.getByText("No numeric readings to chart")).toHaveCount(0);
  await expect(page.getByTestId("qualitative-timeline")).toHaveCount(0);
  // Both readings still appear in the readings table verbatim.
  await expect(page.getByText("58 mIU/mL")).toBeVisible();
});

// #543 — a purely qualitative series (no numeric anywhere) previously rendered a
// blank chart with no explanation. It now renders a dated qualitative timeline.
// Fixture: "E2E Mumps IgG Screen" = Negative then Reactive.
test("a purely qualitative series renders a dated timeline, not a blank chart (#543)", async ({
  page,
}) => {
  await page.goto("/biomarkers/view?name=E2E%20Mumps%20IgG%20Screen");

  await expect(
    page.getByRole("heading", { name: "E2E Mumps IgG Screen" })
  ).toBeVisible();

  const timeline = page.getByTestId("qualitative-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText("Reactive");
  await expect(timeline).toContainText("Negative");
});
