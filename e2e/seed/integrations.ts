// e2e seed fixtures — integrations domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import { writeRawPayload } from "../../lib/integrations/raw-log";
import { upsertConnection } from "../../lib/integrations/connections";
import { truncatedSyncDetails } from "../../lib/integrations/sync-details";
import { generateHealthConnectToken } from "../../lib/integrations/connections";
import { utcMinute, shiftDateStr, zonedWallTimeToUtc } from "../../lib/date";
import { getTimezone, setProfileWearReminder } from "../../lib/settings";
import {
  E2E_LOGIN_SYNC_HISTORY,
  SYNC_HISTORY_PROFILE,
  E2E_LOGIN_QUIET_STREAM,
  QUIET_STREAM_PROFILE,
  E2E_LOGIN_STREAM_ONBOARD,
  STREAM_ONBOARD_PROFILE,
  E2E_LOGIN_STREAM_DECLINE,
  STREAM_DECLINE_PROFILE,
  E2E_LOGIN_STREAM_LAPSED,
  STREAM_LAPSED_PROFILE,
} from "../fixture-logins";
import { PROFILE_ID, ins, fixtureProfileId, seedMemberLogin } from "./common";

// ── Integration sync events, per-row provenance, connection states ──
export function seedIntegrationSyncEvents(): void {
  // Mark Strava CONNECTED so the Data → Review "Connected sources" card shows the
  // per-provider "Sync now" affordance (issue #208) rather than a "Connect" link.
  // Synthetic config only — the e2e never taps Sync now (it would hit the network), it
  // only asserts the button renders. Health Connect stays unconnected → its card shows
  // the push-only explainer.
  upsertConnection(PROFILE_ID, "strava", {
    status: "connected",
    config: { clientId: "e2e-client", accessToken: "e2e-token" },
  });

  // Durable provider-neutral backfill progress: the connected Strava page and
  // Data → Review render this same paused checkpoint, including provider wait + ETA.
  const backfillNow = clockNow();
  const retryAfter = new Date(backfillNow.getTime() + 30 * 60 * 1000);
  db.prepare(
    `INSERT INTO integration_backfill_jobs
       (profile_id, provider, kind, label, item_noun, status, total_items,
        completed_items, failed_items, request_count, active_seconds,
        started_at, retry_after_at, created_at, updated_at)
     VALUES (?, 'strava', 'ride-details', 'Ride detail backfill', 'ride',
       'paused', 10, 4, 0, 10, 20, ?, ?, ?, ?)`
  ).run(
    PROFILE_ID,
    new Date(backfillNow.getTime() - 20_000).toISOString(),
    retryAfter.toISOString(),
    backfillNow.toISOString(),
    backfillNow.toISOString()
  );

  // Capture a raw payload file for the healthy Health Connect sync so the admin-only
  // "View raw" affordance (#9) has something to fetch. Synthetic fixture content —
  // no real PHI. writeRawPayload writes under data/integration-payloads/<profile>/
  // (the same dir the raw route reads), returning the bare ref stored on the event.
  const hcRawRef = writeRawPayload(
    PROFILE_ID,
    "health-connect",
    JSON.stringify(
      {
        records: [
          { type: "Steps", count: 8000, startTime: "2026-07-08T00:00:00Z" },
          { type: "HeartRate", bpm: 61, time: "2026-07-08T06:30:00Z" },
        ],
      },
      null,
      2
    )
  );

  // One meaningful Health Connect sync, then a RUN of hourly all-unchanged Strava
  // re-scans (the "nothing new every hour" spam of issue #137), then a newer Strava
  // failure — so Strava is "currently failing" (its latest event is the failure)
  // while Health Connect is healthy. The Health Connect sync carries the split (30
  // new + 10 changed + 2 skipped). The four consecutive Strava no-ops (all ok=1,
  // 0 inserted + 0 updated) must COLLAPSE into a single "No new data · 4 checks"
  // line in the Review feed rather than four rows. The failure below stays newest so
  // the "currently failing" surface is unaffected.
  //
  // NOTE: these timestamps are deliberately fixed past dates, NOT relative to today.
  // Nothing compares them against `now`/`today()` — the feed sorts them purely by
  // string and "currently failing" is decided by per-provider ordering within this
  // block — so they can't drift or collide with a relative fixture the way a
  // hardcoded date in a table that ALSO has daysAgo() rows can. The only invariant
  // is that the failure sorts newest among Strava and the no-ops stay consecutive.
  ins.run(
    PROFILE_ID,
    "health-connect",
    "2026-07-08T07:00:00Z",
    1,
    "2026-07-06",
    "2026-07-08",
    42, // received
    40, // written (inserted + updated + unchanged)
    30, // inserted
    10, // updated
    0, // unchanged
    2, // skipped
    hcRawRef, // raw_ref → drives the admin "View raw" affordance (#9)
    null
  );
  db.prepare(
    `UPDATE integration_sync_events
      SET details = ?
    WHERE profile_id = ? AND provider = 'health-connect' AND at = ?`
  ).run(
    JSON.stringify({
      warnings: [],
      origins: [
        {
          date: "2026-07-08",
          metric: "total_kcal",
          chosen: "com.garmin.android.apps.connectmobile",
          ignored: ["com.fitbit.FitbitMobile"],
        },
      ],
    }),
    PROFILE_ID,
    "2026-07-08T07:00:00Z"
  );

  // One-off Fitbit archive import. Unlike the recurring sources below, this belongs
  // in Review's chronological Imports feed beside documents and paste jobs.
  ins.run(
    PROFILE_ID,
    "fitbit-takeout",
    "2026-07-10T10:00:00Z",
    1,
    null,
    null,
    5, // received
    5, // written
    3, // inserted
    0, // updated
    2, // unchanged
    0, // skipped
    null, // raw_ref
    null
  );

  // ---- #1333 per-row provenance drill-in fixture -----------------------------
  // Attach integration_sync_rows to the healthy Health Connect event above so its
  // Connected-sources card renders the "What this wrote" drill-in with resolvable deep
  // links. Uniquely anchored: a dedicated activity + body-metric (distinctive titles/
  // date) owned by PROFILE_ID and never asserted on by count elsewhere. The rows record
  // one inserted + one updated disposition (the only two recorded — unchanged is not).
  {
    const hcEventId = (
      db
        .prepare(
          `SELECT id FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'health-connect' AND at = '2026-07-08T07:00:00Z'`
        )
        .get(PROFILE_ID) as { id: number } | undefined
    )?.id;
    if (hcEventId) {
      db.prepare(
        `DELETE FROM activities WHERE profile_id = ? AND title = 'HC provenance run'`
      ).run(PROFILE_ID);
      const provActId = Number(
        db
          .prepare(
            `INSERT INTO activities
             (profile_id, date, type, title, duration_min, distance_km, source, external_id)
           VALUES (?, '2026-07-08', 'cardio', 'HC provenance run', 32, 5.2, 'health-connect', 'hc:prov:run:1')`
          )
          .run(PROFILE_ID).lastInsertRowid
      );
      db.prepare(
        `DELETE FROM body_metrics WHERE profile_id = ? AND date = '2026-07-08' AND source = 'health-connect'`
      ).run(PROFILE_ID);
      const provBodyId = Number(
        db
          .prepare(
            `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
           VALUES (?, '2026-07-08', 79.4, 'health-connect')`
          )
          .run(PROFILE_ID).lastInsertRowid
      );
      const insRow = db.prepare(
        `INSERT INTO integration_sync_rows (event_id, target_table, target_id, disposition)
       VALUES (?, ?, ?, ?)`
      );
      insRow.run(hcEventId, "activities", provActId, "inserted");
      insRow.run(hcEventId, "body_metrics", provBodyId, "updated");
    }
  }

  // #1772: an OLDER Strava failure, so the sync-history table has a failure row that
  // is NOT the latest event. Before the redesign `ev.error` rendered only for the
  // latest event, so a historical "Sync failed" row gave no reason at all — and the
  // moment a success landed, even the most recent failure's reason disappeared from
  // the UI entirely. Dated before the no-op run so it can't break their consecutive
  // collapse, and older than the newest Strava failure so "currently failing" is
  // decided by that one and this fixture changes no badge count. Its message is
  // distinct from the newest failure's so the assertion can name the history row.
  ins.run(
    PROFILE_ID,
    "strava",
    "2026-07-07T22:00:00Z",
    0,
    "2026-07-01",
    "2026-07-07",
    null,
    null,
    null,
    null,
    null,
    null,
    null, // raw_ref
    "Strava rate limit reached (429): daily quota exhausted"
  );

  // Four consecutive hourly Strava no-op re-scans (05:00–08:00) → one collapsed line.
  for (const hour of ["05", "06", "07", "08"]) {
    ins.run(
      PROFILE_ID,
      "strava",
      `2026-07-08T${hour}:00:00Z`,
      1,
      "2026-07-01",
      "2026-07-08",
      6, // received
      6, // written
      0, // inserted
      0, // updated
      6, // unchanged → no new data
      0, // skipped
      null, // raw_ref
      null
    );
  }

  // Issue #1614: a pull run a page cap / rate limit cut short. It SUCCEEDED as far as
  // it got — ok=1, rows landed — but the provider still had data, so the event carries
  // the durable `truncated` marker and its Review line, and the Connected-sources card
  // must badge it "partial" instead of a clean green success. Dated between the no-ops
  // and the failure, so it lands in Strava's expandable history and leaves the
  // "currently failing" state (the newest Strava event is still the failure) alone.
  ins.run(
    PROFILE_ID,
    "strava",
    "2026-07-08T10:00:00Z",
    1,
    "2026-07-01",
    "2026-07-08",
    6, // received
    6, // written
    3, // inserted
    0, // updated
    3, // unchanged
    0, // skipped
    null, // raw_ref
    null
  );
  db.prepare(
    `UPDATE integration_sync_events
        SET details = ?, raw_ref = ?
      WHERE profile_id = ? AND provider = 'strava' AND at = ?`
  ).run(
    truncatedSyncDetails(),
    // #1991: the admin-only raw payload is one LINK per run opening a dialog, not a
    // JSON tree rendered inline in the primary reading position. Give the partial
    // Strava run a captured payload so the source page has that link to open.
    writeRawPayload(
      PROFILE_ID,
      "strava",
      JSON.stringify(
        [{ id: 111, name: "Fixture ride", distance: 24000 }],
        null,
        2
      )
    ),
    PROFILE_ID,
    "2026-07-08T10:00:00Z"
  );
  ins.run(
    PROFILE_ID,
    "strava",
    "2026-07-09T09:00:00Z",
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null, // raw_ref
    "Strava token refresh failed (401): unauthorized"
  );

  // Issue #294: a source that was CONNECTED and later removed keeps showing its
  // historical logs under "Connected sources" — as a "Not connected" card with a
  // Reconnect link — instead of vanishing. Oura models that removed-but-historical
  // case: mark it disconnected but seed one past successful sync so its card renders
  // with the Reconnect affordance. (A provider with NEITHER a connection nor any sync
  // history — the never-set-up case — is filtered out entirely, which is the behavior
  // the issue asked for; that decision is unit-tested in sync-log.test.ts.) The
  // disconnected + ok=1 shape keeps this off the "currently failing" surface, so the
  // review badge count is unaffected.
  db.prepare(
    `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = 'oura'`
  ).run(PROFILE_ID);
  upsertConnection(PROFILE_ID, "oura", {
    status: "disconnected",
    config: null,
  });
  ins.run(
    PROFILE_ID,
    "oura",
    "2026-07-05T06:00:00Z",
    1,
    "2026-07-01",
    "2026-07-05",
    12, // received
    12, // written
    8, // inserted
    4, // updated
    0, // unchanged
    0, // skipped
    null, // raw_ref
    null
  );

  // Issue #326: a provider whose token DIED (dead/revoked refresh token) flips to the
  // terminal `needs_reauth` state — the hourly tick then auto-syncs `connected` rows
  // ONLY, so it stops retrying forever. Withings models that: mark it needs_reauth with
  // a preserved config, plus one past failed sync event so the card has history and
  // renders under "Connected sources" with the distinct "Needs reconnect" badge + a
  // Reconnect link (contrast Oura's benign "Not connected"). Its latest event is a
  // failure, so it also surfaces under "Needs attention". Synthetic config only.
  db.prepare(
    `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = 'withings'`
  ).run(PROFILE_ID);
  upsertConnection(PROFILE_ID, "withings", {
    status: "needs_reauth",
    config: { clientId: "e2e-w-client", clientSecret: "e2e-w-secret" },
  });
  ins.run(
    PROFILE_ID,
    "withings",
    "2026-07-09T08:30:00Z",
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null, // raw_ref
    "Withings token refresh failed (401)"
  );
}

// ── #1991 — a DAY of high-frequency pushes, on its own profile ──
//
// The Health Connect exporter re-sends its rolling window every ~20 minutes, so the
// per-run history read "Synced · N new · 4 changed · 73 unchanged" some seventy times
// a day and a real anomaly was invisible in it. This fixture is that stream: ~30
// pushes across today, one of which dropped rows it couldn't map, and a newest push
// whose SPLIT says 30 records while only TWO of them carry an openable identity (the
// rest are minute-grain rows recordSyncRows deliberately skips — the exact shape of
// the "What this wrote (30)" that expanded to three rows).
//
// Its OWN profile: the assertions are about a stream nothing else may add to, and the
// shared profile's Health Connect state is relied on by review-inbox.spec.
const SYNC_HISTORY_PUSHES = 30;
const SYNC_HISTORY_OLDER_DAYS = 8;
// Minutes between pushes, and which push (counting back from the newest) skipped rows.
const PUSH_INTERVAL_MIN = 20;
const SYNC_HISTORY_ANOMALY_BACK = 12;
export const SYNC_HISTORY_SKIPPED = 6;
// The newest push's split, and how much of it the drill-in can actually list.
export const SYNC_HISTORY_WRITTEN = 30;
export const SYNC_HISTORY_ITEMIZABLE = 2;

function sqlStamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function seedSyncHistoryDay(): void {
  const profileId = fixtureProfileId(SYNC_HISTORY_PROFILE);
  seedMemberLogin(E2E_LOGIN_SYNC_HISTORY, profileId);
  // A live connection, so the source page renders the status card and the history.
  generateHealthConnectToken(profileId);
  db.prepare(
    `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = 'health-connect'`
  ).run(profileId);

  // The frozen clock reads 13:mm LOCAL for this run (e2e/pinned-timezone.ts), so ten
  // hours of 20-minute pushes all land inside the SAME local day — which is what makes
  // "one day line" a deterministic assertion at every possible CI start hour.
  const now = clockNow().getTime();
  for (let back = SYNC_HISTORY_PUSHES - 1; back >= 0; back--) {
    const skipped =
      back === SYNC_HISTORY_ANOMALY_BACK ? SYNC_HISTORY_SKIPPED : 0;
    const newest = back === 0;
    ins.run(
      profileId,
      "health-connect",
      sqlStamp(new Date(now - back * PUSH_INTERVAL_MIN * 60_000)),
      1,
      null,
      null,
      73, // received
      73, // written
      newest ? 20 : back % 5 === 0 ? 3 : 0, // inserted
      newest ? 10 : 0, // updated
      73, // unchanged → the repeating figure that made the log unreadable
      skipped,
      null, // raw_ref
      null
    );
  }

  // Eight quiet older days exercise the provider page's seven-complete-day cursor.
  // They stay one run each so the dense-day assertions remain about TODAY's stream.
  for (let daysBack = SYNC_HISTORY_OLDER_DAYS; daysBack >= 1; daysBack--) {
    ins.run(
      profileId,
      "health-connect",
      sqlStamp(new Date(now - daysBack * 86_400_000)),
      1,
      null,
      null,
      1,
      1,
      1,
      0,
      0,
      0,
      null,
      null
    );
  }

  // Provenance for the NEWEST push only, and only two rows of it.
  const newestId = (
    db
      .prepare(
        `SELECT id FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'health-connect'
          ORDER BY at DESC, id DESC LIMIT 1`
      )
      .get(profileId) as { id: number }
  ).id;
  const day = today(profileId);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND title = 'Day-group walk'`
  ).run(profileId);
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, distance_km, source, external_id)
         VALUES (?, ?, 'cardio', 'Day-group walk', 41, 3.6, 'health-connect', 'hc:daygroup:1')`
      )
      .run(profileId, day).lastInsertRowid
  );
  db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND date = ? AND source = 'health-connect'`
  ).run(profileId, day);
  const bodyId = Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, 71.2, 'health-connect')`
      )
      .run(profileId, day).lastInsertRowid
  );
  const insRow = db.prepare(
    `INSERT INTO integration_sync_rows (event_id, target_table, target_id, disposition)
     VALUES (?, ?, ?, ?)`
  );
  insRow.run(newestId, "activities", actId, "inserted");
  insRow.run(newestId, "body_metrics", bodyId, "updated");
}

// ── The quiet stream (#2146) ─────────────────────────────────────────────────
//
// The measured off-wrist signature, on its own read-only profile: heart-rate minutes
// stop FIVE HOURS before the frozen clock (past the declared 2.5 h dip tolerance),
// the three days behind today carry data (so the shared #2097/#2146 expected-active
// gate passes), and Health Connect keeps recording SUCCESSFUL pushes right up to the
// present — which is the clause that separates "the watch is off" from "the phone is
// off" and keeps this out of the staleness detector's territory.
//
// Every instant is placed RELATIVE to the run's frozen clock, never at a fixed hour:
// the tolerance is measured in hours against `now`, so a fixed stamp would be quiet
// or live depending on when CI started. `hr_minutes.ts` and `integration_sync_events`
// both take canonical UTC instants (migrations 164 / 163) — `utcMinute` mints the
// former's bucket key exactly as ingest does.
export function seedQuietStream(): void {
  const profileId = fixtureProfileId(QUIET_STREAM_PROFILE);
  seedMemberLogin(E2E_LOGIN_QUIET_STREAM, profileId, "read");
  db.prepare(`DELETE FROM hr_minutes WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM integration_sync_events WHERE profile_id = ?`).run(
    profileId
  );
  upsertConnection(profileId, "health-connect", { status: "connected" });

  const clock = clockNow();
  const minute = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 63, 60, 'health-connect')`
  );
  // The gap: nothing on the stream for the last five hours.
  const quietSince = new Date(clock.getTime() - 5 * 3600_000);
  for (let back = 0; back < 30; back++) {
    minute.run(
      profileId,
      utcMinute(new Date(quietSince.getTime() - back * 60_000))
    );
  }
  // The days behind today, so the stream counts as one that WAS delivering. Placed a
  // day apart from the frozen clock, which the pinned timezone guarantees lands at
  // 13:mm local — so each stamp sits squarely inside its own local day.
  for (let back = 1; back <= 3; back++) {
    for (let m = 0; m < 5; m++) {
      minute.run(
        profileId,
        utcMinute(new Date(clock.getTime() - back * 86_400_000 - m * 60_000))
      );
    }
  }
  // The phone keeps pushing, successfully, carrying its own aggregates and nothing
  // for this stream. The connection is green; only the device went away.
  const push = db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, received, written, inserted, updated, unchanged)
     VALUES (?, 'health-connect', ?, 1, 12, 12, 0, 2, 10)`
  );
  for (const minutesAgo of [12, 47, 95, 150, 220, 285]) {
    push.run(
      profileId,
      utcMinute(new Date(clock.getTime() - minutesAgo * 60_000))
    );
  }

  console.log(
    `e2e: seeded quiet-stream fixture — profile ${profileId} (${QUIET_STREAM_PROFILE}), ` +
      `hr_minutes quiet for 5 h in ${getTimezone(profileId)} while pushes continue (#2146)`
  );
}

// ── The stream lifecycle (#2162) ─────────────────────────────────────────────
//
// Three profiles, because the three specs answer their offer in three different ways
// and a shared profile would let one spec's tap decide another's fixture. Each is
// built RELATIVE to the run's frozen clock and in its own profile-local timezone, and
// every `hr_minutes.ts` value is the canonical UTC minute the wall clock denotes
// (migration 164), minted the way ingest mints it.
//
// The lifecycle reads PROFILE-LOCAL days, so each fixture day is anchored at a wall
// clock (20:00) rather than at an offset from `now` — a fixed offset would drift
// across a local midnight and move a stream's first or last day by one.

/** Heart-rate minutes ending at a profile-local `day` + wall clock, canonical UTC. */
function seedStreamMinutes(
  profileId: number,
  tz: string,
  day: string,
  hhmm: string,
  minutes: number
): void {
  const end = zonedWallTimeToUtc(tz, day, hhmm);
  if (!end) return;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 63, 60, 'health-connect')`
  );
  for (let back = 0; back < minutes; back++)
    insert.run(profileId, utcMinute(new Date(end.getTime() - back * 60_000)));
}

/** A successful push, so the connection reads healthy the whole time. */
function seedStreamPush(profileId: number, at: Date): void {
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, received, written, inserted, updated, unchanged)
     VALUES (?, 'health-connect', ?, 1, 8, 8, 0, 2, 6)`
  ).run(profileId, utcMinute(at));
}

function resetStreamProfile(profileId: number): void {
  db.prepare(`DELETE FROM hr_minutes WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM integration_sync_events WHERE profile_id = ?`).run(
    profileId
  );
  db.prepare(`DELETE FROM upcoming_dismissals WHERE profile_id = ?`).run(
    profileId
  );
  upsertConnection(profileId, "health-connect", { status: "connected" });
}

export function seedStreamLifecycle(): void {
  const clock = clockNow();

  // APPEARED — the onboarding moment, twice over. Heart rate started arriving TODAY
  // and never before, and the bedtime reminder is off (it has never been touched, so
  // there is nothing to write: off is the absence of the setting).
  for (const [username, name] of [
    [E2E_LOGIN_STREAM_ONBOARD, STREAM_ONBOARD_PROFILE],
    [E2E_LOGIN_STREAM_DECLINE, STREAM_DECLINE_PROFILE],
  ] as const) {
    const profileId = fixtureProfileId(name);
    seedMemberLogin(username, profileId, "write");
    resetStreamProfile(profileId);
    const tz = getTimezone(profileId);
    seedStreamMinutes(profileId, tz, today(profileId), "07:40", 45);
    seedStreamPush(profileId, new Date(clock.getTime() - 20 * 60_000));
    console.log(
      `e2e: seeded stream-onboarding fixture — profile ${profileId} (${name}), ` +
        `first heart-rate minutes today in ${tz} (#2162)`
    );
  }

  // ENDED — two months of wear, then a fortnight of silence, with the reminder ON.
  // The gate closed itself around day three; the prompt exists to say so.
  const lapsedId = fixtureProfileId(STREAM_LAPSED_PROFILE);
  seedMemberLogin(E2E_LOGIN_STREAM_LAPSED, lapsedId, "write");
  resetStreamProfile(lapsedId);
  const lapsedTz = getTimezone(lapsedId);
  const lapsedToday = today(lapsedId);
  for (let back = 60; back >= 14; back--)
    seedStreamMinutes(
      lapsedId,
      lapsedTz,
      shiftDateStr(lapsedToday, -back),
      "20:00",
      4
    );
  // The phone keeps pushing right up to the present: the connection is green, only
  // the device went away — the same separation #2146 turns on.
  for (const minutesAgo of [18, 95, 240])
    seedStreamPush(lapsedId, new Date(clock.getTime() - minutesAgo * 60_000));
  setProfileWearReminder(lapsedId, true);
  console.log(
    `e2e: seeded stream-offboarding fixture — profile ${lapsedId} ` +
      `(${STREAM_LAPSED_PROFILE}), heart rate silent 14 days in ${lapsedTz} (#2162)`
  );
}
