import { test, expect } from "@playwright/test";

// Dashboard redesign (issue #171): the Tier-1 "Needs attention" hero, the Tier-2
// household strip, and the data-aware onboarding empty state. Runs against the
// seeded DB as the bootstrap admin (storageState), who reaches every profile — so
// the household strip renders and a data-less profile (Sam Rivers, id 2: supplements
// only, no labs/appointments) exercises the empty-state CTA. Locators are scoped to
// <main> since the app shell (sidebar + mobile drawer) can double-render nav.
//
// Read-only by design where it counts: the hero/strip specs assert presence without
// mutating profile 1's suppression store (other specs read it). The empty-state spec
// switches the active profile in an ISOLATED, cookie-less context with its own fresh
// session, so it never touches the shared admin session other specs depend on.

test("the Needs attention hero renders with the seeded profile's items", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const hero = main.getByTestId("needs-attention");
  await expect(hero).toBeVisible();

  // Profile 1 has structural attention (an overdue appointment, low supply, care
  // plan) that no other spec suppresses, so the count badge and at least one item
  // are present — the hero is not in its "all clear" state.
  await expect(hero.getByTestId("attention-count")).toBeVisible();
  await expect(
    hero.locator('[data-testid^="attention-item-"]').first()
  ).toBeVisible();
});

test("the household strip shows the caregiver's other profiles", async ({
  page,
}) => {
  await page.goto("/");
  const strip = page.getByRole("main").getByTestId("household-strip");
  // The bootstrap admin reaches 2+ profiles, so the strip renders (single-profile
  // logins never see it — same gate as the Household nav entry).
  await expect(strip).toBeVisible();
  // Sam Rivers is profile 2 — a chip links through to switch-and-view it.
  await expect(strip.getByTestId("household-chip-2")).toBeVisible();
});

test("a data-less profile shows an onboarding empty-state CTA", async ({
  browser,
}) => {
  // Fresh, cookie-less context + its own admin session, so switching the active
  // profile here can't disturb the shared storageState session other specs use.
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  try {
    await page.goto("/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "e2e-admin-pass");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 20_000,
    });

    // Switch to Sam Rivers (profile 2 — supplements only, no labs/appointments) via
    // its household chip. The data-aware Recent-labs / Next-appointment widgets then
    // render their onboarding CTA instead of a blank card. Wait on the user-menu
    // trigger naming the new profile — the definitive switch signal (we're already
    // on "/", so a URL wait could resolve before the action round-trips).
    await page.goto("/");
    await page.getByRole("main").getByTestId("household-chip-2").click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Sam Rivers"
    );

    await expect(
      page.getByRole("main").getByTestId("widget-empty").first()
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});
