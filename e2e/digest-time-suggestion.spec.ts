import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledCheckSave, settledSelect } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { pinnedTimezone } from "./pinned-timezone";

// The digest time SUGGESTION on Settings → Notifications (#2217).
//
// The seeded fixture has no measured sleep ARRIVALS (no `integration_sync_rows`
// provenance behind its sleep samples), so this spec seeds #2217's measured 13
// nights for profile 1, drives the two exits and the decline, and removes everything
// it wrote.
//
// WHAT IT PINS THAT ONLY A BROWSER CAN. The suggestion renders BESIDE the digest
// time, its exits perform exactly one write each, and the row goes away the moment it
// stops firing — including the case that matters most for a form: after "Use 07:40"
// the time input beside it shows 07:40 rather than drifting from what was stored.
//
// The decision itself (median trigger, p90 proposal, grid snap, the dismissal
// ratchet) is pinned in lib/__tests__/digest-time-suggestion.test.ts; the gather and
// the digest line in lib/__db_tests__/digest-time-suggestion.test.ts.
//
// BLAST RADIUS: profile 1's digest settings (mode, time, the Sleep-section extra),
// the admin login's clock-format pref, the seeded arrival rows, and any
// `digest-time:` dismissal — all reset in afterAll.

const PROFILE = 1;
const PROVIDER = "e2e-digest-time";

// #2217's measured 13 nights, as (days back, arrival minute of day, sync lag).
const MEASURED: [number, number, number][] = [
  [13, 6 * 60 + 2, 30],
  [12, 6 * 60 + 6, 35],
  [11, 6 * 60 + 14, 40],
  [10, 6 * 60 + 26, 45],
  [9, 6 * 60 + 47, 64],
  [8, 6 * 60 + 50, 55],
  [7, 7 * 60 + 4, 86],
  [6, 7 * 60 + 11, 86],
  [5, 7 * 60 + 26, 105],
  [4, 7 * 60 + 26, 80],
  [3, 7 * 60 + 30, 70],
  [2, 7 * 60 + 42, 65],
  [1, 7 * 60 + 48, 50],
];

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// The arrival minute the statistic measures is PROFILE-LOCAL, and the suite pins the
// instance timezone to whichever fixed-offset zone makes the frozen instant read
// 13:mm local (e2e/pinned-timezone.ts). So a fixture that seeded UTC wall times would
// land the whole distribution at an arbitrary local hour and the trigger would fire
// or not depending on the run's start hour. These instants are built from the LOCAL
// clock and converted back — the pinned zones are fixed-offset and never observe DST,
// so one subtraction is the whole conversion.
const OFFSET_MS =
  pinnedTimezone(frozenNow().toISOString()).offsetHours * 3600_000;

function instantAt(
  daysBack: number,
  minute: number
): { iso: string; day: string } {
  // A Date whose UTC fields ARE the profile's local wall clock.
  const local = new Date(frozenNow().getTime() + OFFSET_MS);
  local.setUTCDate(local.getUTCDate() - daysBack);
  local.setUTCHours(Math.floor(minute / 60), minute % 60, 0, 0);
  const utc = new Date(local.getTime() - OFFSET_MS);
  return {
    iso: `${utc.toISOString().slice(0, 19)}Z`,
    day: local.toISOString().slice(0, 10),
  };
}

function seedArrivals(): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('notify_tick_interval_min', '5')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    for (const [daysBack, minute, lag] of MEASURED) {
      const arrived = instantAt(daysBack, minute);
      const endMs = new Date(arrived.iso).getTime() - lag * 60_000;
      const end = `${new Date(endMs).toISOString().slice(0, 19)}Z`;
      const start = `${new Date(endMs - 420 * 60_000).toISOString().slice(0, 19)}Z`;
      const sampleId = Number(
        db
          .prepare(
            `INSERT INTO metric_samples
               (profile_id, source, origin, metric, date, start_time, end_time, value)
             VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
          )
          .run(PROFILE, PROVIDER, arrived.day, start, end).lastInsertRowid
      );
      const eventId = Number(
        db
          .prepare(
            `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
             VALUES (?, ?, ?, 1, 1)`
          )
          .run(PROFILE, PROVIDER, arrived.iso).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO integration_sync_rows
           (event_id, target_table, target_id, disposition, created_at)
         VALUES (?, 'metric_samples', ?, 'inserted', ?)`
      ).run(eventId, sampleId, arrived.iso);
    }
  });
}

/** Put profile 1's digest back into the losing 07:00 Static state, undismissed. */
function resetDigest(): void {
  withDb((db) => {
    for (const [key, value] of [
      ["notify_digest_hour", "07:00"],
      ["digest_mode", "static"],
      // The suggestion's whole premise is the Sleep section being ON (#2255).
      ["digest_sleep_enabled", "1"],
    ] as const) {
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(PROFILE, key, value);
    }
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'digest-time:%'"
    ).run();
  });
}

test.beforeAll(() => {
  seedArrivals();
});

test.beforeEach(() => resetDigest());

test.afterAll(() => {
  withDb((db) => {
    db.prepare(
      `DELETE FROM integration_sync_rows
        WHERE target_table = 'metric_samples'
          AND target_id IN (SELECT id FROM metric_samples WHERE source = ?)`
    ).run(PROVIDER);
    db.prepare("DELETE FROM integration_sync_events WHERE provider = ?").run(
      PROVIDER
    );
    db.prepare("DELETE FROM metric_samples WHERE source = ?").run(PROVIDER);
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'digest-time:%'"
    ).run();
    // The seeded fixture ships the digest OFF; leave it as found.
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'notify_digest_hour', '')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = ''`
    ).run(PROFILE);
    // The Sleep section is on by default (an absent row reads as on).
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'digest_sleep_enabled', '1')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = '1'`
    ).run(PROFILE);
    // …and so is the 24-h clock, which is the login-tier default.
    db.prepare(`DELETE FROM login_settings WHERE key = 'time_format'`).run();
  });
});

test.describe("the digest time suggestion (issue #2217)", () => {
  test("renders beside the digest time, and 'Use 07:40' writes exactly that", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");
    const card = page.getByTestId("digest-time-suggestion");
    await expect(card).toBeVisible();
    // The measured facts, and nothing about the person.
    await expect(card).toContainText(
      "Last night’s sleep usually lands by 07:40."
    );
    await expect(card).toContainText(
      "Your digest sends at 07:00, so it often goes out before the data arrives."
    );
    await expect(card).toContainText("Measured over 13 mornings.");
    // The ranking is ARGUED, not just styled (#2255 §2): one tradeoff sentence
    // quoting only the two times already on the buttons.
    await expect(card).toContainText(
      "“As soon as it’s ready” usually sends earlier than 07:40; 07:40 keeps a fixed time."
    );
    // Dynamic is the PRIMARY exit and reads first; declining says "No thanks",
    // because it is a dismissal rather than a snooze (#2255 §2/§3).
    await expect(card.getByRole("button")).toHaveText([
      "Switch to “As soon as it’s ready”",
      "Use 07:40",
      "No thanks",
    ]);

    await card.getByTestId("digest-time-use").click();

    // One write: the time moved, the mode did not, and the picker beside the card
    // shows what was stored rather than the value it was rendered with.
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:40");
    await expect(page.getByTestId("digest-hour")).toHaveValue("static");
    // Nothing left to suggest — the configured time now clears the median.
    await expect(card).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:40");
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);
  });

  test("the other exit switches the mode and leaves the time as the floor", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/settings/notifications");
    await page
      .getByTestId("digest-time-suggestion")
      .getByTestId("digest-time-dynamic")
      .click();

    await expect(page.getByTestId("digest-hour")).toHaveValue("dynamic");
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:00");
    // Silent in Dynamic: a floor is not a send time.
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("digest-hour")).toHaveValue("dynamic");
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);
  });

  test("declining is a dismissal, not a deferral — it stays gone across a reload", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/settings/notifications");
    await page
      .getByTestId("digest-time-suggestion")
      .getByTestId("digest-time-dismiss")
      .click();
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);

    // Nothing was written to the schedule by declining.
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:00");
    await expect(page.getByTestId("digest-hour")).toHaveValue("static");

    await page.reload();
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:00");
  });

  test("unticking the sleep summary drops the card, with no reload (#2255)", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/settings/notifications");
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(page.getByTestId("digest-time-suggestion")).toBeVisible();

    // With no sleep in the digest there is nothing for the send time to be early
    // for — and the card's Dynamic exit would move the reader into a mode whose own
    // caption immediately says "there is nothing to wait for". The card conditions
    // on the LIVE checkbox, so it goes the instant the box does.
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      false,
      kindsCard
    );
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);
    // The static caption drops its sleep clause in the same breath (#2255 §3).
    await expect(page.getByTestId("digest-hour-summary")).toHaveText(
      "Sends at 07:00 every day."
    );

    // The server agrees on the next render — this is one gate, not two answers.
    await page.reload();
    await expect(page.getByTestId("digest-time-suggestion")).toHaveCount(0);
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:00");

    // Nothing was dismissed to achieve that, so turning it back on re-offers.
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      true,
      page.getByTestId("notification-kinds")
    );
    await page.reload();
    await expect(page.getByTestId("digest-time-suggestion")).toBeVisible();
  });

  test("a 12h login reads this whole page on a 12-hour clock (#2255 §4)", async ({
    page,
  }) => {
    test.slow();

    try {
      await page.goto("/settings/display");
      await settledSelect(page, page.getByTestId("time-format-select"), "12h");
      // The card autosaves on change; its own status is the settle signal.
      await expect(page.getByLabel("Saved")).toBeVisible();

      await page.goto("/settings/notifications");
      // The schedule caption, the suggestion card, and the quiet-hours options all
      // route through the ONE #964 seam — no page-local formatter, no browser locale.
      await expect(page.getByTestId("digest-hour-summary")).toContainText(
        "Sends at 7:00 AM every day"
      );
      const card = page.getByTestId("digest-time-suggestion");
      await expect(card).toContainText(
        "Last night’s sleep usually lands by 7:40 AM."
      );
      await expect(card).toContainText("Your digest sends at 7:00 AM");
      await expect(card.getByTestId("digest-time-use")).toHaveText(
        "Use 7:40 AM"
      );
      await expect(
        page.getByTestId("waking-start-hour").getByRole("option", {
          name: "8:00 AM",
          exact: true,
        })
      ).toHaveCount(1);
      await expect(
        page.getByTestId("waking-end-hour").getByRole("option", {
          name: "9:59 PM",
          exact: true,
        })
      ).toHaveCount(1);

      // STORAGE IS UNTOUCHED: the time input still holds the canonical "HH:MM" the
      // settings tier persists, and the mode select still holds its stored token.
      await expect(page.getByTestId("digest-hour-time")).toHaveValue("07:00");
      await expect(page.getByTestId("digest-hour")).toHaveValue("static");
    } finally {
      // Restore the default so the shared admin login preference doesn't leak.
      await page.goto("/settings/display");
      await settledSelect(page, page.getByTestId("time-format-select"), "24h");
      await expect(page.getByLabel("Saved")).toBeVisible();
      await expect(page.getByTestId("time-format-select")).toHaveValue("24h");
    }
  });

  test("a member on another profile never sees it", async ({ browser }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      await expect(member.getByTestId("notification-kinds")).toBeVisible();
      // Riley's own digest has no measured arrivals — the suggestion is about the
      // ACTIVE profile's distribution, never the instance's.
      await expect(member.getByTestId("digest-time-suggestion")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
