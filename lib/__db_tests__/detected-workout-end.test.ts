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
import { setTimezone } from "@/lib/settings";

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

    expect(finishDetectedWorkouts(p)).toBe(1);
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  it("is idempotent — a second pass has nothing left to find", async () => {
    const p = newProfile("DetEndTwice");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(finishDetectedWorkouts(p)).toBe(1);
    expect(finishDetectedWorkouts(p)).toBe(0);
  });

  it("leaves a bare wrist to the stale suggest", async () => {
    // The trace decides and never the clock: no HR minutes past the start means no
    // answer, and the row stays open for the nudge that already exists.
    const p = newProfile("DetEndNoTrace");
    seedRestingHr(p, 60);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(finishDetectedWorkouts(p)).toBe(0);
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
    expect(finishDetectedWorkouts(p)).toBe(0);
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
    expect(finishDetectedWorkouts(p)).toBe(0);
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
    expect(finishDetectedWorkouts(p)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
  });
});

// ── What the #5212 falsifying pass refuted ───────────────────────────────────
//
// These four cases exist because the first draft of this module asked
// `getWorkoutPresence` whether the EDITOR had a live session, and reconstructed its
// trace from local minute strings. Both were wrong in ways CI could not see: the
// presence gate carries the workout kind's own bounds, and a local minute is not a
// lossless spelling of an instant.
//
// They seed their own dates rather than the profile's today, because the sweep takes
// no clock at all now — the trace is the only thing that decides.

/** A resting range on a stated day rather than on the profile's today. */
function seedRestingHrBefore(
  profileId: number,
  day: string,
  bpm: number
): void {
  const ins = db.prepare(
    "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
  );
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.parse(`${day}T00:00:00Z`) - i * 86_400_000);
    ins.run(profileId, d.toISOString().slice(0, 10), bpm);
  }
}

/** Minute-by-minute trace between two UTC instants. */
function seedInstants(
  profileId: number,
  fromUtc: string,
  toUtc: string,
  bpm: number
): void {
  let t = Date.parse(fromUtc);
  const end = Date.parse(toUtc);
  while (t < end) {
    seedHr(profileId, new Date(t).toISOString().slice(0, 16), bpm);
    t += 60_000;
  }
}

/** An open draft on a stated day, with content. */
function seedOpenWorkoutOn(
  profileId: number,
  day: string,
  startHhmm: string,
  touchedAtUtc: string
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, start_time, updated_at)
         VALUES (?, ?, 'strength', 'Session', ?, ?)`
      )
      .run(profileId, day, startHhmm, utcSqlString(new Date(touchedAtUtc)))
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 60, 5)`
  ).run(id);
  return id;
}

describe("the row's shape decides, not the editor's mode (#5212 F1, F2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // F1. THE FORGOTTEN WORKOUT IS THE WHOLE POINT, and the presence gate was the one
  // thing that could never reach it. `active` requires the draft to be inside the
  // workout kind's abandon bound, and `updated_at` only moves forward — so at 91
  // minutes of quiet the row was unreachable permanently, which is precisely the case
  // this module's header opens with.
  it("finishes a draft that has been quiet far past the dock's bound", async () => {
    const p = newProfile("DetEndForgotten");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    // Last saved at 16:20 and the clock is 18:00 — a hundred minutes of quiet, past
    // the workout kind's abandon bound. The original fixture for this module used
    // 16:30, which is EXACTLY ninety and therefore the last minute the old presence
    // gate still worked on; one minute later the feature was a no-op forever.
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:20:00Z"));
    expect(getWorkoutPresence(p, NOW).state).toBe("idle");

    expect(finishDetectedWorkouts(p)).toBe(1);
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  // F2. A session that starts at 23:50 ends on the next profile-local day, so there is
  // no instant at which `row.date === today` AND the closing quiet has been measured.
  // The presence gate made this case unreachable rather than merely late.
  it("finishes a session that started before local midnight and ended after it", async () => {
    const p = newProfile("DetEndMidnight");
    setTimezone(p, "UTC");
    seedRestingHrBefore(p, "2026-05-10", 60);
    // 23:50 → 00:20 elevated, then quiet until 01:00 the next day.
    seedInstants(p, "2026-05-10T23:50:00Z", "2026-05-11T00:20:00Z", 140);
    seedInstants(p, "2026-05-11T00:20:00Z", "2026-05-11T01:00:00Z", 55);
    const id = seedOpenWorkoutOn(
      p,
      "2026-05-10",
      "23:50",
      "2026-05-10T23:55:00Z"
    );

    expect(finishDetectedWorkouts(p)).toBe(1);
    // The end is on the following clock day and the row keeps the day it started on —
    // `activityWindow` already reads an end earlier than its start as the crossing.
    //
    // `duration_min` STAYS NULL, and that is the shared core's existing behaviour
    // rather than anything this sweep does: `finishWorkoutSession` fills the duration
    // through `minutesBetween`, which answers null for an end at or before its start
    // rather than rolling past midnight. Every reader gets the span from
    // `activityWindow`, which does read the crossing, so the session is complete and
    // correctly shaped — it simply has no STORED duration. Pinned here because it is
    // the one thing about a crossing that differs from an ordinary finish, and a
    // future ruling to use the rolling sibling should red this line rather than pass
    // silently.
    expect(rowOf(id)).toEqual({ end_time: "00:20", duration_min: null });
  });
});

describe("the trace is read as instants, not rebuilt from local minutes (#5212 F3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // THE FALL-BACK HOUR. America/New_York, 2026-11-01: 02:00 EDT becomes 01:00 EST, so
  // every local minute from 01:00 to 01:59 happens TWICE. Reconstructing an instant
  // from one of those strings answers with the first pass for both, which stacks the
  // second hour of readings onto the first and moves the newest measured minute an
  // hour into the past.
  //
  // The person here is STILL LIFTING. They worked 00:40–01:20 EDT, rested, and are
  // back at 140 bpm from 01:00 EST. Under the round trip their current effort landed
  // on top of the earlier rest, the earlier rest became the quiet that closes the
  // session, and the save-stamp cancel could not save them because `updated_at` is a
  // real instant while the candidate had been shifted an hour back.
  it("does not finish a session still in progress across a fall-back hour", async () => {
    const p = newProfile("DetEndFallBack");
    setTimezone(p, "America/New_York");
    seedRestingHrBefore(p, "2026-11-01", 60);
    // 00:40–01:20 EDT
    seedInstants(p, "2026-11-01T04:40:00Z", "2026-11-01T05:20:00Z", 140);
    // rest, 01:20–02:00 EDT
    seedInstants(p, "2026-11-01T05:20:00Z", "2026-11-01T06:00:00Z", 55);
    // lifting again, 01:00–01:35 EST — the SAME local minutes as the first block's tail
    seedInstants(p, "2026-11-01T06:00:00Z", "2026-11-01T06:35:00Z", 140);
    const id = seedOpenWorkoutOn(
      p,
      "2026-11-01",
      "00:40",
      "2026-11-01T04:45:00Z"
    );

    expect(finishDetectedWorkouts(p)).toBe(0);
    expect(rowOf(id).end_time).toBeNull();
  });

  // The control, so the case above cannot pass for some unrelated refusal: the same
  // timeline a week earlier, with no transition in it, is also left open — and the
  // same timeline with a real closing quiet finishes, so the zone is not simply
  // silencing the module.
  it("reads the same timeline the same way on an ordinary day", async () => {
    const p = newProfile("DetEndFallBackControl");
    setTimezone(p, "America/New_York");
    seedRestingHrBefore(p, "2026-10-25", 60);
    seedInstants(p, "2026-10-25T04:40:00Z", "2026-10-25T05:20:00Z", 140);
    seedInstants(p, "2026-10-25T05:20:00Z", "2026-10-25T06:00:00Z", 55);
    seedInstants(p, "2026-10-25T06:00:00Z", "2026-10-25T06:35:00Z", 140);
    const still = seedOpenWorkoutOn(
      p,
      "2026-10-25",
      "00:40",
      "2026-10-25T04:45:00Z"
    );
    expect(finishDetectedWorkouts(p)).toBe(0);
    expect(rowOf(still).end_time).toBeNull();

    // …and once the effort really stops, the same profile and zone finish it.
    const q = newProfile("DetEndFallBackFinishes");
    setTimezone(q, "America/New_York");
    seedRestingHrBefore(q, "2026-10-25", 60);
    seedInstants(q, "2026-10-25T04:40:00Z", "2026-10-25T05:20:00Z", 140);
    seedInstants(q, "2026-10-25T05:20:00Z", "2026-10-25T06:35:00Z", 55);
    const done = seedOpenWorkoutOn(
      q,
      "2026-10-25",
      "00:40",
      "2026-10-25T04:45:00Z"
    );
    expect(finishDetectedWorkouts(q)).toBe(1);
    expect(rowOf(done).end_time).toBe("01:20");
  });
});

describe("a detected finish is visible to the safety tier (#5212 F4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // THE PROPERTY THE TICK ORDER EXISTS FOR. `runPostWorkoutFinish` — safety tier,
  // ungated by the waking window — delivers due post_workout doses the moment presence
  // reads `finished`, and that rests on `FINISHED_WINDOW_MIN`: a guarantee written when
  // every `finishWorkoutSession` caller stamped the tap's own instant. This sweep is
  // the first writer that stamps an end in the PAST.
  //
  // Swept AFTER the dispatch, the row was `idle` at the sweep instant and older than
  // the window by the next hourly tick, so the dose delivery and the #924 recap were
  // silenced for every session this feature ever finished. Swept BEFORE it, the end is
  // only the usual recovery old when the dispatch looks, and the window sees it exactly
  // as it sees a tapped finish. That is what this asserts: immediately after the sweep,
  // at the sweep's own instant, presence reads `finished`.
  it("reads as finished at the sweep instant, inside the window the dispatch uses", async () => {
    const p = newProfile("DetEndSafety");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));

    // The tick's own instant, a few minutes after the trace's closing quiet.
    const sweepAt = new Date("2026-07-17T17:00:00Z");
    expect(finishDetectedWorkouts(p)).toBe(1);
    expect(getWorkoutPresence(p, sweepAt).state).toBe("finished");

    // And an hour later it is outside the window, which is why the order matters
    // rather than being a preference: the next tick is already too late.
    expect(
      getWorkoutPresence(p, new Date("2026-07-17T18:00:00Z")).state
    ).not.toBe("finished");
  });
});
