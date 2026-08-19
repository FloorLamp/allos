import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_ROUTINE,
  E2E_MEMBER_PASSWORD,
  ROUTINE_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #740 — the routine-aware "Today's session" card on the Training overview.
// Driven as the dedicated routine fixture login (an ADULT profile with an ACTIVE
// Push/Pull/Legs routine at position 0 and NO recovery data, so today's routine
// session resolves and renders WITHOUT a rest override — see e2e/seed-events.ts).
//
//   1. The card renders the resolved day (Push) and its filled slate.
//   2. "Log this session" pre-fills the activity form (live mode) with the slate.
//
// The mid-session resume contract belongs to e2e/live-workout.spec.ts and the shared
// workoutOffer truth table. Repeating it through this card made these tests share a
// live editor and coupled their result to the previous test's teardown.

function clearRoutineActivities(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("foreign_keys = ON");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(ROUTINE_PROFILE) as { id: number } | undefined;
    if (!profile) throw new Error("routine fixture profile missing");
    db.prepare("DELETE FROM activities WHERE profile_id = ?").run(profile.id);
  } finally {
    db.close();
  }
}

test("Today's session card renders the resolved routine day (#740)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");

    const card = page.getByTestId("todays-session-card");
    await expect(card).toBeVisible();
    // Day 0 of the seeded PPL routine is Push.
    await expect(card.getByTestId("todays-session-title")).toHaveText(
      "Push day"
    );
    // The first slot fills with the first candidate the profile can do (owns no
    // equipment → no gating → the barbell bench press leads).
    await expect(
      card
        .getByTestId("todays-session-slot")
        .filter({ hasText: "Barbell Bench Press" })
    ).toBeVisible();
    // Cold start (no history): the prescription shows sets × rep range, no load.
    await expect(card.getByText("4 × 5–8").first()).toBeVisible(); // first-ok: several exercises in the scoped card share the 4×5–8 scheme — order-agnostic presence
    const actions = card.getByTestId("training-overview-actions");
    await expect(actions.getByTestId("log-this-session")).toBeVisible();
    await expect(
      actions.getByTestId("training-overview-log-activity")
    ).toBeVisible();
    await expect(
      actions.getByTestId("training-overview-start-workout")
    ).toHaveCount(0);
    await expect(actions.locator("button.btn")).toHaveCount(1);
  } finally {
    await page.context().close();
  }
});

test("'Log this session' pre-fills the activity form in live mode (#740)", async ({
  browser,
}) => {
  clearRoutineActivities();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");

    const card = page.getByTestId("todays-session-card");
    await expect(card).toBeVisible();
    await card.getByTestId("log-this-session").click();

    // Creation settles on the session's canonical page before the form is read.
    await page.waitForURL(/\/training\/activity\/\d+$/);
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await expect(
      page.getByPlaceholder(/What did you do/).first() // first-ok: the routine's first prefilled activity row
    ).toHaveValue("Barbell Bench Press");
  } finally {
    await page.context().close();
    clearRoutineActivities();
  }
});
