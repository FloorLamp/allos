import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_DERIVED,
  E2E_MEMBER_PASSWORD,
  DERIVED_SITU_PERIOD_ITEM,
  DERIVED_SITU_SLEEP_ITEM,
} from "./fixture-logins";

// Derived situations (issues #1292 Poor sleep, #1298 Period): a situation a situational
// supplement keys on that is COMPUTED from the profile's own data — a rough last-night
// sleep session, a logged period day — never a manual chip. The bar renders the derived
// state line distinctly (an "Auto" tag), and dueness widens for that context only.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_DERIVED in its OWN cookie
// context on a dedicated adult female (cycle-relevant) profile seeded with a rough
// last-night sleep (poor-sleep DERIVED-on), a Period-keyed iron + a Poor-sleep-keyed
// magnesium, and NO open period. The Period test logs a period and then ends+deletes it
// (its own inverse), so --repeat-each stays clean. The poor-sleep assertions are
// read-only (the "Not today" clear behavior is pinned by the DB + action tiers, which
// can restore between runs; a browser dismiss would not survive --repeat-each).

test.describe("derived situations (#1292/#1298)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_DERIVED,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("poor-sleep: the measured rough-night state line + a Not-today control render", async () => {
    await page.goto("/nutrition?tab=supplements");

    // The DERIVED poor-sleep line renders distinctly (the seeded 5h night trips the
    // floor), names the rough night, and offers the one-tap "Not today" override.
    const line = page.getByTestId("derived-poor-sleep");
    await expect(line).toBeVisible();
    await expect(line).toContainText(/Rough night/);
    await expect(line).toContainText(/sleep-support item/);
    await expect(page.getByTestId("derived-poor-sleep-override")).toBeVisible();

    // The magnesium keyed to Poor sleep is DUE while the derived context holds.
    await expect(
      page.getByText(DERIVED_SITU_SLEEP_ITEM).first() // first-ok: order-agnostic presence of this spec's own fixture item
    ).toBeVisible();
  });

  test("period: logging a period turns the context on (line + dueness), ending clears it", async () => {
    // No open period seeded → Period context off; the iron item is NOT scheduled today.
    await page.goto("/nutrition?tab=supplements");
    await expect(page.getByTestId("derived-period")).toHaveCount(0);

    // Log a period today.
    await page.goto("/medical/cycles");
    await settledClick(page, page.getByTestId("period-started-button"));
    await expect(page.getByTestId("period-ended-button")).toBeVisible();

    // The derived Period line + the iron item's dueness appear on the bar.
    await page.goto("/nutrition?tab=supplements");
    const periodLine = page.getByTestId("derived-period");
    await expect(periodLine).toBeVisible();
    await expect(periodLine).toContainText(/Period logged/);
    await expect(periodLine).toContainText(/1 item active/);
    await expect(
      page.getByText(DERIVED_SITU_PERIOD_ITEM).first() // first-ok: order-agnostic presence of this spec's own fixture item
    ).toBeVisible();

    // Clean up: end + delete the period (fully clears today's coverage) → the derived
    // Period context — and the line — go away, restoring the starting state.
    await page.goto("/medical/cycles");
    await settledClick(page, page.getByTestId("period-ended-button"));
    await settledClick(page, page.getByTestId("cycle-delete-button").first()); // first-ok: deletes the period THIS spec just created (its own fixture data)
    await expect(page.getByTestId("period-started-button")).toBeVisible();

    await page.goto("/nutrition?tab=supplements");
    await expect(page.getByTestId("derived-period")).toHaveCount(0);
  });
});
