import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr, utcInstant } from "@/lib/date";
import { seedActor, fd } from "@/lib/__action_tests__/harness";
import { retimeSleepSession } from "@/app/(app)/sleep/actions";

// DB INTEGRATION TIER — the Fix times action (#5021).
//
// `retimeSleepSessionCore` is pinned next door and takes INSTANTS. What is pinned here
// is the only thing this boundary adds and the only thing the core cannot check: two
// wall clocks stated against a wake day become one UTC window, through the same fold
// every stated sleep window in this app goes through. The bed clock is the half that
// can be wrong in a way nothing else would notice — 23:30 belongs to the night BEFORE
// the wake day, and folding it onto the wake day would move a session forward a day
// while every refusal still passed.

const PROVIDER = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";
const ASLEEP = 58;
const AWAKE = 74;
const MIN_MS = 60_000;

let profileId: number;
let day: string;

function sample(
  metric: string,
  startUtc: string,
  endUtc: string,
  value: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(profileId, PROVIDER, ORIGIN, metric, day, startUtc, endUtc, value)
      .lastInsertRowid
  );
}

function trace(from: string, to: string, trough: { from: string; to: string }) {
  const stmt = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, source, bpm, bpm_min, bpm_max, n)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const lo = Date.parse(trough.from);
  const hi = Date.parse(trough.to);
  for (let at = Date.parse(from); at < Date.parse(to); at += MIN_MS) {
    const bpm = at >= lo && at < hi ? ASLEEP : AWAKE;
    stmt.run(profileId, utcInstant(new Date(at)), PROVIDER, bpm, bpm, bpm);
  }
}

/** The sighting: a 298-minute night stamped +6h, with a stage row under it. */
function hedgedNight(): { sessionId: number; stageId: number } {
  const sessionId = sample(
    "sleep_min",
    `${day}T09:39:00Z`,
    `${day}T14:37:00Z`,
    298
  );
  const stageId = sample(
    "sleep_deep_min",
    `${day}T10:00:00Z`,
    `${day}T11:00:00Z`,
    60
  );
  trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
    from: `${day}T03:39:00Z`,
    to: `${day}T08:37:00Z`,
  });
  return { sessionId, stageId };
}

const rowOf = (id: number) =>
  db
    .prepare(
      `SELECT date, started_at, ended_at, edited FROM metric_samples
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as {
    date: string;
    started_at: string;
    ended_at: string;
    edited: number;
  };

beforeEach(() => {
  db.exec("DELETE FROM metric_samples");
  db.exec("DELETE FROM hr_minutes");
  const actor = seedActor({ profileName: "RETIME ACTION" });
  profileId = actor.profile.id;
  setTimezone(profileId, "UTC");
  day = shiftDateStr(today(profileId), -1);
});

describe("retimeSleepSession", () => {
  it("folds a bed time before midnight onto the night BEFORE the wake day", async () => {
    const { sessionId, stageId } = hedgedNight();
    // 03:39 → 08:37 is the same 298 minutes the session stores, six hours earlier.
    const result = await retimeSleepSession(
      fd({
        sample_id: sessionId,
        date: day,
        bed_time: "03:39",
        wake_time: "08:37",
      })
    );
    expect(result.error).toBeUndefined();
    expect(result.undoId).not.toBeNull();

    const session = rowOf(sessionId);
    expect(session.started_at).toBe(`${day}T03:39:00Z`);
    expect(session.ended_at).toBe(`${day}T08:37:00Z`);
    expect(session.edited).toBe(1);
    // The stage moved by the SAME delta, not onto the stated window.
    expect(rowOf(stageId).started_at).toBe(`${day}T04:00:00Z`);
  });

  it("puts a bed time at or after noon on the previous calendar day", async () => {
    const { sessionId } = hedgedNight();
    // A 22:00 bed with a 02:58 wake is the same 298 minutes — but only if 22:00 is
    // read as the evening BEFORE the wake day. Read on the wake day it is inverted,
    // and the core would refuse it as a length change.
    const result = await retimeSleepSession(
      fd({
        sample_id: sessionId,
        date: day,
        bed_time: "22:00",
        wake_time: "02:58",
      })
    );
    expect(result.error).toBeUndefined();

    const session = rowOf(sessionId);
    expect(session.started_at).toBe(`${shiftDateStr(day, -1)}T22:00:00Z`);
    expect(session.ended_at).toBe(`${day}T02:58:00Z`);
    // And the row is filed under the day it WOKE on, which did not change here.
    expect(session.date).toBe(day);
  });

  it("refuses a stated window of a different length and moves nothing", async () => {
    const { sessionId } = hedgedNight();
    const before = rowOf(sessionId);
    const result = await retimeSleepSession(
      fd({
        sample_id: sessionId,
        date: day,
        bed_time: "03:39",
        wake_time: "09:39",
      })
    );

    // The number a person needs in order to answer it.
    expect(result.error).toContain("4h 58m");
    expect(result.undoId).toBeNull();
    expect(rowOf(sessionId)).toEqual(before);
  });

  it("refuses a half-stated window before it reaches the store", async () => {
    const { sessionId } = hedgedNight();
    const before = rowOf(sessionId);
    const result = await retimeSleepSession(
      fd({ sample_id: sessionId, date: day, bed_time: "03:39", wake_time: "" })
    );

    expect(result.error).toBe("Enter a bed time and a wake time.");
    expect(rowOf(sessionId)).toEqual(before);
  });
});
