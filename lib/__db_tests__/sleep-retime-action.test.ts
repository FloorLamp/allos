import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr, utcInstant } from "@/lib/date";
import { setProfileSetting } from "@/lib/settings/kv";
import { serializeTimezoneSwitches } from "@/lib/travel-timezone";
import { seedActor, fd } from "@/lib/__action_tests__/harness";
import { retimeSleepSession } from "@/app/(app)/sleep/actions";
import { getSleepMoodData } from "@/lib/queries/sleep";

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

describe("which zone reads the typed clocks (#5125)", () => {
  // THE RULE: the zone in force at the night's own stored wake, not the profile's zone
  // today. The dialog prints the stored window through the historical zone
  // (`getSleepMoodData`, #3428 / `cc7a4c3b`), the person edits against that printed
  // line, and a display and its interpretation have to be inverses. Read through the
  // CURRENT zone instead, a one-hour nudge moved this row NINE hours — and because the
  // fold preserves elapsed length, `length-changed` and every other refusal stayed
  // silent. `resolveSleepWindow`'s current-zone rule is unchanged for manual entry and
  // the offline replay, which state a window nobody read back first.
  it("moves the row ONE hour for a one-hour nudge, after a recorded zone switch", async () => {
    setTimezone(profileId, "Europe/London");
    const prev = shiftDateStr(day, -1);
    // The night ran while the profile's day was in Tokyo; it flew home afterwards.
    setProfileSetting(
      profileId,
      "timezone_switches",
      serializeTimezoneSwitches([
        { at: `${day}T18:00:00Z`, from: "Asia/Tokyo", to: "Europe/London" },
      ])
    );
    const sessionId = sample(
      "sleep_min",
      `${prev}T20:30:00Z`,
      `${day}T03:40:00Z`,
      430
    );
    trace(`${prev}T06:00:00Z`, `${day}T12:00:00Z`, {
      from: `${prev}T14:00:00Z`,
      to: `${prev}T21:10:00Z`,
    });

    // The two clocks the dialog puts on screen, read off the same projection it uses.
    const shown = getSleepMoodData(profileId).history.find(
      (r) => r.date === day
    )?.sleepClaimedWindow;
    expect(shown).toBeTruthy();
    /** The displayed clock, one hour later — what a person nudging both fields types. */
    const nudged = (minutes: number) => {
      const at = (minutes + 60) % 1440;
      return `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(
        at % 60
      ).padStart(2, "0")}`;
    };

    const result = await retimeSleepSession(
      fd({
        sample_id: sessionId,
        date: day,
        bed_time: nudged(shown!.startMinutes),
        wake_time: nudged(shown!.endMinutes),
      })
    );
    expect(result.error).toBeUndefined();
    // One hour later than it was, not nine.
    expect(rowOf(sessionId).started_at).toBe(`${prev}T21:30:00Z`);
    expect(rowOf(sessionId).ended_at).toBe(`${day}T04:40:00Z`);
  });
});

describe("a night stored twice, through this door (#5125)", () => {
  it("refuses, and names the door that resolves the duplicate", async () => {
    const { sessionId, stageId } = hedgedNight();
    sample("sleep_min", `${day}T09:41:00Z`, `${day}T14:35:00Z`, 294);
    const before = { session: rowOf(sessionId), stage: rowOf(stageId) };

    const result = await retimeSleepSession(
      fd({
        sample_id: sessionId,
        date: day,
        bed_time: "03:39",
        wake_time: "08:37",
      })
    );

    expect(result.error).toContain("stored twice");
    expect(result.undoId).toBeNull();
    // Nothing moved, so the dialog's "The sleep stages move with the session." is not
    // contradicted by the one path that used to contradict it.
    expect(rowOf(sessionId)).toEqual(before.session);
    expect(rowOf(stageId)).toEqual(before.stage);
  });
});
