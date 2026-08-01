import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledCheckSave } from "./helpers";
import { E2E_LOGIN_DIGEST_TUNE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Settings MIRROR of the digest's ⚙️ Tune control (#1714), on
// Settings → Notifications. One storage, two surfaces: the message carries the escape
// hatch where the annoyance is, and this page makes the same preferences
// discoverable, reversible off-Telegram, and visible to someone auditing why their
// digest looks thin.
//
// What the other tiers already own, and this spec therefore does not re-assert: the
// notable predicates and the floor composition (lib/__tests__/digest-tune.test.ts),
// the login-scoped write and the demoted digest (lib/__db_tests__/digest-tune.test.ts),
// and the Telegram keyboard (same DB spec, driven through the real dispatcher). What
// only a browser can prove is that the mirror RENDERS the shared vocabulary and that a
// tick round-trips through the real Server Action to SQLite.
//
// Runs on its OWN fixture login (#868): the preference is LOGIN-scoped and persists,
// so sharing a login would thin another spec's session.
test.describe("Settings → Notifications: morning digest tuning", () => {
  test("lists the tunable categories and persists a demotion", async ({
    browser,
  }) => {
    const member = await loginAs(browser, {
      username: E2E_LOGIN_DIGEST_TUNE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");

      const section = member.getByTestId("notify-digest-tune");
      await expect(section).toBeVisible();
      // The scope line says whose preference this is — the mixed-tier page states
      // scope per section.
      await expect(section).toContainText("your login only");

      const card = section.getByTestId("digest-tune-list");
      await expect(card).toBeVisible();
      // The vocabulary comes from the shared registry, so the mirror can't drift from
      // the keyboard: sleep and the check-in are both tunable, labs never is.
      await expect(card).toContainText("Sleep");
      await expect(card).toContainText("Check-in");
      await expect(card).not.toContainText("Labs");
      // "Demote" is not "mute": the card states what still gets through.
      await expect(card).toContainText("out-of-range reading still appears");

      // Drive to a known state rather than assuming the entry one — a --repeat-each
      // run re-enters with the previous run's writes.
      const scope = section.getByTestId("digest-tune-sleep");
      await settledCheckSave(member, scope, true, section);

      // Reload: the preference came back from SQLite, not from local state.
      await member.reload();
      const reloaded = member.getByTestId("notify-digest-tune");
      await expect(reloaded.getByTestId("digest-tune-sleep")).toBeChecked();
      await expect(reloaded.getByTestId("digest-tune-mood")).not.toBeChecked();

      // And it is reversible from here — the whole point of the mirror.
      await settledCheckSave(
        member,
        reloaded.getByTestId("digest-tune-sleep"),
        false,
        reloaded
      );
      await member.reload();
      await expect(
        member
          .getByTestId("notify-digest-tune")
          .getByTestId("digest-tune-sleep")
      ).not.toBeChecked();
    } finally {
      await member.close();
    }
  });
});
