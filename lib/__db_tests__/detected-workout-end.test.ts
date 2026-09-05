// DB TIER — the open workout finishes itself at the minute its heart rate says it
// ended (#5194, reader 1 of #5113).
//
// The judgment is `detectedWorkoutEnd`'s and is pinned pure in
// lib/__tests__/exertion-window.test.ts. What these cases pin is everything the
// database adds around it: which row is asked about, that the trace is resolved to
// instants rather than read as local minutes, that the END WRITTEN is the detected
// minute and not the sweep's own clock, and the two refusals that keep the stale
// suggest as the fallback.
//
// Every value is synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { finishDetectedWorkouts } from "@/lib/workout-detected-end";
import { getWorkoutPresence } from "@/lib/queries/presence";
import { utcSqlString } from "@/lib/date";

const NOW = new Date("2026-07-17T18:00:00Z");

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

/** A resting range of their own — without one this module refuses to guess (#4775). */
function seedRestingHr(profileId: number, bpm: number): void {
  const ins = db.prepare(
    "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
  );
  for (let i = 1; i <= 10; i++) {
    const d = new Date(
      Date.parse(`${today(profileId)}T00:00:00Z`) - i * 86_400_000
    );
    ins.run(profileId, d.toISOString().slice(0, 10), bpm);
  }
}

/**
 * One measured minute. `ts` is stored as `YYYY-MM-DDTHH:MM` — the shape every other
 * `hr_minutes` fixture uses and the shape `localDaySpan`'s bounds are compared against
 * as STRINGS. A space separator sorts before `T`, so a `YYYY-MM-DD HH:MM:SS` stamp
 * falls outside every window and reads as a profile with no trace at all.
 */
function seedHr(profileId: number, at: string, bpm: number): void {
  db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'health-connect')"
  ).run(profileId, at, bpm);
}

/** Minute-by-minute trace between two clock times on the profile's today. */
function seedRange(
  profileId: number,
  fromHhmm: string,
  toHhmm: string,
  bpm: number
): void {
  const day = today(profileId);
  let t = Date.parse(`${day}T${fromHhmm}:00Z`);
  const end = Date.parse(`${day}T${toHhmm}:00Z`);
  while (t < end) {
    seedHr(profileId, new Date(t).toISOString().slice(0, 16), bpm);
    t += 60_000;
  }
}

/**
 * The live-draft signature computeWorkoutPresence reads as `active`, WITH a set on it.
 *
 * The set is not decoration: `finishWorkoutSession` refuses a zero-content draft as a
 * husk (#1205 §4, `hasLoggedContent`), and rightly — an abandoned empty row is
 * `expireWorkoutDrafts`'s to delete, not this sweep's to finish. `withContent: false`
 * is the case that pins that refusal.
 */
function seedOpenWorkout(
  profileId: number,
  startHhmm: string,
  touchedAt: Date,
  withContent = true
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, start_time, updated_at)
         VALUES (?, ?, 'strength', 'Session', ?, ?)`
      )
      .run(profileId, today(profileId), startHhmm, utcSqlString(touchedAt))
      .lastInsertRowid
  );
  if (withContent)
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 60, 5)`
    ).run(id);
  return id;
}

function rowOf(id: number): {
  end_time: string | null;
  duration_min: number | null;
} {
  return db
    .prepare("SELECT end_time, duration_min FROM activities WHERE id = ?")
    .get(id) as { end_time: string | null; duration_min: number | null };
}

describe("the open workout finishes itself", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("stamps the END THE TRACE SAYS, not the minute the sweep ran", async () => {
    // THE DEFECT THIS PINS. The stale suggest's Finish stamps the tap instant, so a
    // session that ended at 16:35 finished at 18:00 and every derived reading was
    // measured over 85 minutes of sitting down.
    const p = newProfile("DetEnd");
    seedRestingHr(p, 60);
    // Elevated 16:00→16:35, then quiet through 17:00 — well past any usual recovery.
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(getWorkoutPresence(p, NOW).state).toBe("active");

    expect(finishDetectedWorkouts(p, NOW)).toBe(1);
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  it("is idempotent — a second pass has nothing left to find", async () => {
    const p = newProfile("DetEndTwice");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(finishDetectedWorkouts(p, NOW)).toBe(1);
    expect(finishDetectedWorkouts(p, NOW)).toBe(0);
  });

  it("leaves a bare wrist to the stale suggest", async () => {
    // The trace decides and never the clock: no HR minutes past the start means no
    // answer, and the row stays open for the nudge that already exists.
    const p = newProfile("DetEndNoTrace");
    seedRestingHr(p, 60);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(finishDetectedWorkouts(p, NOW)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
    expect(getWorkoutPresence(p, NOW).state).toBe("active");
  });

  it("refuses a profile with no resting range of its own", async () => {
    // No ceiling to compare against, and inventing one is the clinical band #4775
    // refuses. Same trace as the finishing case above — only the priors differ.
    const p = newProfile("DetEndNoCeiling");
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(finishDetectedWorkouts(p, NOW)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
  });

  it("leaves an empty husk to the draft expiry rather than finishing it", async () => {
    // A zero-content draft is not a session that ended; it is a Start nobody used.
    // `finishWorkoutSession` refuses it, and this sweep must not paper over that.
    const p = newProfile("DetEndHusk");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(
      p,
      "16:00",
      new Date("2026-07-17T16:30:00Z"),
      false
    );
    expect(finishDetectedWorkouts(p, NOW)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
  });

  it("a save after the candidate minute cancels it", async () => {
    // A REST IS NOT AN END. `exercise_sets` carries no instant, so the save stamp is
    // the cancel — stricter than a set, because every edit bumps it too. Same trace
    // as the finishing case; only `updated_at` moves.
    const p = newProfile("DetEndSaved");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:50:00Z"));
    expect(finishDetectedWorkouts(p, NOW)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
  });
});
