import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "@/lib/__action_tests__/harness";
import { getOverlappingSleepSessions } from "@/lib/queries/sleep";
import { keepSleepSession } from "@/app/(app)/data/review-actions";

// DB INTEGRATION TIER — "Keep this one" on a night stored twice (#5021, deferred from
// #3628's decision 5).
//
// Review could see the pair and could only send the person to Manage data to identify
// the row again by hand. What is pinned here is that keeping one row IS deleting the
// other — through the one per-reading delete, with its re-import tombstone — and that
// the offer is bounded to a pair Review is actually listing.

const PROVIDER = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

let profileId: number;
let day: string;

function session(startUtc: string, endUtc: string, minutes: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, ?, 'sleep_min', ?, ?, ?, ?)`
      )
      .run(profileId, PROVIDER, ORIGIN, day, startUtc, endUtc, minutes)
      .lastInsertRowid
  );
}

const sleepIds = (): number[] =>
  (
    db
      .prepare(
        `SELECT id FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY id`
      )
      .all(profileId) as { id: number }[]
  ).map((r) => r.id);

const tombstoneCount = (): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM import_tombstones
          WHERE profile_id = ? AND target_table = 'metric_samples'`
      )
      .get(profileId) as { c: number }
  ).c;

beforeEach(() => {
  db.exec("DELETE FROM metric_samples");
  const actor = seedActor({ profileName: "OVERLAP KEEP" });
  profileId = actor.profile.id;
  setTimezone(profileId, "UTC");
  day = shiftDateStr(today(profileId), -1);
});

describe("keepSleepSession", () => {
  it("deletes the other copy, tombstones it, and clears the pair", async () => {
    const keep = session(
      `${shiftDateStr(day, -1)}T23:00:00Z`,
      `${day}T06:00:00Z`,
      420
    );
    const drop = session(`${day}T02:00:00Z`, `${day}T09:00:00Z`, 420);
    expect(getOverlappingSleepSessions(profileId)).toHaveLength(1);

    const result = await keepSleepSession(fd({ keep_id: keep, drop_id: drop }));

    expect(result.error).toBeUndefined();
    // Undoable, on the same capture every other delete offers.
    expect(result.undoId).not.toBeNull();
    expect(sleepIds()).toEqual([keep]);
    // And the dropped copy cannot land again on the next push.
    expect(tombstoneCount()).toBe(1);
    // The pair is gone because a row is gone — nothing was recorded to dismiss it.
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);
  });

  it("refuses two rows Review is not listing as one pair", async () => {
    const keep = session(
      `${shiftDateStr(day, -1)}T23:00:00Z`,
      `${day}T06:00:00Z`,
      420
    );
    // A nap the same day, overlapping nothing — a real row of this profile that no pair
    // names. Posting it as the drop half would be a delete nobody was offered.
    const unrelated = session(`${day}T13:00:00Z`, `${day}T14:00:00Z`, 60);
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);

    const result = await keepSleepSession(
      fd({ keep_id: keep, drop_id: unrelated })
    );

    expect(result.error).toBe("That pair is no longer listed.");
    expect(result.undoId).toBeNull();
    expect(sleepIds()).toEqual([keep, unrelated]);
    expect(tombstoneCount()).toBe(0);
  });

  it("is a no-op for a second press on an already-settled pair", async () => {
    const keep = session(
      `${shiftDateStr(day, -1)}T23:00:00Z`,
      `${day}T06:00:00Z`,
      420
    );
    const drop = session(`${day}T02:00:00Z`, `${day}T09:00:00Z`, 420);
    await keepSleepSession(fd({ keep_id: keep, drop_id: drop }));

    // A stale tab pressing the other side of a pair that is already settled.
    const again = await keepSleepSession(fd({ keep_id: drop, drop_id: keep }));

    expect(again.error).toBe("That pair is no longer listed.");
    expect(sleepIds()).toEqual([keep]);
  });
});
