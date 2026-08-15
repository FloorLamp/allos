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

  // Clean up. SETTLE on the session's page first (#2870 step 3): a close that
  // beats the create-at-start round-trip strands the row when the page dies
  // before the late-create self-discard can run — the leak that made the next
  // test see "resume". Then close: the blank-load slate can't save, so the
  // blocked-close prompt appears; answering it abandons the empty row and
  // returns to the hub.
  await page.waitForURL(/\/training\/activity\/\d+$/);
  await page.keyboard.press("Escape");
  const closeAnyway = page
    .getByTestId("confirm-dialog")
    .getByRole("button", { name: "Close anyway" });
  await closeAnyway.waitFor({ state: "visible", timeout: 3000 }).catch(() => {
    /* closed without a prompt — nothing unsaved */
  });
  if (await closeAnyway.isVisible().catch(() => false))
    await closeAnyway.click();
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
  await cleanUpClosedSession(page);
});

// After closing a live session, the row's fate is bimodal: an EMPTY session
// abandons itself and redirects to the hub; one whose slate managed to save is
// KEPT and the tab stays on its page. Clean up whichever happened, so the
// fixture profile is left untouched either way.
async function cleanUpClosedSession(p: Page) {
  const redirected = await p
    .waitForURL(/\/training(\?.*)?$/, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (redirected) return; // empty session — the abandonment already cleaned up
  await p.getByTestId("activity-page-edit").click();
  await expect(
    p.getByTestId("activity-page-dock").getByTestId("activity-form")
  ).toBeVisible();
  await p.getByRole("button", { name: "Delete", exact: true }).click();
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(p.getByTestId("activity-form")).toHaveCount(0);
}

test("mid-session, 'Log this session' resumes instead of restarting (#1893)", async () => {
  await page.goto("/training?tab=overview");

  const card = page.getByTestId("todays-session-card");
  const control = card.getByTestId("log-this-session");
  await expect(control).toHaveAttribute("data-workout-offer", "start");
  await expect(control).toHaveText("Log this session");
  await control.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  // #2870 step 3: starting stands the tab on the session's canonical page.
  await page.waitForURL(/\/training\/activity\/\d+$/);

  await page.getByTestId("minimize-workout").click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // Back on Overview — SOFT navigation, the pocketed form must stay mounted.
  // The control names the write it will now perform — the routine day is still
  // one tap away once the running session is finished.
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Training" })
    .click();
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
  // The routine slate's blank loads can't save, and the session owns a row
  // (create-at-start), so closing prompts — answer it. Nothing persisted, so
  // the close then ABANDONS the empty row (#2870 step 3) and returns to the
  // hub: the fixture profile is left untouched with no manual delete.
  const closeAnyway = page
    .getByTestId("confirm-dialog")
    .getByRole("button", { name: "Close anyway" });
  await closeAnyway.waitFor({ state: "visible", timeout: 3000 }).catch(() => {
    /* already closed without a prompt — nothing unsaved */
  });
  if (await closeAnyway.isVisible().catch(() => false))
    await closeAnyway.click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
  await cleanUpClosedSession(page);
});
