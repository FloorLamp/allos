import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { followLink, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_SETUP_HEALTH,
  E2E_MEMBER_PASSWORD,
  SETUP_HEALTH_GAP_MED,
  SETUP_HEALTH_GAP_PROFILE,
  SETUP_HEALTH_OK_PROFILE,
  SETUP_HEALTH_QUIET_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Per-member SETUP HEALTH on the Household board (issue #2173), in a browser.
//
// A profile could build reminders every day and deliver them to nobody, silently,
// forever — the tick treats "no channel" as a non-error, so there was no log line, no
// health signal and no UI note anywhere. What only a browser can prove is that the
// state now RENDERS on the surface every login that can fix it already visits, that
// each line carries a CTA that goes somewhere useful, and that the one line a
// dismissal must never silence is not even offered a dismiss control.
//
// Other tiers own the rest: the predicate matrix and the episode key
// (lib/__tests__/household-setup.test.ts), and the four-profile household with its
// "a grant clears ONLY the unroutable line / a dose clears ONLY the undosed line"
// regression (lib/__db_tests__/household-setup.test.ts).
//
// SPEC-OWNED FIXTURE (#2353). A setup row is a DERIVED VERDICT over a whole profile's
// configuration, so asserting one against a shared profile would be an exact-count
// assertion in disguise: any neighbour that added a dose, an onboarding row or a
// notification channel would flip it, on whichever PR happened to reshard. This spec
// signs in as its own caregiver login with three profiles nothing else writes.

function fixtureIds(): { okId: number; gapId: number; quietId: number } {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string) =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    return {
      okId: idOf(SETUP_HEALTH_OK_PROFILE),
      gapId: idOf(SETUP_HEALTH_GAP_PROFILE),
      quietId: idOf(SETUP_HEALTH_QUIET_PROFILE),
    };
  } finally {
    db.close();
  }
}

// Whether THIS profile carries an enabled Home Assistant webhook — the one channel that
// needs no managing login and no instance-level configuration. Read straight from
// profile_settings, because it is the fact the instance gate below turns on.
function hasHomeAssistantWebhook(profileId: number): boolean {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      (
        db
          .prepare(
            "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'ha_notify_enabled'"
          )
          .get(profileId) as { value?: string } | undefined
      )?.value === "1"
    );
  } finally {
    db.close();
  }
}

// Drop any suppression this spec's dismiss test wrote, so a --repeat-each run (or a
// retry) starts from the offered state again. Fixture ownership: only this spec ever
// writes an upcoming_dismissals row for the QUIET profile.
function resetQuietDismissal(quietId: number): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'household-setup:%'"
    ).run(quietId);
  } finally {
    db.close();
  }
}

test.describe("member setup health on /household (#2173)", () => {
  test("the unroutable member's card names the gap and links a fix; a routable member has no setup row", async ({
    browser,
  }) => {
    const { okId, gapId } = fixtureIds();
    // THE INSTANCE GATE (#2362 ruling) is a fact about the SERVER, not about the member.
    // GAP has no channel technology of its own — no webhook, and no login in its edge set
    // with a channel — and its card below still names the gap, because a SIBLING profile
    // on this instance (the OK member's webhook) is configured. A per-profile gate would
    // have silenced exactly this card; a fold over profiles ("they are all unroutable,
    // so stay quiet") would have silenced it too, since OK carries no setup row at all.
    expect(hasHomeAssistantWebhook(okId)).toBe(true);
    expect(hasHomeAssistantWebhook(gapId)).toBe(false);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SETUP_HEALTH,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/household");

    const gapCard = page.locator(
      `[data-testid="household-card"][data-profile-id="${gapId}"]`
    );
    await expect(gapCard).toBeVisible();
    const setup = gapCard.getByTestId("household-setup");
    await expect(setup).toBeVisible();

    // The unroutable line, with the profile's content deciding its band — a `should`
    // supplement bands at `action`, in the attention model's EXISTING vocabulary.
    const unroutable = setup.locator('[data-check="unroutable"]');
    await expect(unroutable).toBeVisible();
    await expect(unroutable.getByTestId("household-setup-title")).toHaveText(
      "Reminders reach no one"
    );
    await expect(unroutable).toContainText("no channel configured");

    // The undosed line is its own row on the same card — an active, scheduled-shaped
    // medication that can never be due.
    const undosed = setup.locator('[data-check="undosed-items"]');
    await expect(undosed).toBeVisible();
    await expect(undosed).toContainText(SETUP_HEALTH_GAP_MED);

    // Constraint 3: no dismiss control is offered at all while the member is
    // unroutable — a standing "this profile is unroutable" dismissal must not exist.
    await expect(setup.getByTestId("household-setup-dismiss")).toHaveCount(0);

    // The routable member (a profile-scoped Home Assistant webhook carries it) renders
    // no setup row: the board is quiet when the setup is healthy.
    const okCard = page.locator(
      `[data-testid="household-card"][data-profile-id="${okId}"]`
    );
    await expect(okCard).toBeVisible();
    await expect(okCard.getByTestId("household-setup")).toHaveCount(0);

    // The channel CTA is a login-scoped route, so it is an ordinary LINK that
    // navigates without a profile switch (contrast the member-scoped CTA below, which
    // posts a switch first).
    await followLink(
      page,
      unroutable.getByTestId("household-setup-cta"),
      /\/settings\/notifications/
    );
    await page.close();
  });

  test("the notifications page says it out loud, where someone would configure it", async ({
    browser,
  }) => {
    const { gapId } = fixtureIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SETUP_HEALTH,
      password: E2E_MEMBER_PASSWORD,
    });
    // Switch to the unroutable member first — the note is about the ACTIVE profile.
    await page.goto("/household");
    const gapCard = page.locator(
      `[data-testid="household-card"][data-profile-id="${gapId}"]`
    );
    await expect(gapCard).toBeVisible();
    await settledClick(page, gapCard.getByTestId("household-open"));

    await page.goto("/settings/notifications");
    const note = page.getByTestId("notify-unroutable");
    await expect(note).toBeVisible();
    await expect(note).toContainText(
      "Nothing receives this profile's notifications"
    );
    await page.close();
  });

  test("a member-scoped CTA switches to that member and lands on the item's dose editor", async ({
    browser,
  }) => {
    const { gapId } = fixtureIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SETUP_HEALTH,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/household");
    const gapCard = page.locator(
      `[data-testid="household-card"][data-profile-id="${gapId}"]`
    );
    const undosed = gapCard.locator('[data-check="undosed-items"]');
    await expect(undosed).toBeVisible();
    await settledClick(page, undosed.getByTestId("household-setup-cta"));
    // The destination is re-derived server-side from the check id — never posted — so
    // this lands on the ONE undosed medication's own edit form.
    await expect(page).toHaveURL(/\/medications\/\d+\?action=edit/);
    await page.close();
  });

  test("a never-onboarded, all-inactive member is dismissible, and the dismissal holds", async ({
    browser,
  }) => {
    const { quietId } = fixtureIds();
    resetQuietDismissal(quietId);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SETUP_HEALTH,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/household");
    const quietCard = page.locator(
      `[data-testid="household-card"][data-profile-id="${quietId}"]`
    );
    const setup = quietCard.getByTestId("household-setup");
    await expect(setup).toBeVisible();
    // Never-started onboarding used to render exactly like complete — no checklist, no
    // resume card, nothing anywhere.
    await expect(
      setup
        .locator('[data-check="never-onboarded"]')
        .getByTestId("household-setup-title")
    ).toHaveText("Setup never started");
    // SUGGEST-only: the roster question offers no write at all.
    const roster = setup.locator('[data-check="roster-inactive"]');
    await expect(roster).toBeVisible();
    await expect(roster.getByTestId("household-setup-cta")).toHaveCount(0);

    // Nothing would send from an all-inactive roster, so this member is quiet rather
    // than unroutable — which is exactly why its row may be dismissed.
    await expect(setup.locator('[data-check="unroutable"]')).toHaveCount(0);
    await settledClick(page, setup.getByTestId("household-setup-dismiss"));
    await expect(quietCard.getByTestId("household-setup")).toHaveCount(0);
    await page.close();
  });
});
