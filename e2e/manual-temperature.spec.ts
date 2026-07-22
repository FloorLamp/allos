import { test, expect } from "@playwright/test";

// Manual body-temperature entry (#800). The seed activates the built-in illness-type
// "Illness" situation, so the dashboard Symptoms card is surfaced — and with it the
// body-temperature quick entry (a fever log belongs on the illness card). This drives
// the real quick entry: log a fever reading, then confirm it lands on the Timeline day
// view flagged out-of-range in the shared "Body Temperature" vitals series.

test("logging a fever from the symptom card surfaces it flagged on the day view (#800)", async ({
  page,
}) => {
  await page.goto("/");

  // The temperature quick entry is collapsed by default (#857) — expand it.
  await page.getByTestId("temp-quick-toggle").click();
  const temp = page.getByTestId("temp-quick-entry");
  await expect(temp).toBeVisible();

  // A clear fever in °F (the default unit) — 103 °F is well above the 97–99 °F range.
  await page.getByTestId("temp-quick-unit").selectOption("F");
  await page.getByTestId("temp-quick-input").fill("103");
  await page.getByTestId("temp-quick-save").click();

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText(/Temperature logged/i)).toBeVisible();

  // The reading rides the shared vitals series and lands on the Timeline day view as a
  // flagged (out-of-range) medical result naming Body Temperature.
  await page.goto("/timeline?category=medical");
  await expect(page.getByText("Body Temperature").first()).toBeVisible(); // first-ok: asserts a Body Temperature reading renders — order-agnostic presence
  await expect(page.getByText(/out of range/i).first()).toBeVisible(); // first-ok: asserts an out-of-range flag renders — order-agnostic presence
});
