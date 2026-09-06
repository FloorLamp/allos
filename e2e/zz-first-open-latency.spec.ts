import { test, expect } from "./fixtures";
import { awaitHydrated } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_SHELL } from "./fixture-logins";

// THROWAWAY (#3416): first-open latency of the sheet's dose form, click → row visible.
test("first-open latency", async ({ browser }) => {
  test.slow();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  const samples: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.goto("/");
    await awaitHydrated(page.getByTestId("dock-log-puck"));
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-dose");
    const t0 = performance.now();
    await row.click();
    await expect(
      page.getByTestId("quick-entry-sheet").getByTestId("quick-entry-dose-list")
    ).toBeVisible();
    samples.push(Math.round(performance.now() - t0));
  }
  console.log(`FIRST_OPEN_MS ${samples.join(" ")}`);
  await page.context().close();
});
