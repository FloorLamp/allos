import { test, expect, type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// #16: manual vitals entry — the measures that previously could ONLY arrive via the
// Health Connect exporter (blood pressure, glucose, SpO2, temperature, sleep, HRV)
// are enterable by hand and write to the SAME tables/keys the integration uses.
//
// Re-pointed by #1486: the Vitals tab merged into Body, and the body + vitals
// quick-adds merged into ONE "Log measurements" form behind a collapsed desktop
// "+ Log" expander. Same write cores, same canonical rows — one door instead of
// three. (This project runs at desktop width; the phone's path is the #1468
// overlay, covered by e2e/trends-body-merge.mobile.spec.ts.)
async function openMeasurementsForm(page: Page) {
  await page.goto("/trends?tab=body");
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
  await form.getByLabel("Systolic (mmHg)").fill("118");
  await form.getByLabel("Diastolic (mmHg)").fill("76");
  await form.getByLabel("Oxygen sat. (%)").fill("97");
  await form.getByLabel("Sleep (hours)").fill("7.5");

  await form.getByRole("button", { name: "Save measurements" }).click();

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading surfaces in the merged Body tab's VITALS section (#1076/#1486),
  // widened so today's entry is in range regardless of the default window.
  await page.goto("/trends?tab=body&view=all&from=2000-01-01&to=2100-01-01");
  const body = page.getByTestId("trends-body");
  await expect(body.getByTestId("vitals-systolic")).toBeVisible();
  await expect(body.getByTestId("vitals-spo2")).toBeVisible();

  // The sleep sample surfaces in the Body tab's compact Sleep summary tile (the
  // detailed per-night chart moved to the dedicated /sleep page, #1066).
  await page.goto("/trends?tab=body&view=all");
  await expect(page.getByTestId("sleep-summary-tile")).toBeVisible();

  // #114: the biomarkers browser (/results#biomarkers) ships only one bounded page of rows, so its
  // table always renders the pagination footer ("Showing N of M") — a cheap proof
  // the bounded-payload table surfaced regardless of lab-history size.
  await page.goto("/results");
  const pager = page.getByTestId("biomarkers-pagination");
  await expect(pager).toBeVisible();
  await expect(pager).toContainText("Showing");
});

// #843 (door B): the measurements form carries an optional temperature reading time
// (#800 specced timed readings; it previously had none), so a manual temperature can
// build the same fever curve a synced thermometer does. Drive a timed reading and
// confirm it persisted without error.
test("the measurements form logs a temperature with an optional reading time (#843)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  // Pin °F explicitly — the entry unit now defaults to the login's temperature
  // preference (#857); this reading is entered in Fahrenheit.
  await form.getByLabel("Temperature unit").selectOption("F");
  await form.getByLabel("Temperature", { exact: true }).fill("101.2");
  const timeField = form.getByTestId("measurements-temp-time");
  await expect(timeField).toBeVisible();
  await timeField.fill("07:00");

  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading joins the Body Temperature acute view in the Body tab's vitals
  // section (#1076/#1486): recent-readings grammar with a fever line, not a lab
  // trajectory.
  await page.goto("/trends?tab=body&view=all&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByTestId("trends-body").getByTestId("vitals-temperature")
  ).toBeVisible();
});
