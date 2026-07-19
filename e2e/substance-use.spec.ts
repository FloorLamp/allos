import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_SUBSTANCE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Substance-use domain (issue #998): the /medical/substance-use surface — an
// in-app AUDIT-C tap-through (banded score), outside total-only entry for the
// instruments whose item text isn't shipped (DAST-10/AUDIT), one-tap standard-
// drink logging on the shared food-log ledger, and the weekly-cap reduction
// target with its calm progress line. No streaks, no celebration anywhere.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_SUBSTANCE in its OWN
// cookie context on a dedicated, substance-data-free adult profile. Every
// assertion is RELATIVE (before/after counts, idempotent cap upserts), so
// --repeat-each stays clean without reseeding. Interactions settle via
// settledClick.

async function weekCount(page: Page): Promise<number> {
  const text = await page.getByTestId("substance-week-count").innerText();
  return Number(text.trim().split(/\s+/)[0]);
}

test.describe("substance use (#998)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_SUBSTANCE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("in-app AUDIT-C computes a banded total and records a score", async () => {
    await page.goto("/medical/substance-use");
    await expect(page.getByTestId("substance-instruments-form")).toBeVisible();

    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    // AUDIT-C is the default selection; 3 items × option 1 = total 3 → Lower risk.
    for (let i = 0; i < 3; i++) {
      await page.getByTestId(`substance-option-${i}-1`).click();
    }
    await expect(page.getByTestId("substance-total")).toHaveText("3");
    await expect(page.getByTestId("substance-band")).toContainText(
      "Lower risk"
    );

    await settledClick(page, page.getByTestId("substance-instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("DAST-10 is total-only (no reproduced items) and records an outside total", async () => {
    await page.goto("/medical/substance-use");
    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    await settledClick(
      page,
      page.getByTestId("substance-instrument-select-DAST-10")
    );
    // No item tap-through renders — only the total-only note + total input.
    await expect(page.getByTestId("substance-total-only-note")).toBeVisible();
    await expect(page.getByTestId("substance-item-0")).toHaveCount(0);

    await page.getByTestId("substance-outside-total").fill("2");
    await settledClick(
      page,
      page.getByTestId("substance-instrument-submit-outside")
    );
    await expect(rows).toHaveCount(before + 1);
  });

  test("one tap logs a standard drink into this week's count", async () => {
    await page.goto("/medical/substance-use");
    const before = await weekCount(page);

    await settledClick(page, page.getByTestId("substance-log-drink"));
    // The count is server-rendered and lands with the router refresh that follows
    // the settled action POST — a plain retrying web-first assertion covers it.
    const after = before + 1;
    await expect(page.getByTestId("substance-week-count")).toHaveText(
      `${after} standard ${after === 1 ? "drink" : "drinks"} logged this week.`
    );
  });

  test("a weekly cap target shows the calm progress line; removing it clears the line", async () => {
    await page.goto("/medical/substance-use");

    await page.getByTestId("substance-cap-input").fill("7");
    await settledClick(page, page.getByTestId("substance-cap-save"));
    const progress = page.getByTestId("substance-cap-progress");
    await expect(progress).toBeVisible();
    // "N of your 7-drink weekly cap used." (or the over-cap phrasing if repeats
    // accumulated) — either way the cap is named, and never a streak/badge.
    await expect(progress).toContainText("7-drink weekly cap");
    await expect(progress).not.toContainText("streak");

    await settledClick(page, page.getByTestId("substance-cap-clear"));
    await expect(progress).toHaveCount(0);
  });
});
