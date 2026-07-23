import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent } from "./helpers";
import { E2E_LOGIN_MOBILE_HC, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Mobile clipped-content audit (issue #1063). The app shell's `overflow-x-clip`
// means a phone-width layout that blows past the viewport doesn't page-scroll —
// it renders as invisible, UNREACHABLE content (the Health Connect token card's
// copy/reveal buttons were pushed off-screen, defeating the page's whole
// purpose). Each test here loads one of the six audited pages at 360×800,
// anchors on a page-specific element (so the guard never runs against a blank
// or error page), then asserts element-level containment via
// expectNoClippedContent (e2e/helpers.ts): every element's right edge inside
// the viewport unless it sits in a working `overflow-x-auto` scroller.
//
// All assertions are read-only over seeded fixtures (no writes), so the spec is
// repeat-safe and never perturbs a neighbor. The viewport is set per-page after
// auth (storageState / loginAs), never inside shared e2e infra.

const PHONE = { width: 360, height: 800 };

async function phone(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
}

test.describe("mobile clipped-content audit (#1063)", () => {
  test("/integrations/health-connect: token card fits a phone viewport", async ({
    browser,
  }) => {
    test.slow(); // local next dev compiles the route on first hit
    // A dedicated CONNECTED fixture profile (read-only) — the generate/rotate
    // fixture profile belongs to integrations-health-connect.spec.ts.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MOBILE_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await phone(page);
      await page.goto("/integrations/health-connect");
      await expect(page.getByTestId("health-connect-status")).toBeVisible();
      // The card's whole purpose on a phone: the copy affordances are on-screen.
      await expect(
        page.getByRole("button", { name: "Copy" }).nth(1)
      ).toBeVisible();
      await expectNoClippedContent(page);
    } finally {
      await page.context().close();
    }
  });

  test("/integrations/strava: connected cards fit a phone viewport", async ({
    page,
  }) => {
    test.slow();
    await phone(page);
    // Profile 1's Strava connection is seeded `connected`, so the status card +
    // the Setup card (callback domain/URL rows) all render.
    await page.goto("/integrations/strava");
    await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
    await expectNoClippedContent(page);
  });

  test("/household: member cards fit a phone viewport", async ({ page }) => {
    test.slow();
    await phone(page);
    // The admin session sees every seeded profile — sick chips, supplement
    // rollups, goals — the densest household rendering the suite can produce.
    await page.goto("/household");
    await expect(
      page.getByRole("heading", { name: "Household" })
    ).toBeVisible();
    await expect(page.getByTestId("household-card")).not.toHaveCount(0);
    // The dense variants provably rendered under the guard: a sick-line chip
    // (the seeded open illness episodes) and an attention rollup row.
    await expect(page.getByTestId("household-sick-chip")).not.toHaveCount(0);
    await expectNoClippedContent(page);
  });

  test("/upcoming: rows and action chips fit a phone viewport", async ({
    page,
  }) => {
    test.slow();
    await phone(page);
    await page.goto("/upcoming");
    await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    // At least one real item row rendered (the seeded appointments/doses), so
    // the guard runs against the chip-carrying rows, not an empty state.
    await expect(
      page.locator('[data-testid^="upcoming-item-"]')
    ).not.toHaveCount(0);
    await expectNoClippedContent(page);
  });

  test("/data: import feed (Review/Discard row) fits a phone viewport", async ({
    page,
  }) => {
    test.slow();
    await phone(page);
    await page.goto("/data");
    // The seeded ready import job renders the Review/Discard action row.
    await expect(page.getByRole("button", { name: "Review" })).toBeVisible();
    await expectNoClippedContent(page);
  });

  test("/settings/profile: settings sections fit a phone viewport", async ({
    page,
  }) => {
    test.slow();
    await phone(page);
    await page.goto("/settings/profile");
    await expect(
      page.getByRole("heading", { name: "Identity & localization" })
    ).toBeVisible();
    await expectNoClippedContent(page);
  });
});
