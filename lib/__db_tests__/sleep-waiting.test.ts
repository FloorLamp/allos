import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import {
  getSleepArrivalLagMinutes,
  getSleepWaitingState,
  getSyncedSleepWakeDays,
} from "@/lib/queries/sleep";
import { isSleepTracking, MIN_ARRIVAL_SAMPLES } from "@/lib/sleep-waiting";

// DB INTEGRATION TIER — the morning waiting window's two data-side questions
// (#2097): is this profile currently sleep-tracking, and how long after a night
// ends does its row actually land.
//
// The first exists because the CONNECTION-side signal cannot answer it.
// `isStaleSyncEvent` watches the provider's liveness and lib/integrations/staleness.ts
// is explicit that this is deliberate — "a rest week with no activities is not
// staleness" — which makes it structurally blind to the abandoned device: watch in
// a drawer, phone still syncing steps, ok events with non-zero inserts, green
// badge, only the sleep rows stopped. That case gets its own fixture below rather
// than riding the failing-provider one, because the failing-provider fixture would
// pass while this regression sailed through.

const PROVIDER = "health-connect";
let profileId: number;
let T: string;

function night(date: string, source = PROVIDER, endHour = 6): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
      )
      .run(
        profileId,
        source,
        date,
        `${shiftDateStr(date, -1)}T23:00:00.000Z`,
        `${date}T${String(endHour).padStart(2, "0")}:00:00.000Z`
      ).lastInsertRowid
  );
}

// One sync event plus the provenance row that says it INSERTED a given sample, at a
// stated wall-clock instant — the join getSleepArrivalLagMinutes measures.
function arrival(sampleId: number, atUtcSql: string, ok = true): void {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, ?, 1)`
      )
      .run(profileId, PROVIDER, atUtcSql, ok ? 1 : 0).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, atUtcSql);
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_rows");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM metric_samples");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SLEEP-WAIT')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  T = today(profileId);
});

describe("getSyncedSleepWakeDays", () => {
  it("returns the synced wake-days inside the lookback, and only those", () => {
    night(shiftDateStr(T, -1));
    night(shiftDateStr(T, -2));
    night(shiftDateStr(T, -9)); // outside the lookback
    expect(getSyncedSleepWakeDays(profileId, T)).toEqual([
      shiftDateStr(T, -2),
      shiftDateStr(T, -1),
    ]);
  });

  it("excludes MANUAL nights — nobody is sending a hand-logged entry", () => {
    night(shiftDateStr(T, -1), "manual");
    night(shiftDateStr(T, -2), "manual");
    night(shiftDateStr(T, -3), "manual");
    expect(getSyncedSleepWakeDays(profileId, T)).toEqual([]);
    // …so a manual-only logger never enters the waiting state at any hour.
    expect(getSleepWaitingState(profileId, null)).toBeNull();
  });

  it("does not leak another profile's nights", () => {
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SLEEP-OTHER')").run()
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value)
       VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
    ).run(
      other,
      PROVIDER,
      shiftDateStr(T, -1),
      `${shiftDateStr(T, -2)}T23:00:00.000Z`,
      `${shiftDateStr(T, -1)}T06:00:00.000Z`
    );
    expect(getSyncedSleepWakeDays(profileId, T)).toEqual([]);
  });
});

describe("the abandoned device — the case the connection signal cannot see", () => {
  // The provider stays healthy the whole time: ok events with non-zero inserted
  // counts keep arriving (steps from the phone), so nothing on the connection side
  // ever fires. Only the sleep rows stop.
  function stillSyncingSteps(): void {
    db.prepare(
      `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
       VALUES (?, ?, datetime('now'), 1, 42)`
    ).run(profileId, PROVIDER);
  }

  it("asks on the FIRST morning after the last night, and never again", () => {
    // Nights recorded through wake-day A; the watch goes in the drawer after it.
    const A = shiftDateStr(T, -1);
    for (let back = 1; back <= 6; back++) night(shiftDateStr(A, -(back - 1)));
    stillSyncingSteps();

    // Morning A+1 (today): last night is missing, the three before it are all
    // there — this is the state the waiting copy is FOR.
    expect(isSleepTracking(getSyncedSleepWakeDays(profileId, T), T)).toBe(true);

    // Every morning after: the gap is two or more nights deep, so the profile has
    // stopped rather than "not synced yet". Without this the tile would ask again
    // every morning for roughly a fortnight — until typicalWakeTime ran out of
    // nights, which is an accidental reason to go quiet, not a decided one.
    for (let day = 2; day <= 14; day++) {
      const morning = shiftDateStr(T, day - 1);
      expect(
        isSleepTracking(getSyncedSleepWakeDays(profileId, morning), morning),
        `morning +${day}`
      ).toBe(false);
    }
  });

  it("routes an abandoned profile to the existing paths, at any hour", () => {
    // Two nights missing already: whatever the clock says, there is no named state
    // — the surfaces fall through to the dated label and then the stale CTA.
    for (let back = 3; back <= 8; back++) night(shiftDateStr(T, -back));
    stillSyncingSteps();
    expect(getSleepWaitingState(profileId, shiftDateStr(T, -3))).toBeNull();
  });
});

describe("getSleepArrivalLagMinutes", () => {
  // Wake at 06:00Z each night; the row lands at a stated clock time the same
  // morning. Lag is in minutes from the session END.
  function morning(back: number, arrivalHhmm: string): void {
    const date = shiftDateStr(T, -back);
    arrival(night(date), `${date} ${arrivalHhmm}:00`);
  }

  it("is the median arrival lag once the sample gate is met", () => {
    // 60, 65, 70, 75, 80 → median 70.
    const at = ["07:00", "07:05", "07:10", "07:15", "07:20"];
    at.forEach((hhmm, i) => morning(i + 1, hhmm));
    expect(MIN_ARRIVAL_SAMPLES).toBe(5);
    expect(getSleepArrivalLagMinutes(profileId)).toBe(70);
  });

  it("refuses to quote a median built on a thin sample", () => {
    // The retention-truncated case: integration_sync_rows reaches back ~12 days on
    // the measured instance, so this is the ordinary state of a young profile, not
    // an edge case. Under the gate the copy degrades to the plain wording.
    for (let i = 1; i <= MIN_ARRIVAL_SAMPLES - 1; i++) morning(i, "07:10");
    expect(getSleepArrivalLagMinutes(profileId)).toBeNull();
  });

  it("ignores an ARCHIVE backfill, whose lag is months", () => {
    // A Fitbit Takeout zip inserts hundreds of nights at once. Counting those would
    // quote an ETA measured on a one-off import instead of the daily rhythm.
    for (let i = 1; i <= 5; i++) morning(i, "07:10");
    for (let back = 40; back <= 60; back++) {
      const date = shiftDateStr(T, -back);
      arrival(night(date), `${T} 12:00:00`);
    }
    expect(getSleepArrivalLagMinutes(profileId)).toBe(70);
  });

  it("does not count another profile's arrivals", () => {
    for (let i = 1; i <= 5; i++) morning(i, "07:10");
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SLEEP-ARR-OTHER')").run()
        .lastInsertRowid
    );
    const otherEvent = Number(
      db
        .prepare(
          `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
           VALUES (?, ?, datetime('now'), 1, 1)`
        )
        .run(other, PROVIDER).lastInsertRowid
    );
    // Point the foreign event at THIS profile's sample: the join must reject it on
    // the event's profile, not merely on the sample's.
    const mine = db
      .prepare(
        `SELECT id FROM metric_samples WHERE profile_id = ? ORDER BY id LIMIT 1`
      )
      .get(profileId) as { id: number };
    db.prepare(
      `INSERT INTO integration_sync_rows
         (event_id, target_table, target_id, disposition, created_at)
       VALUES (?, 'metric_samples', ?, 'inserted', ?)`
    ).run(otherEvent, mine.id, `${T} 23:59:00`);
    expect(getSleepArrivalLagMinutes(profileId)).toBe(70);
  });
});
