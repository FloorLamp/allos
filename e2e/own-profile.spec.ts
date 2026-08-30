import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { deleteActivityFromForm, hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_OWN,
  OWN_SELF_PROFILE,
  OWN_OTHER_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { assertNoStrandedDrafts } from "./shared-profile-guard";

// Own-profile link + not-self write affordances + login identity (issue #1013).
// Spec-OWNED fixtures (E2E_LOGIN_OWN granted two adult profiles, own_profile_id →
// the SELF profile, each with a due dose + a weigh-in — see e2e/seed-events.ts), on a
// fresh cookie-less context so the switch/weigh-in/workout writes never touch the
// admin storageState.
//
// IT READS LABELS, BUT STARTING THE WORKOUT IS A WRITE (#3290). This comment used to
// say the spec "only READS affordance labels (no confirm/finish writes)", and that is
// what let the first test start a live session and close the context on top of it. A
// started, unended activity is what `getWorkoutPresence` reads as an ACTIVE workout,
// so the fixture profile stayed haunted for the rest of the worker's run — invisible,
// because the standing guard (e2e/shared-profile-guard.ts) reads profile 1 only and
// these are dedicated profiles. The session is now discarded and the absence proved
// against the DATABASE once the context is gone; see the test.
//
// Uses the #1096 switch-to-<id> testid to change the acting profile (NOT the
// accessible-name lookup, which collides with the view toggles — that was just
// fixed; don't reintroduce it).

// Resolve the two fixture profile ids from the isolated e2e DB (short-lived
// connection, busy timeout) so the switch testid can target the OTHER profile.
function ownProfileIds(): { selfId: number; otherId: number } {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string): number =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    return { selfId: idOf(OWN_SELF_PROFILE), otherId: idOf(OWN_OTHER_PROFILE) };
  } finally {
    db.close();
  }
}

// Open the switcher panel past the pre-hydration disable gate (#830).
async function openProfileSwitcher(page: Page): Promise<void> {
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
}

test.describe("Own-profile + not-self write affordances (issue #1013)", () => {
  test("live workout editor names the not-self subject", async ({
    browser,
  }) => {
    test.slow();
    const { otherId } = ownProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_OWN,
      password: E2E_MEMBER_PASSWORD,
    });

    // Act as the OTHER profile (not the login's own).
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`switch-to-${otherId}`));
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      OWN_OTHER_PROFILE
    );

    // Start a live workout — the fastest-tapping surface. Its Finish button names
    // whose session it is (both fixture profiles are adults → live mode available).
    //
    // THE SESSION IS A ROW FROM THE MOMENT IT STARTS, so everything below it is in a
    // try/finally: the discard has to run on the failure path too, which is the exit
    // path a leak actually takes.
    try {
      await page.goto("/training?tab=log");
      await hydratedClick(
        page,
        page.getByRole("main").getByTestId("start-workout")
      );
      await expect(page.getByTestId("live-workout-panel")).toBeVisible();
      await expect(page.getByTestId("finish-workout")).toHaveText(
        `Finish workout — ${OWN_OTHER_PROFILE}`
      );

      // Discard it through the settled helper (#3267/#3287): the row is gone when the
      // "Activity deleted." toast lands, never when the panel stops rendering. This
      // spec has no shared-profile guard behind it to catch the difference.
      await deleteActivityFromForm(page);
    } finally {
      await page.context().close();
      // This spec owns the named fixture profile outright, so the shared assertion
      // may safely repair it after the context stops moving the database. The helper
      // verifies that ownership precondition before deleting anything.
      assertNoStrandedDrafts(workerDbPath(), {
        kind: "spec-owned",
        profileId: otherId,
        profileName: OWN_OTHER_PROFILE,
        ownerLogin: E2E_LOGIN_OWN,
      });
    }
  });

  test("mobile drawer carries the same 'Signed in as' identity", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_OWN,
      password: E2E_MEMBER_PASSWORD,
    });
    // Mobile viewport → the sidebar is a drawer; the shared SidebarContent means the
    // same overlay (never a hand-mirrored hidden md:* branch).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // Open the mobile drawer past the pre-hydration More swallow (#500): re-tap
    // until the drawer renders (idempotent — the button only opens). expect.poll, not
    // toPass/waitForTimeout.
    const openBtn = page.getByTestId("dock-slot-more");
    const drawer = page.locator("div.fixed.inset-0.z-40");
    await expect
      .poll(
        async () => {
          if (!(await drawer.isVisible()))
            await openBtn.click().catch(() => {});
          return drawer.isVisible();
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    // "Signed in as <username>" lives at the drawer's BOTTOM beside logout since
    // #1801 — no menu to open. Scope to the drawer: the desktop aside renders the
    // same footer at every width, hidden below `md`.
    await expect(drawer.getByTestId("signed-in-as")).toContainText(
      E2E_LOGIN_OWN
    );

    await page.context().close();
  });
});
