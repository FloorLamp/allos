import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import { E2E_LOGIN_CEL_IMPORT, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Imported-temperature unit gate in the browser (#1018). The CEL_IMPORT fixture
// profile is currently sick and its ONLY temperature is a LEGACY imported Celsius
// row (value_num 38.5, unit 'Cel' — the shape the CCDA mapper stored before the
// import-boundary conversion). The episode assembly's read gate must CONVERT it,
// so the cockpit's latest temperature reads "101.3 °F" — pre-fix it rendered the
// raw 38.5 on the °F axis (and understated the red-flag engine's input).
//
// Fixture-OWNED per e2e hygiene (#868): a dedicated login/profile
// (e2e/seed-events.ts), READ-ONLY here — no writes, so --repeat-each is
// trivially self-contained.

test("a legacy imported Celsius reading renders converted on the episode surfaces", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CEL_IMPORT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Reach the fixture's own open episode through its episodes index (the
    // order-independent route illness-round3 uses).
    await page.goto("/medical/episodes");
    const row = page
      .getByTestId("episode-index-row")
      .filter({ hasText: /ongoing/i })
      .first(); // first-ok: the fixture's own open episode via its episodes index (order-independent route)
    await followLink(page, row, /\/medical\/episodes\/\d+/);

    // The latest-reading readout renders the CONVERTED canonical value in the
    // default °F display — never the raw Celsius number trusted as °F.
    const value = page.getByTestId("episode-last-temperature-value");
    await expect(value).toBeVisible();
    await expect(value).toHaveText(/101\.3\s*°F/);
    await expect(
      page.getByTestId("episode-last-temperature")
    ).not.toContainText("38.5");
  } finally {
    await page.close();
  }
});
