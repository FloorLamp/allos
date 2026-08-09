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
// tunable set and the notable predicates (lib/__tests__/digest-tune.test.ts), the
// login-scoped write and what a demotion actually does to a rendered digest — including
// the #1797 floor pin, that a tuned-down `labs` still delivers its flagged result
// (lib/__db_tests__/digest-tune.test.ts). The digest is a NOTIFICATION and has no
// browser surface, so those assertions live where the message exists. What only a
// browser can prove is that the mirror RENDERS whatever the registry says — including
// the categories #1797 opened up — and that a tick round-trips through the real Server
// Action to SQLite.
//
// #1868 §3 collapsed the card: the always-rendered state is now a one-line summary, and
// the list sits behind a disclosure. Each case opens it first, and the first case also
// pins that the collapsed line tells the truth about what is stored.
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

      // Collapsed by default (#1868 §3) — the summary is what always renders.
      const summary = section.getByTestId("digest-tune-summary");
      await expect(summary).toBeVisible();
      await expect(section.getByTestId("digest-tune-list")).not.toBeVisible();

      await section.getByTestId("digest-tune-disclosure").click();
      const card = section.getByTestId("digest-tune-list");
      await expect(card).toBeVisible();
      // The vocabulary comes from the shared registry, so the mirror can't drift from
      // the keyboard: every collector category plus the digest's own sections.
      await expect(card).toContainText("Sleep");
      await expect(card).toContainText("Check-in");
      // #1797 opened the launch set's two exclusions. They render because the registry
      // says so — nothing in this component decides which categories exist.
      await expect(card).toContainText("Lab results");
      await expect(card).toContainText("Activities");
      // #2379's nutrition line registered as a category too, so it renders here for
      // the same reason — the registry says so, not this component.
      await expect(card).toContainText("Nutrition");
      // "Demote" is not "mute": the card states what still gets through.
      await expect(card).toContainText("out-of-range reading still appears");
      await expect(card).toContainText("personal record still appears");
      await expect(card).toContainText("measured from tracked intake");
      // And for labs it states the floor plainly — this toggle cannot hide a flagged
      // result, which is the whole reason it is safe to offer.
      await expect(card).toContainText("never hides one");

      // Drive to a known state rather than assuming the entry one — a --repeat-each
      // run re-enters with the previous run's writes.
      const scope = section.getByTestId("digest-tune-sleep");
      await settledCheckSave(member, scope, true, section);
      // The collapsed line states what is actually stored, by name — the whole reason a
      // disclosure is honest here rather than hiding the state.
      await expect(summary).toContainText("Sleep");

      // Reload: the preference came back from SQLite, not from local state.
      await member.reload();
      const reloaded = member.getByTestId("notify-digest-tune");
      await expect(reloaded.getByTestId("digest-tune-summary")).toContainText(
        "Sleep"
      );
      await reloaded.getByTestId("digest-tune-disclosure").click();
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
      const after = member.getByTestId("notify-digest-tune");
      // State-relative: this case owns `sleep` only, so it asserts sleep left the
      // summary rather than that the whole set is empty.
      await expect(after.getByTestId("digest-tune-summary")).not.toContainText(
        "Sleep"
      );
      await after.getByTestId("digest-tune-disclosure").click();
      await expect(after.getByTestId("digest-tune-sleep")).not.toBeChecked();
    } finally {
      await member.close();
    }
  });

  test("tunes the categories #1797 opened, and they persist independently", async ({
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
      await section.getByTestId("digest-tune-disclosure").click();

      // Drive both to a known state — the login persists across a --repeat-each run.
      await settledCheckSave(
        member,
        section.getByTestId("digest-tune-labs"),
        true,
        section
      );
      await settledCheckSave(
        member,
        section.getByTestId("digest-tune-activities"),
        true,
        section
      );

      await member.reload();
      const reloaded = member.getByTestId("notify-digest-tune");
      await reloaded.getByTestId("digest-tune-disclosure").click();
      await expect(reloaded.getByTestId("digest-tune-labs")).toBeChecked();
      await expect(
        reloaded.getByTestId("digest-tune-activities")
      ).toBeChecked();
      // A toggle writes ONE category: the neighbours this spec never touched are
      // still on.
      await expect(
        reloaded.getByTestId("digest-tune-vitals")
      ).not.toBeChecked();

      // Reverse one and leave the other — the stored form is a set, not a mode.
      await settledCheckSave(
        member,
        reloaded.getByTestId("digest-tune-labs"),
        false,
        reloaded
      );
      await member.reload();
      const after = member.getByTestId("notify-digest-tune");
      await after.getByTestId("digest-tune-disclosure").click();
      await expect(after.getByTestId("digest-tune-labs")).not.toBeChecked();
      await expect(after.getByTestId("digest-tune-activities")).toBeChecked();

      // Leave the fixture login as we found it.
      await settledCheckSave(
        member,
        after.getByTestId("digest-tune-activities"),
        false,
        after
      );
    } finally {
      await member.close();
    }
  });
});
