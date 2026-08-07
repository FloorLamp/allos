import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

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
// BLAST RADIUS: profile 1's digest settings, the seeded arrival rows, and any
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

// The instant `daysBack` days before the frozen run clock, at `minute` UTC. The e2e
// profile runs in UTC, so a UTC wall time IS its local clock time.
function instantAt(
  daysBack: number,
  minute: number
): { iso: string; day: string } {
  const base = new Date(frozenNow());
  base.setUTCDate(base.getUTCDate() - daysBack);
  base.setUTCHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return {
    iso: `${base.toISOString().slice(0, 19)}Z`,
    day: base.toISOString().slice(0, 10),
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
