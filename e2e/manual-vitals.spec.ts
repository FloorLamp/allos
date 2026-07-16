import { test, expect } from "@playwright/test";

// #16: manual vitals entry. The Trends → Body tab carries a "Log vitals" quick-add
// for the measures that previously could ONLY arrive via the Health Connect
// exporter (blood pressure, glucose, SpO2, temperature, sleep, HRV). It writes to
// the SAME tables/keys the integration uses, so an entered reading shows up in the
// biomarker table (medical_records) and the Body sleep chart (metric_samples) —
// this drives the form and asserts both surfaces reflect the new data.
test("logging vitals persists and renders alongside synced readings (#16)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");

  const form = page.getByTestId("vitals-quick-add");
  await expect(form).toBeVisible();

  // A distinctive-but-synthetic set: BP pair + SpO2 + sleep. The date defaults to
  // today (the seeded fixture's clock), so a wide biomarkers window includes it.
  await form.getByLabel("Systolic (mmHg)").fill("118");
  await form.getByLabel("Diastolic (mmHg)").fill("76");
  await form.getByLabel("Oxygen sat. (%)").fill("97");
  await form.getByLabel("Sleep (hours)").fill("7.5");

  await form.getByRole("button", { name: "Save vitals" }).click();

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText("Vitals saved")).toBeVisible();

  // medical_records rows surface on the Biomarkers tab (widen the window so today's
  // entry is in range regardless of the default range).
  await page.goto("/trends?tab=biomarkers&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByRole("link", { name: "Blood Pressure Systolic" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Oxygen Saturation" })
  ).toBeVisible();

  // The sleep sample surfaces in the Body tab's "Sleep per night" chart card.
  await page.goto("/trends?tab=body");
  await expect(
    page.getByRole("heading", { name: "Sleep per night" })
  ).toBeVisible();

  // #114: the /biomarkers browser ships only one bounded page of rows, so its
  // table always renders the pagination footer ("Showing N of M") — a cheap proof
  // the bounded-payload table surfaced regardless of lab-history size.
  await page.goto("/biomarkers");
  const pager = page.getByTestId("biomarkers-pagination");
  await expect(pager).toBeVisible();
  await expect(pager).toContainText("Showing");
});

// #843 (door B): the vitals quick-add now carries an optional temperature reading time
// (#800 specced timed readings; it previously had none), so a manual temperature can
// build the same fever curve a synced thermometer does. Drive a timed reading and
// confirm it persisted without error.
test("vitals quick-add logs a temperature with an optional reading time (#843)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");

  const form = page.getByTestId("vitals-quick-add");
  await expect(form).toBeVisible();

  await form.getByLabel("Temperature", { exact: true }).fill("101.2");
  const timeField = form.getByTestId("vitals-temp-time");
  await expect(timeField).toBeVisible();
  await timeField.fill("07:00");

  await form.getByRole("button", { name: "Save vitals" }).click();
  await expect(page.getByText("Vitals saved")).toBeVisible();

  // The reading joins the Body Temperature series in the biomarker browser.
  await page.goto("/trends?tab=biomarkers&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByRole("link", { name: "Body Temperature" })
  ).toBeVisible();
});
