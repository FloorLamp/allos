import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick, openMeasurementGroup } from "./helpers";

// #16: manual vitals entry — the measures that previously could ONLY arrive via the
// Health Connect exporter (blood pressure, glucose, SpO2, temperature, sleep, HRV)
// are enterable by hand and write to the SAME tables/keys the integration uses.
//
// Re-pointed by #1486: the Vitals tab merged into Body, and the body + vitals
// quick-adds merged into ONE "Log measurements" form behind a desktop "+ Log"
// modal. Same write cores, same canonical rows — one door instead of
// three. (This project runs at desktop width; the phone's path is the #1468
// overlay, covered by e2e/trends-body-merge.mobile.spec.ts.)
async function openMeasurementsForm(page: Page) {
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  return form;
}

test("logging vitals persists and renders alongside synced readings (#16)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  // A distinctive-but-synthetic set: BP pair + SpO2 + sleep. The date defaults to
  // today (the seeded fixture's clock), so a wide biomarkers window includes it.
  // This entry point (Trends → Overview → body census) opens the BODY group, so Vitals and Sleep are
  // opened explicitly — and a blood pressure is now ONE field with two inputs
  // (#2014), each named by the number it takes rather than by a title carrying two
  // parentheticals.
  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByLabel("Oxygen Saturation", { exact: true }).fill("97");
  await openMeasurementGroup(page, form, "sleep");
  await form.getByLabel("Sleep", { exact: true }).fill("7.5");

  await form.getByRole("button", { name: "Save measurements" }).click();

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading surfaces in the body census VITALS section (#1076/#1486),
  // widened so today's entry is in range regardless of the default window.
  await page.goto("/trends?view=all&from=2000-01-01&to=2100-01-01");
  const body = page.getByTestId("trends-body");
  await expect(body.getByTestId("vitals-systolic")).toBeVisible();
  await expect(body.getByTestId("vitals-spo2")).toBeVisible();

  // The sleep sample surfaces in the body census nightly-duration chart; detailed
  // regularity and stage analysis stays on the dedicated /sleep page (#1066).
  await page.goto("/trends?view=all");
  const sleep = page.getByTestId("sleep-summary-tile");
  await expect(sleep).toBeVisible();
  await expect(sleep.getByRole("application")).toBeVisible();

  // The clinical results catalog renders as the collapsed panel index.
  await page.goto("/results");
  const clinicalResults = page.getByTestId("results-clinical-results");
  await expect(
    clinicalResults.getByTestId("clinical-results-table")
  ).toBeVisible();
});

// #843 (door B): the measurements form carries an optional temperature reading time
// (#800 specced timed readings; it previously had none), so a manual temperature can
// build the same fever curve a synced thermometer does. Drive a timed reading and
// confirm it persisted without error.
//
// The TIME half moved (#2154): the temperature's own time input folded into the
// form's ONE shared WhenControl Time for the whole sitting, whose statement the
// write boundary lands on the reading's `occurred_at`. The property under test is
// unchanged — a manual temperature still carries the reading time that makes a
// fever curve possible — so this drives the control that now states it.
test("the measurements form logs a temperature with an optional reading time (#843)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  // Pin °F explicitly — the entry unit now defaults to the login's temperature
  // preference (#857); this reading is entered in Fahrenheit.
  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Body Temperature unit").selectOption("F");
  await form.getByLabel("Body Temperature", { exact: true }).fill("101.2");
  const timeField = form.getByTestId("m-time");
  await expect(timeField).toBeVisible();
  await timeField.fill("07:00");

  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading joins the Body Temperature acute view in the body census vitals
  // section (#1076/#1486): recent-readings grammar with a fever line, not a lab
  // trajectory.
  await page.goto("/trends?view=all&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByTestId("trends-body").getByTestId("vitals-temperature")
  ).toBeVisible();
});

// #1851: three measures that were charted, imported and consumed downstream but
// had no field. This drives the REAL form — the field names it posts are the
// names the Server Action reads, and nothing but an end-to-end save can tell you
// they still agree — then reads each value back off the metric's own detail page,
// which renders from the stored row.
test("the measurements form takes water, lean/bone mass and respiratory rate (#1851)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Respiratory Rate", { exact: true }).fill("22");
  await openMeasurementGroup(page, form, "body");
  await form.getByLabel("Water today", { exact: true }).fill("2.4");
  await form.getByLabel("Lean Body Mass unit").selectOption("kg");
  await form.getByLabel("Lean Body Mass", { exact: true }).fill("56.4");
  await form.getByLabel("Bone Mass unit").selectOption("kg");
  await form.getByLabel("Bone Mass", { exact: true }).fill("2.9");

  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // Each value on its own detail page's readings table — the surface that renders
  // the STORED row, so a field that appears and writes nothing fails here. The
  // seed carries no reading of any of these, so the row count is the control: one
  // row, the one just typed.
  for (const [slug, shown] of [
    ["respiratory-rate", "22"],
    ["hydration", "2.4"],
    ["lean-mass", "56.4"],
    ["bone-mass", "2.9"],
  ] as const) {
    await page.goto(`/trends/metric/${slug}?from=2000-01-01&to=2100-01-01`);
    const rows = page.getByTestId("metric-readings-table").locator("tbody tr");
    // The slug is in the message because the four share one loop and one line: a
    // bare "expected 1, received 0" here names no metric, and the whole point of
    // the loop is that each of the four can fail on its own.
    await expect(rows, slug).toHaveCount(1);
    await expect(rows, slug).toContainText(shown);
  }
});
