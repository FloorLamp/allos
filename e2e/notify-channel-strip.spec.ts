import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openChannelRow, settledCheck, settledFill } from "./helpers";
import { loginAs } from "./nav";
import {
  CHANNEL_STRIP_PROFILE,
  E2E_LOGIN_CHANNEL_STRIP,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// THE CHANNEL STATUS STRIP (#2565 A, owner ruling 2026-08-18). What only a browser can
// prove: the four channels render as ROWS in the strip, in the page's new section order,
// each carrying its own state dot, its state WORD, and the scope chip naming whose
// setting it is — and an ERRORING row is forced open while it is failing.
//
// The four states are walked on HOME ASSISTANT, the one channel a spec can own end to
// end: its setup is PROFILE-scoped, so this fixture's profile owns the config, the send
// and the lifecycle row. Telegram, Push and Email liveness all ride instance-wide config
// that neighbouring specs configure and reset mid-run.
//
// WHAT IS DRIVEN AND WHAT IS FORGED, stated so the next reader is not misled:
//   Not set up  driven — the seeded absence of a webhook.
//   Ready       driven — a saved webhook with no attempt against it.
//   Erroring    driven, for real — the send-test POSTs to an unreachable host, the
//               adapter records the failure, and the reloaded page reads that row.
//   Delivering  FORGED — the one state that needs a webhook receiver this suite has no
//               way to stand up. The row is written straight into `notify_lifecycle`,
//               the same shape `recordDeliveryOutcome` writes; that WRITE path is driven
//               over the real channels in lib/__db_tests__/delivery-lifecycle.test.ts,
//               so what is untested there and here is nothing.
//
// Its own login + profile, and it leaves the channel disabled and the lifecycle rows
// gone, so a --repeat-each pass re-enters from the seeded absence.

const HA_URL = "http://127.0.0.1:9/api/webhook/allos-channel-strip";

function withDb<T>(f: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return f(db);
  } finally {
    db.close();
  }
}

function profileId(): number {
  return withDb(
    (db) =>
      (
        db
          .prepare("SELECT id FROM profiles WHERE name = ?")
          .get(CHANNEL_STRIP_PROFILE) as { id: number }
      ).id
  );
}

function clearLifecycle(): void {
  withDb((db) =>
    db
      .prepare("DELETE FROM notify_lifecycle WHERE channel = 'home-assistant'")
      .run()
  );
}

// Reset to the seeded absence: no webhook, no recorded outcome.
function resetChannel(): void {
  clearLifecycle();
  withDb((db) =>
    db
      .prepare(
        "DELETE FROM profile_settings WHERE key LIKE 'ha_notify_%' AND profile_id = ?"
      )
      .run(profileId())
  );
}

const status = (channel: string) => `notify-channel-status-${channel}`;
const dot = (channel: string) => `notify-channel-dot-${channel}`;

test.describe("Settings → Notifications channel strip (#2565 A)", () => {
  test("four rows in the new section order, with scope chips and all four states", async ({
    browser,
  }) => {
    test.slow();
    resetChannel();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHANNEL_STRIP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");

      // ── Section order: strip → kinds → household round → schedule → digest → mute ─
      // Read off the RENDERED document position, not the JSX, so a section that moved
      // behind a fold or into another container is caught rather than assumed.
      const order = await member.evaluate(() =>
        [
          "notify-channels",
          "notification-kinds",
          "household-round-card",
          "notify-schedule",
          "notify-digest-tune",
          "notify-mute",
        ].map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          return el
            ? el.getBoundingClientRect().top + window.scrollY
            : Number.NaN;
        })
      );
      expect(order.some(Number.isNaN)).toBe(false);
      expect(order).toEqual([...order].sort((a, b) => a - b));

      // ── Four rows, and the Household round is NOT one of them (A′) ──────────────
      for (const c of ["telegram", "push", "email", "home-assistant"]) {
        await expect(member.getByTestId(`notify-channel-${c}`)).toBeVisible();
      }
      await expect(
        member.getByTestId("notify-channel-household-round")
      ).toHaveCount(0);

      // ── Scope chips: three follow the LOGIN, Home Assistant follows the PROFILE ──
      for (const c of ["telegram", "push", "email"]) {
        await expect(
          member.getByTestId(`notify-channel-scope-${c}`)
        ).toHaveText(E2E_LOGIN_CHANNEL_STRIP);
      }
      await expect(
        member.getByTestId("notify-channel-scope-home-assistant")
      ).toHaveText(CHANNEL_STRIP_PROFILE);

      // ── NOT SET UP, and it names whose step is missing ──────────────────────────
      const haStatus = member.getByTestId(status("home-assistant"));
      await expect(haStatus).toHaveAttribute("data-state", "not-set-up");
      await expect(haStatus).toContainText(
        `Not set up — open this row to set it up for ${CHANNEL_STRIP_PROFILE}`
      );
      // A closed row really is closed: its configuration is not on screen.
      await expect(member.getByTestId("ha-enable")).not.toBeVisible();

      // ── READY: configured, nothing attempted. Never "Delivering" ────────────────
      await openChannelRow(member, "home-assistant");
      await settledCheck(member, member.getByTestId("ha-enable"), true);
      await settledFill(member, member.getByTestId("ha-webhook-url"), HA_URL);
      await member.getByTestId("ha-save").click();
      await expect(member.getByTestId("ha-status")).toBeVisible();
      await member.reload();
      await openChannelRow(member, "home-assistant");
      await expect(
        member.getByTestId(status("home-assistant"))
      ).toHaveAttribute("data-state", "ready");
      await expect(member.getByTestId(status("home-assistant"))).toContainText(
        "Ready — not tested yet"
      );

      // ── ERRORING, for real: the send-test POSTs to an unreachable host ──────────
      await member.getByTestId("ha-test").click();
      await expect(member.getByTestId("ha-result")).toBeVisible();

      // CLOSE the row before reloading, so "forced open" below is a claim about the
      // ERROR and not about this spec's own clicks. Opening a row writes per-device
      // memory, and a remembered-open row is open for a reason that has nothing to do
      // with its state — which would make the next two assertions pass either way.
      const haRow = member.getByTestId("notify-channel-home-assistant");
      await haRow.locator("summary").click();
      await expect(haRow).toHaveJSProperty("open", false);

      await member.reload();
      const erroring = member.getByTestId(status("home-assistant"));
      await expect(erroring).toHaveAttribute("data-state", "erroring");
      await expect(erroring).toContainText("Erroring — ");
      await expect(member.getByTestId(dot("home-assistant"))).toHaveAttribute(
        "data-state",
        "erroring"
      );
      // Forced open, against a memory that says closed. The CONTROL is a row in the
      // same strip that is neither erroring nor remembered open, so a page where every
      // row happened to be open could not pass this pair.
      await expect(haRow).toHaveJSProperty("open", true);
      await expect(member.getByTestId("notify-channel-email")).toHaveJSProperty(
        "open",
        false
      );

      // ── DELIVERING: a recorded success, and it is not inferred from config ──────
      withDb((db) =>
        db
          .prepare(
            `UPDATE notify_lifecycle
                SET state = 'delivering', detail = NULL, at = ?
              WHERE channel = 'home-assistant' AND owner_id = ?`
          )
          .run("2026-09-01T09:00:00Z", profileId())
      );
      await member.reload();
      const delivering = member.getByTestId(status("home-assistant"));
      await expect(delivering).toHaveAttribute("data-state", "delivering");
      await expect(delivering).toContainText("Delivering — last message");
      // A healed row stops being forced open and goes back to what this device
      // remembered — which the close above made "closed".
      await expect(haRow).toHaveJSProperty("open", false);

      // ── NOT SET UP DOMINATES: it HIDES a stale outcome, it does not qualify it ──
      // Removing the setup also invalidates the row, so proving domination needs the
      // stale outcome put BACK while the channel is off — otherwise "not-set-up" is
      // true for the trivial reason that there is nothing left to read.
      await openChannelRow(member, "home-assistant");
      await settledCheck(member, member.getByTestId("ha-enable"), false);
      await member.getByTestId("ha-save").click();
      await expect(member.getByTestId("ha-status")).toBeVisible();
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO notify_lifecycle (key, state, channel, owner_id, detail, at)
               VALUES (?, 'delivering', 'home-assistant', ?, NULL, ?)
             ON CONFLICT(key) DO UPDATE SET state = 'delivering', at = excluded.at`
          )
          .run(
            `delivery-home-assistant-${profileId()}`,
            profileId(),
            "2026-09-01T09:00:00Z"
          )
      );
      await member.reload();
      const dark = member.getByTestId(status("home-assistant"));
      await expect(dark).toHaveAttribute("data-state", "not-set-up");
      await expect(dark).not.toContainText("Delivering");
    } finally {
      resetChannel();
      await member.context().close();
    }
  });
});
