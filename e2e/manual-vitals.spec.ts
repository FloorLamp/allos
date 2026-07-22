import { test, expect } from "@playwright/test";

// #16: manual vitals entry. The Trends → Body tab carries a "Log vitals" quick-add
// for the measures that previously could ONLY arrive via the Health Connect
// exporter (blood pressure, glucose, SpO2, temperature, sleep, HRV). It writes to
// the SAME tables/keys the integration uses. Since #1076 the physiologic vitals are
// re-homed to the Trends → Vitals section (off the lab-scoped biomarker surfaces),
// so an entered reading shows up there and in the Body sleep chart (metric_samples).
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

  // The vitals surface on the Trends → Vitals section (#1076), widened so today's
  // entry is in range regardless of the default window.
  await page.goto("/trends?tab=vitals&from=2000-01-01&to=2100-01-01");
  const vitals = page.getByTestId("trends-vitals");
  await expect(vitals.getByTestId("vitals-blood-pressure")).toBeVisible();
  await expect(vitals.getByTestId("vitals-spo2")).toBeVisible();

  // The sleep sample surfaces in the Body tab's compact Sleep summary tile (the
  // detailed per-night chart moved to the dedicated /sleep page, #1066).
  await page.goto("/trends?tab=body");
  await expect(page.getByTestId("sleep-summary-tile")).toBeVisible();

  // #114: the biomarkers browser (/results#biomarkers) ships only one bounded page of rows, so its
  // table always renders the pagination footer ("Showing N of M") — a cheap proof
  // the bounded-payload table surfaced regardless of lab-history size.
  await page.goto("/results");
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

  // Pin °F explicitly — the entry unit now defaults to the login's temperature
  // preference (#857); this reading is entered in Fahrenheit.
  await form.getByLabel("Temperature unit").selectOption("F");
  await form.getByLabel("Temperature", { exact: true }).fill("101.2");
  const timeField = form.getByTestId("vitals-temp-time");
  await expect(timeField).toBeVisible();
  await timeField.fill("07:00");

  await form.getByRole("button", { name: "Save vitals" }).click();
  await expect(page.getByText("Vitals saved")).toBeVisible();

  // The reading joins the Body Temperature acute view on the Trends → Vitals
  // section (#1076): recent-readings grammar with a fever line, not a lab trajectory.
  await page.goto("/trends?tab=vitals&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByTestId("trends-vitals").getByTestId("vitals-temperature")
  ).toBeVisible();
});
