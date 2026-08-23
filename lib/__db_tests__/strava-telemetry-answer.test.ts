// DB INTEGRATION TIER — #3037: a hand-entered Strava session stops being a
// permanent backfill candidate, and the badge can reach zero.
//
// Owner ruling, 2026-08-16: store what the source says. `activity_telemetry.answer`
// carries `streams` / `none`; no row, or a NULL answer, means never asked. The
// three cases below are the three the ruling names, and the last one is the subtle
// one — a pre-column empty row must NOT be read as "the source said nothing",
// because before #3034 the sync wrote one on a transient failure and on a 403.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  countAnsweredNoneStravaSessions,
  countMissingStravaSessionDetails,
  recheckStravaAnsweredSessions,
} from "@/lib/integrations/strava-sync";
import { upsertActivityTelemetry } from "@/lib/integrations/activity-telemetry";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";

const SOURCE = "strava";
const MIGRATION = "20260823-telemetry-source-answer";

let profileId: number;

function addActivity(externalId: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source, external_id)
         VALUES (?, '2026-08-03', 'cardio', 'Walk', ?, ?)`
      )
      .run(profileId, SOURCE, externalId).lastInsertRowid
  );
}

function answerOf(activityId: number): string | null {
  return (
    db
      .prepare(
        "SELECT answer FROM activity_telemetry WHERE profile_id = ? AND activity_id = ? AND source = ?"
      )
      .get(profileId, activityId, SOURCE) as { answer: string | null }
  ).answer;
}

function telemetry(externalId: string, streams: Record<string, unknown>) {
  return {
    external_id: externalId,
    streams,
    ftp_w: null,
    heart_rate_zones: null,
    power_zones: null,
    snapshot_at: "2026-08-23T12:00:00.000Z",
  };
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-ANSWER')").run()
      .lastInsertRowid
  );
});

describe("the source's answer decides candidacy (#3037)", () => {
  it("a session the source answered `none` for leaves the candidate set", () => {
    const id = addActivity("strava:1001");
    expect(countMissingStravaSessionDetails(profileId)).toBe(1);

    upsertActivityTelemetry(profileId, [telemetry("strava:1001", {})], SOURCE);
    expect(answerOf(id)).toBe("none");
    // The whole complaint: the badge reaches zero.
    expect(countMissingStravaSessionDetails(profileId)).toBe(0);
    expect(countAnsweredNoneStravaSessions(profileId)).toBe(1);
  });

  it("a session with streams is answered too, and is not offered for re-check", () => {
    const id = addActivity("strava:1002");
    upsertActivityTelemetry(
      profileId,
      [telemetry("strava:1002", { time: { data: [0, 1] } })],
      SOURCE
    );
    expect(answerOf(id)).toBe("streams");
    expect(countMissingStravaSessionDetails(profileId)).toBe(0);
    // Nothing to recover — a re-check is about sessions we were told have nothing.
    expect(countAnsweredNoneStravaSessions(profileId)).toBe(0);
    expect(recheckStravaAnsweredSessions(profileId)).toBe(0);
    expect(answerOf(id)).toBe("streams");
  });

  it("an unanswered session with an EMPTY pre-column row is still a candidate", () => {
    const id = addActivity("strava:1003");
    // Exactly what a pre-#3034 transient failure or 403 left behind.
    db.prepare(
      `INSERT INTO activity_telemetry
         (profile_id, activity_id, source, streams_json, snapshot_at, answer)
       VALUES (?, ?, ?, '{}', '2026-08-01T00:00:00.000Z', NULL)`
    ).run(profileId, id, SOURCE);
    expect(countMissingStravaSessionDetails(profileId)).toBe(1);
    expect(countAnsweredNoneStravaSessions(profileId)).toBe(0);

    // It gets ONE more fair ask, then classifies itself and leaves for good — even
    // though the bytes it stores do not change. That is why `answer` counts toward
    // row equality in the upsert.
    upsertActivityTelemetry(profileId, [telemetry("strava:1003", {})], SOURCE);
    expect(answerOf(id)).toBe("none");
    expect(countMissingStravaSessionDetails(profileId)).toBe(0);
  });

  it("the explicit re-check forgets only `none`, and only for this profile", () => {
    const mine = addActivity("strava:1004");
    upsertActivityTelemetry(profileId, [telemetry("strava:1004", {})], SOURCE);
    const otherProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-OTHER')").run()
        .lastInsertRowid
    );
    const theirs = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, source, external_id)
           VALUES (?, '2026-08-03', 'cardio', 'Walk', ?, 'strava:1005')`
        )
        .run(otherProfile, SOURCE).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO activity_telemetry
         (profile_id, activity_id, source, streams_json, snapshot_at, answer)
       VALUES (?, ?, ?, '{}', '2026-08-01T00:00:00.000Z', 'none')`
    ).run(otherProfile, theirs, SOURCE);

    expect(recheckStravaAnsweredSessions(profileId)).toBe(1);
    expect(answerOf(mine)).toBe(null);
    expect(countMissingStravaSessionDetails(profileId)).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT answer FROM activity_telemetry WHERE profile_id = ? AND activity_id = ?"
          )
          .get(otherProfile, theirs) as { answer: string | null }
      ).answer
    ).toBe("none");
  });
});

describe(`${MIGRATION} classifies existing rows asymmetrically`, () => {
  it("backfills `streams` from stored data and leaves an empty row UNKNOWN", () => {
    const before = migrationsBefore(MIGRATION);
    const fresh = new Database(":memory:");
    runMigrations(fresh, before);
    try {
      fresh
        .prepare("INSERT INTO profiles (id, name) VALUES (1, 'BEFORE')")
        .run();
      for (const [id, external, streams] of [
        [1, "strava:2001", '{"time":{"data":[0,1]}}'],
        [2, "strava:2002", "{}"],
        [3, "strava:2003", ""],
      ] as const) {
        fresh
          .prepare(
            `INSERT INTO activities (id, profile_id, date, type, title, source, external_id)
             VALUES (?, 1, '2026-08-03', 'cardio', 'Ride', 'strava', ?)`
          )
          .run(id, external);
        fresh
          .prepare(
            `INSERT INTO activity_telemetry
               (profile_id, activity_id, source, streams_json, snapshot_at)
             VALUES (1, ?, 'strava', ?, '2026-08-01T00:00:00.000Z')`
          )
          .run(id, streams);
      }

      // Finish the chain — the migration under test is the only one left.
      runMigrations(fresh);

      const answers = (
        fresh
          .prepare(
            "SELECT activity_id, answer FROM activity_telemetry ORDER BY activity_id"
          )
          .all() as { activity_id: number; answer: string | null }[]
      ).map((r) => [r.activity_id, r.answer]);
      // The row with data is `streams`. The `{}` and the blank one stay NULL — an
      // empty row is not evidence the source answered, so classifying them would
      // abandon sessions that never got a fair ask.
      expect(answers).toEqual([
        [1, "streams"],
        [2, null],
        [3, null],
      ]);
    } finally {
      fresh.close();
    }
  });
});
