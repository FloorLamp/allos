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
  // Both readings still appear in the readings table verbatim. Scoped to the
  // table: the latest-reading badge above it repeats the same text, so a bare
  // getByText is a strict-mode collision.
  await expect(page.getByRole("table").getByText("58 mIU/mL")).toBeVisible();
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

// #698 §4 — a visual-acuity series ("20/20", "20/40") is Snellen-fraction shaped:
// qualitative, NOT numeric. parseLeadingNumeric rejects the bare fraction, so it renders
// as a dated timeline (not a flat numeric axis) and carries NO false "abnormal" flag
// (it has no numeric reference band). Fixture: "Visual Acuity, Right Eye".
test("visual acuity renders a dated timeline with no false abnormal flag (#698)", async ({
  page,
}) => {
  await page.goto("/biomarkers/view?name=Visual%20Acuity%2C%20Right%20Eye");

  await expect(
    page.getByRole("heading", { name: "Visual Acuity, Right Eye" })
  ).toBeVisible();

  // A dated timeline, not a numeric chart or the empty fallback.
  await expect(page.getByText("No numeric readings to chart")).toHaveCount(0);
  const timeline = page.getByTestId("qualitative-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText("20/20");
  await expect(timeline).toContainText("20/40");
  // No false abnormal flag on a qualitative acuity reading.
  await expect(page.getByText("Abnormal")).toHaveCount(0);
});
