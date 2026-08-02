import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_ROUTINE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Issue #740 — the routine-aware "Today's session" card on the Training overview.
// Driven as the dedicated routine fixture login (an ADULT profile with an ACTIVE
// Push/Pull/Legs routine at position 0 and NO recovery data, so today's routine
// session resolves and renders WITHOUT a rest override — see e2e/seed-events.ts).
//
//   1. The card renders the resolved day (Push) and its filled slate.
//   2. "Log this session" pre-fills the activity form (live mode) with the slate.
//   3. #1893: with a session already running the SAME control resumes it instead of
//      restarting — handing over the routine slate used to reset the live clock.

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
});

test.afterAll(async () => {
  await page.close();
});

test("Today's session card renders the resolved routine day (#740)", async () => {
  await page.goto("/training?tab=overview");

  const card = page.getByTestId("todays-session-card");
  await expect(card).toBeVisible();
  // Day 0 of the seeded PPL routine is Push.
  await expect(card.getByTestId("todays-session-title")).toHaveText("Push day");
  // The first slot fills with the first candidate the profile can do (owns no
  // equipment → no gating → the barbell bench press leads).
  await expect(
    card
      .getByTestId("todays-session-slot")
      .filter({ hasText: "Barbell Bench Press" })
  ).toBeVisible();
  // Cold start (no history): the prescription shows sets × rep range, no load.
  await expect(card.getByText("4 × 5–8").first()).toBeVisible(); // first-ok: several exercises in the scoped card share the 4×5–8 scheme — order-agnostic presence
});

test("'Log this session' pre-fills the activity form in live mode (#740)", async () => {
  await page.goto("/training?tab=overview");

  const card = page.getByTestId("todays-session-card");
  await expect(card).toBeVisible();
  await card.getByTestId("log-this-session").click();

  // The pre-filled slate opens in the live workout layout (#340: the same editor).
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  // The resolved day's lead exercise is present in the pre-filled form.
  await expect(page.getByText("Barbell Bench Press").first()).toBeVisible(); // first-ok: asserts the recommended lift renders — order-agnostic presence

  // Clean up: discard the draft so the fixture profile is left untouched. Nothing
  // was completed (no loads entered), so Escape closes without persisting a set;
  // fall back to a delete if the auto-saver created a row.
  await page.keyboard.press("Escape");
  const del = page.getByRole("button", { name: "Delete", exact: true });
  if (await del.isVisible().catch(() => false)) {
    await del.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
  }
});

test("mid-session, 'Log this session' resumes instead of restarting (#1893)", async () => {
  await page.goto("/training?tab=overview");

  const card = page.getByTestId("todays-session-card");
  const control = card.getByTestId("log-this-session");
  await expect(control).toHaveAttribute("data-workout-offer", "start");
  await expect(control).toHaveText("Log this session");
  await control.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  await page.getByTestId("minimize-workout").click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // The control names the write it will now perform — the routine day is still one tap
  // away once the running session is finished.
  await expect(control).toHaveAttribute("data-workout-offer", "resume");
  await expect(control).toHaveText("Resume workout");

  await control.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.getByTestId("minimize-workout").click();
  await expect(dock).toBeVisible();
  // The epoch pin: openSession reopened the running session, it did not restart it.
  await expect(dock).toHaveAttribute("data-start-epoch", startedAt!);

  await page.getByTestId("workout-dock-open").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dock).toHaveCount(0);
  const leftover = page.getByRole("button", { name: "Delete", exact: true });
  if (await leftover.isVisible().catch(() => false)) {
    await leftover.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
  }
});
