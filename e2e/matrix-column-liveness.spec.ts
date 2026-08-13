import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledCheck, settledClick, settledFill } from "./helpers";
import {
  E2E_LOGIN_MATRIX_INK,
  E2E_MEMBER_PASSWORD,
  MATRIX_INK_PROFILE,
} from "./fixture-logins";

// Matrix column liveness (#2565 part B) — the grid stops stating intent while staying
// silent about outcome.
//
// Before this, every routing cell rendered at FULL INK whether or not its channel could
// carry anything: on a fresh instance ~56 boxes read "checked" identically to boxes that
// would actually be sent, under a header whose only disclosure was small grey text.
//
// What only a browser can prove, and what this case pins:
//
//   1. A channel that cannot deliver renders a DEAD column — the state in WORDS, in the
//      same header slot a live column uses.
//   2. A kept tick in that column renders GHOST and an untick renders OFF, at the same
//      moment, in the same column. That inequality is the whole feature: a preference
//      waiting on one setup step must never look like one the user turned off.
//   3. The ghost is still a real, ENABLED checkbox with the state in its accessible
//      name — the deceptive success here is a calmer page whose controls have quietly
//      become unreachable or unreadable, so reachability is asserted, not assumed.
//   4. Configuring the channel later brings the stored preferences back LIVE, both the
//      on ones and the off one. Liveness is a render; it writes nothing.
//   5. A dead column says WHOSE setup step is missing. This page is deliberately
//      mixed-tier and "not set up" meant three different obligations; the note names
//      the PROFILE by name for a profile-owned channel, which is what keeps the tiers
//      legible instead of flattened.
//
// The pure decision (including the tier-ordering and the exact sentences) is pinned in
// lib/__tests__/matrix-liveness.test.ts.
//
// Runs on its OWN fixture login + profile. The Home Assistant column is the only one
// whose liveness this spec can own end to end: Telegram, Web Push and Email all depend
// on instance-wide config that neighbouring specs configure and reset mid-run. Its
// precondition is an ABSENCE (no webhook), so the spec drives that absence itself
// rather than trusting the seed, and it leaves the channel disabled as it found it —
// which is also the #1025 rule (a persisted webhook must never sit on a profile a
// temperature log could dispatch to).
test.describe("Matrix column liveness", () => {
  test("a channel that cannot deliver renders a dead column, keeps its ticks, and comes back live once it is set up", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_MATRIX_INK,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      const kinds = member.getByTestId("notification-kinds");
      await expect(kinds).toBeVisible();

      const setHaEnabled = async (on: boolean) => {
        await settledCheck(member, member.getByTestId("ha-enable"), on);
        if (on) {
          await settledFill(
            member,
            member.getByTestId("ha-webhook-url"),
            "http://homeassistant.local:8123/api/webhook/allos-matrix-ink"
          );
        }
        // The card is an explicit-submit record form, so the save button's POST is the
        // synchronisation point — a reload issued off the optimistic paint can be
        // answered ahead of the write it is meant to verify.
        await settledClick(member, member.getByTestId("ha-save"));
        await member.reload();
      };

      // Same optimistic-flip re-click discipline the matrix cases in settings-ia.spec.ts
      // document: a routing cell fires its action from a CLIENT onChange, so a click
      // landing in the hydration window is silently swallowed with no navigation to
      // follow (#830). Re-click until the optimistic flip proves onChange fired, then
      // wait for the box to re-enable, which proves the save round trip completed.
      const setCell = async (testid: string, to: boolean) => {
        const cell = member.getByTestId(testid);
        await expect(async () => {
          await cell.click();
          await expect(cell).toBeChecked({ checked: to });
        }).toPass(); // topass-ok: re-click the routing cell until the optimistic flip proves onChange fired — "my click landed" is non-atomic with no navigation to follow (#830)
        await expect(cell).toBeEnabled();
      };

      // ── The absence this case needs, owned rather than assumed ──────────────
      await setHaEnabled(false);

      const state = member.getByTestId("matrix-column-state-ha");
      await expect(state).toHaveText("not set up");
      await expect(state).toHaveAttribute("data-column-state", "not-set-up");

      // A live column states its state in the SAME slot: the disclosure is one of two
      // states, not an exception that only appears on failure.
      const kept = member.getByTestId("matrix-cell-ha-refill");
      const turnedOff = member.getByTestId("matrix-cell-ha-weekly-recap");

      // Drive both cells to a known state — a --repeat-each run re-enters with the
      // previous run's writes.
      if (!(await kept.isChecked()))
        await setCell("matrix-cell-ha-refill", true);
      if (!(await turnedOff.isChecked()))
        await setCell("matrix-cell-ha-weekly-recap", true);

      // ── (1)(2)(3) The dead column: ghost ≠ off, and the ghost is reachable ──
      await expect(kept).toBeChecked();
      await expect(kept).toHaveAttribute("data-ink", "ghost");
      await expect(kept).toBeEnabled();
      await expect(kept).toHaveAttribute(
        "aria-label",
        "Refill nudges to Home Assistant — kept, waiting on this channel's setup"
      );

      await setCell("matrix-cell-ha-weekly-recap", false);
      // Both inks, in the same column, at the same moment: a kept preference and a
      // turned-off one are not the same mark.
      await expect(turnedOff).toHaveAttribute("data-ink", "off");
      await expect(kept).toHaveAttribute("data-ink", "ghost");

      // ── (5) Whose setup step is missing, named by tier ──────────────────────
      const notes = member.getByTestId("matrix-setup-notes");
      await expect(notes).toContainText(
        `Home Assistant isn’t set up for ${MATRIX_INK_PROFILE} yet — its card is in Channels above.`
      );

      // WEB PUSH IS LOGIN-OWNED, and the first draft of this feature said it was the
      // server's. The keypair generates itself on first use, there is no VAPID control
      // on Settings → Server, and the one control that fixes this column is the "Enable
      // push on this browser" button in the Channels section of this same page — so
      // sending the reader to an admin was an instruction nobody could carry out, on
      // the default fresh install this very instance is. Asserted structurally: EXACTLY
      // ONE sentence may mention Web Push, and it must be the LOGIN one. Were the
      // column grouped back into the admin sentence, that same sentence would match the
      // filter and fail both clauses below.
      //
      // Deliberately NOT an exact-text assertion. Web Push's own tier is this spec's to
      // own — no push subscription can exist in a headless browser, so the column is
      // reliably dead — but its SENTENCE-MATES are not. `deadColumnNotes` groups every
      // login-blocked column into ONE line, and whether Telegram and Email are
      // server-blocked or login-blocked turns on the instance-wide bot token and SMTP
      // that neighbouring specs configure and reset mid-run — the same shared-state
      // reason this spec owns only the Home Assistant column end to end. Pinning the
      // whole line would let a neighbour's ordinary write fail this spec. The two
      // clauses below are what the finding is actually about, and neither weakens when
      // another column joins the sentence.
      const pushNote = notes
        .getByRole("listitem")
        .filter({ hasText: "Web Push" });
      await expect(pushNote).toHaveCount(1);
      await expect(pushNote).toContainText("set up for your login yet");
      await expect(pushNote).not.toContainText("Settings → Server");

      // ── (4) Setting the channel up revives the STORED preferences ───────────
      await setHaEnabled(true);

      await expect(state).toHaveText("set up");
      await expect(state).toHaveAttribute("data-column-state", "ready");
      await expect(kept).toBeChecked();
      await expect(kept).toHaveAttribute("data-ink", "live");
      // The one the user turned off stayed off — reviving a column is not re-consenting
      // on their behalf.
      await expect(turnedOff).not.toBeChecked();
      await expect(turnedOff).toHaveAttribute("data-ink", "off");
      // …and the profile's setup sentence is gone from the card entirely. Asserted on
      // the kinds card rather than on the notes block, which may not exist at all when
      // every column is set up.
      await expect(kinds).not.toContainText(
        `Home Assistant isn’t set up for ${MATRIX_INK_PROFILE}`
      );

      // ── Leave the fixture as we found it ────────────────────────────────────
      await setCell("matrix-cell-ha-weekly-recap", true);
      await setHaEnabled(false);
      await expect(state).toHaveText("not set up");
      await expect(member.getByTestId("matrix-cell-ha-refill")).toBeChecked();
    } finally {
      await member.context().close();
    }
  });
});
