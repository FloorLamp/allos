// DB INTEGRATION TIER — the workout-reminder presence gates (issue #981) end-to-end
// through the tick's marker discipline. The pure gate matrix lives in
// lib/__tests__/workout-presence-gate.test.ts; this tier proves the property the pure
// tier structurally can't see: a HELD/SKIPPED attempt sets NO `notify_last_workout`
// marker (so the slot resumes normally next tick), and a later attempt after the draft
// is discarded fires and marks.
//
// The tick (scripts/notify.ts) marks the workout slot ONLY when its build() returns a
// message that then delivers; a null build (our hold/skip) is nothing-due and never
// marks. `tickWorkoutSlot` below is a faithful copy of that exact per-slot loop over
// the REAL buildWorkoutTargetReminder → recommendWorkout → presence gate path, so the
// marker-neutrality is asserted against the same code the tick runs.
//
// Every value is synthetic (a fake profile + a fake cardio "walk"; no PHI).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileSetting, getProfileSetting } from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import { buildWorkoutTargetReminder } from "@/lib/notifications/workouts";
import { seedProfile } from "./fixtures";

const WORKOUT_MARKER = "notify_last_workout";

// Mirror scripts/notify.ts's dueSlots loop for the "workout" slot: already-marked ⇒
// skip; build null ⇒ nothing due (NO marker); else deliver ⇒ mark on delivery. Returns
// what the tick would do this attempt.
function tickWorkoutSlot(profileId: number, now: Date): "sent" | "nothing-due" {
  const date = today(profileId);
  if (getProfileSetting(profileId, WORKOUT_MARKER) === date) return "sent";
  const built = buildWorkoutTargetReminder(profileId, undefined, now);
  if (!built) return "nothing-due"; // marker-neutral: nothing built, nothing marked
  setProfileSetting(profileId, WORKOUT_MARKER, date); // delivered ⇒ mark
  return "sent";
}

// A live (manual, un-ended) draft touched `quietMin` ago — reads as `active`.
function insertActiveDraft(profileId: number, now: Date, quietMin = 2): number {
  const touch = utcSqlString(new Date(now.getTime() - quietMin * 60_000));
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Live draft', '13:00', NULL, NULL, ?, ?, NULL)`
      )
      .run(profileId, today(profileId), touch, touch).lastInsertRowid
  );
}

// A completed manual cardio "walk" whose end instant is `ageMin` before now (in a
// UTC-tz profile, wall time = UTC), crediting a `type:'cardio'` target. The row's
// `date` comes from the SAME end instant, not today(profileId): the presence gate
// reconstructs the finish instant as zonedWallTimeToUtc(tz, date, end_time), and a
// suite run in the first `ageMin` minutes after UTC midnight puts the end wall
// clock on YESTERDAY — pairing it with today's date claimed a finish ~24h in the
// FUTURE, so the gate saw no recent finish and the reminder fired (the #990
// date-boundary fixture class; this was its last surviving instance).
function insertFinishedWalk(profileId: number, now: Date, ageMin = 20): number {
  const end = new Date(now.getTime() - ageMin * 60_000);
  const date = end.toISOString().slice(0, 10); // UTC profile: local date = UTC date
  const hh = String(end.getUTCHours()).padStart(2, "0");
  const mm = String(end.getUTCMinutes()).padStart(2, "0");
  const created = utcSqlString(end);
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            created_at, updated_at, source)
         VALUES (?, ?, 'cardio', 'Dog walk', '12:40', ?, NULL, ?, ?, NULL)`
      )
      .run(profileId, date, `${hh}:${mm}`, created, created).lastInsertRowid
  );
}

// A seeded profile whose baseline workout reminder fires (seedProfile logs a strength
// session today, so the shared #221 core produces a rest/on-track note), pinned to UTC
// and carrying a behind cardio ("walk") type target.
function setup(tag: string): number {
  const { profileId } = seedProfile(tag);
  setProfileSetting(profileId, "timezone", "UTC");
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
     VALUES (?, 'type', 'cardio', 5)`
  ).run(profileId);
  return profileId;
}

describe("workout-reminder presence gates through the tick (#981)", () => {
  it("baseline (idle) fires and marks the slot", () => {
    const p = setup("GateBaseline");
    const now = new Date();
    expect(buildWorkoutTargetReminder(p, undefined, now)).not.toBeNull();
    expect(tickWorkoutSlot(p, now)).toBe("sent");
    expect(getProfileSetting(p, WORKOUT_MARKER)).toBe(today(p));
  });

  it("a live session HOLDS the reminder and sets NO marker", () => {
    const p = setup("GateHold");
    const now = new Date();
    insertActiveDraft(p, now);
    // Held: recommendWorkout returns null → build null → nothing due.
    expect(buildWorkoutTargetReminder(p, undefined, now)).toBeNull();
    expect(tickWorkoutSlot(p, now)).toBe("nothing-due");
    expect(getProfileSetting(p, WORKOUT_MARKER)).toBeUndefined();
  });

  it("a credit-bearing finish in the window SKIPS the reminder and sets NO marker", () => {
    const p = setup("GateSkip");
    const now = new Date();
    insertFinishedWalk(p, now); // cardio finish credits the behind cardio target
    expect(buildWorkoutTargetReminder(p, undefined, now)).toBeNull();
    expect(tickWorkoutSlot(p, now)).toBe("nothing-due");
    expect(getProfileSetting(p, WORKOUT_MARKER)).toBeUndefined();
  });

  it("a later attempt after the draft is discarded fires and marks (marker untouched by the hold)", () => {
    const p = setup("GateResume");
    const now = new Date();
    const draftId = insertActiveDraft(p, now);
    // First attempt: held, no marker.
    expect(tickWorkoutSlot(p, now)).toBe("nothing-due");
    expect(getProfileSetting(p, WORKOUT_MARKER)).toBeUndefined();
    // Discard the draft — the false start is gone.
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      draftId,
      p
    );
    // Next scheduled attempt evaluates fresh → fires and marks.
    expect(tickWorkoutSlot(p, now)).toBe("sent");
    expect(getProfileSetting(p, WORKOUT_MARKER)).toBe(today(p));
  });
});
