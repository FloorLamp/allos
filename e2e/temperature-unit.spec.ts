import { test, expect } from "@playwright/test";
import { openTempEntry } from "./symptom-helpers";

// Temperature-unit login preference (#857). Body temperature is stored canonically in
// °F; the login picks °F or °C under Settings → Preferences and every temperature
// surface follows. This drives the real Settings select and confirms a °C login sees °C
// on the dashboard symptom card's temperature entry + fever toast, and (#1019) on the
// temperature RED-FLAG finding the Upcoming page renders — the one temperature surface
// designed to be unmissable. The seed's illness-type situation surfaces that card; the
// red-flag reading is an additive write on profile 1's shared open episode (the same
// 104.5 °F crossing illness-round3 logs — no exact-count assertions on shared seed,
// #868). Restores °F at the end so the shared login doesn't leak the preference.

test("a °C login: the Settings select persists and the dashboard temp entry + fever toast render in °C", async ({
  page,
}) => {
  test.slow(); // settings → dashboard → two logs → /upcoming is a long path
  try {
    // Toggle the preference to Celsius on Settings → Preferences (autosave on change).
    await page.goto("/settings");
    const select = page.getByTestId("temperature-unit-select");
    await expect(select).toBeVisible();
    await select.selectOption("C");
    // Wait for the autosave to LAND before reloading — the units card's SaveStatus
    // shows a "Saved" check once the server action resolves (the write is committed).
    // Reloading before this races the async save (that's what dropped the pref).
    await expect(page.getByLabel("Saved")).toBeVisible();

    // It persists across a full reload.
    await page.reload();
    await expect(page.getByTestId("temperature-unit-select")).toHaveValue("C");

    // On the dashboard symptom card, the temp entry unit now defaults to °C.
    await page.goto("/");
    const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
    await expect(bar).toBeVisible();
    await bar.getByTestId("temp-quick-toggle").click();
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("C");

    // Logging a reading confirms it in °C via the fever toast (fmtTemp).
    await bar.getByTestId("temp-quick-input").fill("38");
    await bar.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/Temperature logged/i)).toContainText("°C");

    // #1019: log a red-flag crossing (40.3 °C == 104.5 °F, hyperpyrexia) and the
    // care-tier finding on Upcoming renders its app-authored fact clause in the
    // login's °C pref — the cited source label ("104°F or higher") stays verbatim.
    // The entry collapses after a save, so re-open it (the shared helper).
    await openTempEntry(bar);
    await bar.getByTestId("temp-quick-input").fill("40.3");
    await bar.getByTestId("temp-quick-save").click();
    await expect(
      page.getByText(/Temperature logged: 40\.3 °C/).first() // first-ok: the confirmation for the temperature THIS spec just logged — order-agnostic
    ).toBeVisible();
    await page.goto("/upcoming");
    const redFlagItem = page
      .locator('[data-testid^="upcoming-item-temp-red-flag:"]')
      .first(); // first-ok: the red-flag item for the 40.3 °C reading THIS spec logged — order-agnostic
    await expect(redFlagItem).toBeVisible();
    await expect(redFlagItem).toContainText("Temperature 40.3 °C");
    await expect(redFlagItem).not.toContainText("104.5 °F");
  } finally {
    // Restore °F so the shared login preference doesn't bleed into other specs.
    await page.goto("/settings");
    await page.getByTestId("temperature-unit-select").selectOption("F");
    await expect(page.getByLabel("Saved")).toBeVisible();
    await expect(page.getByTestId("temperature-unit-select")).toHaveValue("F");
  }
});
