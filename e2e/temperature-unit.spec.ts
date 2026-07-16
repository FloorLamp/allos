import { test, expect } from "@playwright/test";

// Temperature-unit login preference (#857). Body temperature is stored canonically in
// °F; the login picks °F or °C under Settings → Preferences and every temperature
// surface follows. This drives the real Settings select and confirms a °C login sees °C
// on the dashboard symptom card's temperature entry + fever toast. The seed's illness-
// type situation surfaces that card. Restores °F at the end so the shared login doesn't
// leak the preference into other specs.

test("a °C login: the Settings select persists and the dashboard temp entry + fever toast render in °C", async ({
  page,
}) => {
  try {
    // Toggle the preference to Celsius on Settings → Preferences (autosave on change).
    await page.goto("/settings");
    const select = page.getByTestId("temperature-unit-select");
    await expect(select).toBeVisible();
    await select.selectOption("C");

    // It persists across a reload.
    await page.reload();
    await expect(page.getByTestId("temperature-unit-select")).toHaveValue("C");

    // On the dashboard symptom card, the temp entry unit now defaults to °C.
    await page.goto("/");
    const bar = page.getByTestId("symptom-log-bar").first();
    await expect(bar).toBeVisible();
    await bar.getByTestId("temp-quick-toggle").click();
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("C");

    // Logging a reading confirms it in °C via the fever toast (fmtTemp).
    await bar.getByTestId("temp-quick-input").fill("38");
    await bar.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/°C/).first()).toBeVisible();
  } finally {
    // Restore °F so the shared login preference doesn't bleed into other specs.
    await page.goto("/settings");
    await page.getByTestId("temperature-unit-select").selectOption("F");
    await expect(page.getByTestId("temperature-unit-select")).toHaveValue("F");
  }
});
