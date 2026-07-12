import { test, expect } from "@playwright/test";
import { followLink } from "./nav";

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

test("the card is a strict act-now subset: this-week + later scheduled items live only on Upcoming (issue #524)", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.getByRole("main").getByTestId("needs-attention");
  await expect(hero).toBeVisible();

  // The card is the triage glance — overdue + due-today + the "something's off"
  // signals only. The seeded +4-day "Echocardiogram" (This week) and +45-day
  // "Physical exam" (Later) are scheduled work with runway, so they are NOT on the
  // card (the old hero pulled in the This-week band; #524 narrows it to act-now).
  await expect(
    hero.getByRole("link", { name: "Echocardiogram", exact: true })
  ).toHaveCount(0);
  await expect(
    hero.getByRole("link", { name: "Physical exam", exact: true })
  ).toHaveCount(0);

  // Both still live on the Upcoming page (the planning view is complete + date-
  // ordered), under their calendar bands — the card is a strict subset of it, so a
  // remainder link points the way. Its copy names what it HIDES ("scheduled
  // later"), not a bare "+N more in Upcoming", so it can't be confused with a
  // per-band cap-overflow link (issue #538).
  const remainder = hero.getByTestId("attention-more-upcoming");
  await expect(remainder).toBeVisible();
  await expect(remainder).toContainText("scheduled later");
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("link", { name: "Echocardiogram", exact: true })
  ).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Physical exam", exact: true })
  ).toBeVisible();
});

test("a goal deadline item links to the Training → Goals tab, not the removed /goals route (issue #283)", async ({
  page,
}) => {
  // Click from the Upcoming page: the hero shows the same item with the same
  // href (one computation), but its per-severity cap makes WHICH rows render
  // seed-dependent, while Upcoming lists every item uncapped.
  await page.goto("/upcoming");
  const goalLink = page
    .getByRole("main")
    .getByRole("link", { name: "Reach 74 kg", exact: true });
  await followLink(page, goalLink, /\/training\?tab=goals/);

  // Lands on the real Training hub with the Goals tab selected — a real page,
  // not the pageless /goals directory that 404'd.
  await expect(page).toHaveURL(/\/training\?tab=goals/);
  await expect(
    page.getByRole("main").getByText("Reach 74 kg").first()
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
  // Profile 2 is "Riley (child)" (scripts/seed.ts creates it before
  // e2e/seed-events.ts runs, so its guarded "Sam Rivers" insert at id 2 is a
  // no-op) — a chip links through to switch-and-view it.
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

    // Switch to profile 2 — "Riley (child)" (growth data only, no labs or
    // appointments; the seed-events "Sam Rivers" insert is a no-op because
    // scripts/seed.ts's Riley already owns id 2) — via its household chip. The
    // data-aware Recent-labs / Next-appointment widgets then render their
    // onboarding CTA instead of a blank card. Wait on the user-menu trigger
    // naming the new profile — the definitive switch signal (we're already on
    // "/", so a URL wait could resolve before the action round-trips).
    await page.goto("/");
    await page.getByRole("main").getByTestId("household-chip-2").click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    await expect(
      page.getByRole("main").getByTestId("widget-empty").first()
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});
