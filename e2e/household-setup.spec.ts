import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { switchToProfile } from "./family-helpers";
import {
  E2E_LOGIN_SETUP_HEALTH,
  E2E_MEMBER_PASSWORD,
  SETUP_HEALTH_GAP_PROFILE,
  SETUP_HEALTH_OK_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Unroutable reminders (issue #2173), in a browser.
//
// A profile could build reminders every day and deliver them to nobody, silently,
// forever — the tick treats "no channel" as a non-error, so there was no log line, no
// health signal and no UI note anywhere. What only a browser can prove is that the
// state RENDERS where someone would configure it: Settings → Notifications.
//
// Other tiers own the rest: the predicate matrix (lib/__tests__/household-setup.test.ts)
// and the four-profile household over the real schema
// (lib/__db_tests__/household-setup.test.ts).
//
// SPEC-OWNED FIXTURE (#2353). The verdict is DERIVED over a whole profile's
// configuration, so asserting one against a shared profile would be an exact-count
// assertion in disguise: any neighbour that added a dose or a notification channel
// would flip it. This spec signs in as its own caregiver login with profiles nothing
// else writes.

// Whether THIS profile carries an enabled Home Assistant webhook — the one channel that
// needs no managing login and no instance-level configuration. Read straight from
// profile_settings, because it is the fact the instance gate below turns on.
function hasHomeAssistantWebhook(profileName: string): boolean {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      (
        db
          .prepare(
            `SELECT s.value FROM profile_settings s
               JOIN profiles p ON p.id = s.profile_id
              WHERE p.name = ? AND s.key = 'ha_notify_enabled'`
          )
          .get(profileName) as { value?: string } | undefined
      )?.value === "1"
    );
  } finally {
    db.close();
  }
}

test("the notifications page says it out loud, where someone would configure it", async ({
  browser,
}) => {
  // THE INSTANCE GATE (#2362 ruling) is a fact about the SERVER, not about the member.
  // GAP has no channel technology of its own, and its note below still renders because
  // a SIBLING profile on this instance (the OK member's webhook) is configured.
  expect(hasHomeAssistantWebhook(SETUP_HEALTH_OK_PROFILE)).toBe(true);
  expect(hasHomeAssistantWebhook(SETUP_HEALTH_GAP_PROFILE)).toBe(false);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SETUP_HEALTH,
    password: E2E_MEMBER_PASSWORD,
  });
  // The note is about the ACTIVE profile.
  await switchToProfile(page, SETUP_HEALTH_GAP_PROFILE);
  await page.goto("/settings/notifications");
  const note = page.getByTestId("notify-unroutable");
  await expect(note).toBeVisible();
  await expect(note).toContainText(
    "Nothing receives this profile's notifications"
  );

  // The routable member (its own Home Assistant webhook carries it) says nothing.
  await switchToProfile(page, SETUP_HEALTH_OK_PROFILE);
  await page.goto("/settings/notifications");
  // The page has rendered for THAT profile before the absence is read.
  await expect(page.getByTestId("notify-channels")).toContainText(
    SETUP_HEALTH_OK_PROFILE
  );
  await expect(page.getByTestId("notify-unroutable")).toHaveCount(0);
  await page.close();
});
