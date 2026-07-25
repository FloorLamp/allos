import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledCheck } from "./helpers";
import {
  E2E_LOGIN_HH_ROUND,
  E2E_MEMBER_PASSWORD,
  HH_ROUND_WARD_PROFILE,
  HH_ROUND_SHADOW_PROFILE,
} from "./fixture-logins";

// The household dose round's settings card (#1459 §5) on Settings → Notifications.
// The message building, access rule and button handling are covered by the pure and
// DB tiers (lib/__tests__/household-round-format.test.ts,
// lib/__db_tests__/household-round.test.ts) — no Telegram send happens here. What only
// a browser can prove is that the card RENDERS, that its member checklist respects
// access, and that a tick round-trips through the real Server Action to SQLite.
//
// Runs on its OWN fixture login (#868): the caregiver's own_profile_id is what makes
// the round offerable, the ward is WRITE-granted and the shadow is READ-only, so one
// render exercises the access rule in both directions. The spec persists a real
// subscription, which is exactly why it must not share a profile with another spec.
//
// The "Send test" button is deliberately NOT clicked: a dispatch with no configured
// channel touches the GLOBAL delivery-health marker that notify-delivery-error.spec
// asserts on.
test.describe("Household dose round settings", () => {
  test("offers only write-accessible members and persists the subscription", async ({
    browser,
  }) => {
    const member = await loginAs(browser, {
      username: E2E_LOGIN_HH_ROUND,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");

      const card = member.getByTestId("household-round-card");
      await expect(card).toBeVisible();

      // The checklist is the §1 offer set: the WRITE-granted ward is offered; the
      // READ-only profile never is (the round confirms doses, and a read grant may
      // never write). The caregiver's own profile is absent too — a round is about
      // other people.
      const members = card.getByTestId("household-round-members");
      await expect(members).toContainText(HH_ROUND_WARD_PROFILE);
      await expect(members).not.toContainText(HH_ROUND_SHADOW_PROFILE);

      // Enable, then tick the ward. settledCheck waits for hydration before toggling
      // (a pre-hydration toggle reverts and the autosave writes stale state, #1188)
      // and is idempotent, so this drives to a known state without assuming the
      // entry one — a --repeat-each run re-enters with the previous run's writes.
      const enable = card.getByTestId("household-round-enabled");
      await settledCheck(member, enable, true);

      const wardBox = members
        .getByRole("checkbox")
        .and(members.locator("input:not([disabled])"))
        .first(); // first-ok: this spec's DEDICATED fixture offers exactly one member
      await settledCheck(member, wardBox, true);

      // Reload: the toggle and the tick came back from SQLite, not local state.
      await member.reload();
      const reloaded = member.getByTestId("household-round-card");
      await expect(
        reloaded.getByTestId("household-round-enabled")
      ).toBeChecked();
      await expect(
        reloaded
          .getByTestId("household-round-members")
          .getByRole("checkbox")
          .first() // first-ok: same single offered member as above
      ).toBeChecked();

      // Unsubscribing round-trips too — and the reload is what proves the OFF write
      // actually landed before this page closes, which is also what leaves the
      // fixture unsubscribed for the next run (an autosave awaited only in the
      // browser can lose its POST to the close).
      await settledCheck(
        member,
        reloaded.getByTestId("household-round-enabled"),
        false
      );
      await member.reload();
      await expect(
        member
          .getByTestId("household-round-card")
          .getByTestId("household-round-enabled")
      ).not.toBeChecked();
    } finally {
      await member.close();
    }
  });
});
