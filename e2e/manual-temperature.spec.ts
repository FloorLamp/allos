import { test, expect } from "./fixtures";
import {
  hydratedClick,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
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
  // hydratedClick, not a bare .click(): a tap dispatched before React attaches is
  // swallowed, the panel never opens, and the spec fails downstream at the toast
  // with no clue why. (Observed flaking at retries:0 under worker contention.)
  await hydratedClick(page, page.getByTestId("temp-quick-toggle"));
  const temp = page.getByTestId("temp-quick-entry");
  await expect(temp).toBeVisible();

  // A clear fever in °F (the default unit) — 103 °F is well above the 97–99 °F range.
  await settledSelect(page, page.getByTestId("temp-quick-unit"), "F");
  await settledFill(page, page.getByTestId("temp-quick-input"), "103");
  // The save posts a Server Action — await it rather than racing the toast.
  await settledClick(page, page.getByTestId("temp-quick-save"));

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText(/Temperature logged/i)).toBeVisible();

  // The reading rides the shared vitals series and lands on the Timeline day view as a
  // flagged (out-of-range) medical result naming Body Temperature.
  await page.goto("/timeline?category=medical");
  await expect(page.getByText("Body Temperature").first()).toBeVisible(); // first-ok: asserts a Body Temperature reading renders — order-agnostic presence
  await expect(page.getByText(/out of range/i).first()).toBeVisible(); // first-ok: asserts an out-of-range flag renders — order-agnostic presence
});
