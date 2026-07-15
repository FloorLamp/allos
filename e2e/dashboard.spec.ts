import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink } from "./nav";

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const AVAILABILITY_APPOINTMENT = "E2E dashboard availability visit";

function cleanupAvailabilityFixture() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM appointments WHERE title = ? AND profile_id = 2")
      .run(AVAILABILITY_APPOINTMENT);
    handle
      .prepare(
        "DELETE FROM profile_settings WHERE profile_id = 2 AND key = 'dashboard_layout'"
      )
      .run();
  } finally {
    handle.close();
  }
}

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

test("the streamlined grid combines goals and habits and caps observations", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");

  const goalsHabits = main.getByTestId("goals-habits");
  await expect(goalsHabits).toBeVisible();
  await expect(goalsHabits.getByText("Active goals")).toBeVisible();
  await expect(goalsHabits.getByText("Still to do this week")).toBeVisible();
  await expect(
    goalsHabits.getByTestId("goals-habits-sections")
  ).toHaveAttribute("data-layout", "split");
  await expect(
    goalsHabits.getByRole("link", { name: /Training goals/ })
  ).toHaveAttribute("href", "/training?tab=goals");
  await expect(
    goalsHabits.getByRole("link", { name: "Manage food habits →" })
  ).toHaveAttribute("href", "/nutrition");

  const observations = main.getByTestId("coaching-observations");
  if (await observations.isVisible()) {
    expect(
      await observations.getByTestId("coaching-observations-item").count()
    ).toBeLessThanOrEqual(2);
  }
});

test("recent labs keeps dates intact and makes every result direction explicit", async ({
  page,
}) => {
  await page.goto("/");
  const recentLabs = page
    .getByRole("main")
    .getByTestId("dashboard-widget-recent-labs");

  await expect(recentLabs).toHaveClass(/lg:col-span-3/);
  await expect(
    recentLabs.locator(
      '[aria-label="above target"], [aria-label="below target"]'
    )
  ).not.toHaveCount(0);
  await expect(
    recentLabs.getByTestId("recent-lab-status").filter({ hasText: "Abnormal" })
  ).toHaveCount(1);
  const firstDate = recentLabs.getByTestId("recent-lab-date").first();
  await expect(firstDate).toBeVisible();
  expect(
    await firstDate.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("nowrap");
  await expect(
    page.getByRole("main").getByTestId("dashboard-widget-healthspan-pillars")
  ).toHaveClass(/lg:col-span-3/);
  await expect(
    page.getByRole("main").getByTestId("dashboard-widget-weight-trend")
  ).toHaveClass(/lg:col-span-3/);
});

test("attention review signals expose an explicit primary action", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.getByRole("main").getByTestId("needs-attention");

  // The seeded newly-flagged result is the review-band representative under the
  // total cap. Its next step is explicit rather than inferred from the title.
  await expect(
    hero.getByRole("link", { name: "Review result", exact: true })
  ).toBeVisible();
});

test("attention rows move status and actions below content on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const row = page
    .getByRole("main")
    .getByTestId("needs-attention")
    .locator('[data-testid^="attention-item-"]')
    .first();
  const title = row.getByRole("link").first();
  const detail = row.getByTestId("attention-item-detail");
  const actions = row.getByTestId("attention-item-actions");
  await expect(detail).toBeVisible();
  await expect(actions).toBeVisible();

  expect(
    await title.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("normal");
  expect(
    await title.evaluate((element) => getComputedStyle(element).textOverflow)
  ).not.toBe("ellipsis");
  expect(
    await detail.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("normal");
  expect(
    await detail.evaluate((element) => getComputedStyle(element).textOverflow)
  ).not.toBe("ellipsis");

  const [titleBox, actionsBox] = await Promise.all([
    title.boundingBox(),
    actions.boundingBox(),
  ]);
  expect(titleBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.y).toBeGreaterThan(titleBox!.y);

  // Tablet widths still have limited horizontal room; truncation starts only at
  // the desktop breakpoint.
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(
    await title.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("normal");
  expect(
    await detail.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("normal");

  await page.setViewportSize({ width: 1280, height: 800 });
  expect(
    await title.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("nowrap");
  expect(
    await detail.evaluate((element) => getComputedStyle(element).whiteSpace)
  ).toBe("nowrap");
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

test("temporary appointment absence never becomes a saved hidden preference", async ({
  browser,
}) => {
  // Fresh, cookie-less context + its own admin session, so switching the active
  // profile here can't disturb the shared storageState session other specs use.
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  cleanupAvailabilityFixture();
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
    // Next appointment widget then stays out of the grid instead of rendering a
    // blank card. Wait on the user-menu trigger
    // naming the new profile — the definitive switch signal (we're already on
    // "/", so a URL wait could resolve before the action round-trips).
    await page.goto("/");
    await page.getByRole("main").getByTestId("household-chip-2").click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    await expect(
      page.getByRole("main").getByTestId("dashboard-widget-next-appointment")
    ).toHaveCount(0);

    // Customize still knows about the temporarily-unavailable widget, but labels
    // it as empty instead of folding that state into the user's hidden choices.
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Edit dashboard" }).click();
    const unavailable = main.getByTestId("dashboard-widget-next-appointment");
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText("Nothing to show right now");
    await main.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      main.getByRole("button", { name: "Edit dashboard" })
    ).toBeVisible();

    // Once data exists, the same preference makes the widget reappear. This is
    // the regression: the old save path persisted an absent appointment as hidden.
    await page.goto("/encounters");
    const upcoming = page.getByTestId("visits-upcoming");
    await upcoming.getByLabel("Reason / title").fill(AVAILABILITY_APPOINTMENT);
    await upcoming.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    await page.goto("/");
    const appointmentWidget = page
      .getByRole("main")
      .getByTestId("dashboard-widget-next-appointment");
    await expect(appointmentWidget).toBeVisible();
    await expect(appointmentWidget).toContainText(AVAILABILITY_APPOINTMENT);
  } finally {
    await ctx.close();
    cleanupAvailabilityFixture();
  }
});
