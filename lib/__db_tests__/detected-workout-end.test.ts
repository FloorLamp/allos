// DB TIER — the detector PROPOSES the minute the heart rate says an open workout
// ended, and the person's Finish stamps it (#5194, reader 1 of #5113).
//
// The judgment is `detectedWorkoutEnd`'s and is pinned pure in
// lib/__tests__/exertion-window.test.ts. What these cases pin is everything the
// database adds around it: which row is asked about, that the trace is resolved to
// instants rather than read as local minutes, that a CONFIRMED finish stamps the
// detected minute and not the tap's own clock, and the refusals that leave the tap
// stamping its own instant as it always did.
//
// A refusal is asserted on `detectedWorkoutEndAt` rather than on the row, because
// nothing writes without a tap any more: there is no unattended pass whose absence a
// null `end_time` could be evidence of.
//
// Every value is synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { detectedWorkoutEndAt } from "@/lib/workout-detected-end";
import { finishWorkoutSession } from "@/lib/workout-finish";
import { getWorkoutPresence } from "@/lib/queries/presence";
import {
  renderStillGoingMessage,
  runStillGoingSuggest,
  stillGoingEpisodes,
} from "@/lib/notifications/still-going";
import {
  priorEventWindows,
  usualRecoveryMin,
} from "@/lib/queries/event-physiology";
import { utcSqlString } from "@/lib/date";
import { setSetting, setTimezone } from "@/lib/settings";
import { plainBody } from "@/lib/notifications/rich-text";
import { seedLoginTelegram } from "./fixtures";
import { sendMessageRaw, stubTelegramSends } from "./telegram-spies";

const NOW = new Date("2026-07-17T18:00:00Z");

/**
 * A profile whose day runs in a NAMED zone, never the host's (#5338).
 *
 * Without a `timezone` row a profile inherits the instance default, which is the
 * machine's own zone — so every case below silently asserted that the runner was in
 * UTC. It also hid the defect this file exists to catch: `getHrInstantsInRange` read
 * its stamps with `Date.parse`, which resolves a zoneless date-time in the HOST's zone,
 * and under a host in any other zone the whole trace moved by that offset. A fixture
 * that inherits the host zone moves the start with it and the two errors cancel.
 *
 * The zone is set ONCE here rather than by a second call at the case, because a
 * `setTimezone` onto a profile that already has a row records a travel-free SWITCH into
 * the history the sweep's neighbours read.
 */
function newProfile(name: string, tz = "UTC"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
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

describe("the confirmed finish stamps the minute the trace says", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("stamps the END THE TRACE SAYS, not the minute the person tapped", async () => {
    // THE DEFECT THIS PINS. The stale suggest's Finish stamped the tap instant, so a
    // session that ended at 16:35 finished at 18:00 and every derived reading was
    // measured over 85 minutes of sitting down. The clock is 18:00 here and the end is
    // 16:35, so the two are told apart rather than agreeing by accident.
    const p = newProfile("DetEnd");
    seedRestingHr(p, 60);
    // Elevated 16:00→16:35, then quiet through 17:00 — well past any usual recovery.
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(getWorkoutPresence(p, NOW).state).toBe("active");

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  it("leaves a bare wrist to the stale suggest", async () => {
    // The trace decides and never the clock: no HR minutes past the start means no
    // proposal, the nudge says what it always said, and a tap stamps its own instant.
    //
    // THE CONVERSE IS ASSERTED HERE, and it is the only place it can be: every other
    // refusal below reads a null, which a module that had simply stopped answering
    // would also produce. The clock is 18:00, so "no proposal" and "the tap's own
    // minute" are two different visible values rather than one absence.
    const p = newProfile("DetEndNoTrace");
    seedRestingHr(p, 60);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "18:00", duration_min: 120 });
  });

  it("refuses a profile with no resting range of its own", async () => {
    // No ceiling to compare against, and inventing one is the clinical band #4775
    // refuses. Same trace as the finishing case above — only the priors differ.
    const p = newProfile("DetEndNoCeiling");
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  it("leaves an empty husk to the draft expiry rather than finishing it", async () => {
    // A zero-content draft is not a session that ended; it is a Start nobody used.
    // `finishWorkoutSession` refuses it before it ever asks for a trace.
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
    expect(finishWorkoutSession(p, id).kind).toBe("empty-draft");
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
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
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
// They seed their own dates rather than the profile's today, because the reader takes
// no clock at all — the trace is the only thing that decides.

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

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  // F2. A session that starts at 23:50 ends on the next profile-local day, so there is
  // no instant at which `row.date === today` AND the closing quiet has been measured.
  // The presence gate made this case unreachable rather than merely late.
  it("finishes a session that started before local midnight and ended after it", async () => {
    const p = newProfile("DetEndMidnight", "UTC");
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

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
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
  // Seeds the timeline above on `day` in `zone`: a first effort, a rest longer than the
  // profile's recovery, and a second effort. `restsAfter` adds the quiet that ends the
  // whole trace, which is the difference between "still going" and "finished a while
  // ago" — and the difference the two cases below are built to keep apart.
  function seedTwoEfforts(
    name: string,
    day: string,
    restsAfter: boolean
  ): { p: number; id: number } {
    const p = newProfile(name, "America/New_York");
    seedRestingHrBefore(p, day, 60);
    // 00:40–01:20 EDT
    seedInstants(p, `${day}T04:40:00Z`, `${day}T05:20:00Z`, 140);
    // rest, 01:20–02:00 EDT
    seedInstants(p, `${day}T05:20:00Z`, `${day}T06:00:00Z`, 55);
    // a SECOND effort — on 2026-11-01 this is 01:00–01:35 EST, the same local minutes
    // as the first block's tail, which is what a fall-back hour does and what the round
    // trip could not tell apart from the first pass.
    seedInstants(p, `${day}T06:00:00Z`, `${day}T06:35:00Z`, 140);
    if (restsAfter) seedInstants(p, `${day}T06:35:00Z`, `${day}T07:15:00Z`, 55);
    const id = seedOpenWorkoutOn(p, day, "00:40", `${day}T04:45:00Z`);
    return { p, id };
  }

  // TWO EFFORTS, SO NOTHING IS WRITTEN — and that refusal is what the round trip could
  // not produce. Read as INSTANTS the two blocks are forty minutes apart, past this
  // profile's recovery, so the trace holds two efforts and does not say which one the
  // row was. Rebuilding them from local minutes lands the second block on 01:00–01:35
  // EDT, INSIDE the first block's rest, where it merges into one effort and the module
  // writes an end. The refusal is the assertion.
  //
  // Both states of the trace are asserted, because they refuse for different reasons and
  // a fixture that could not tell them apart would not notice either one going.
  it("refuses a fall-back day that holds two efforts, still going", async () => {
    const { p, id } = seedTwoEfforts("DetEndFallBack", "2026-11-01", false);
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  it("refuses it once they stop, too", async () => {
    const { p, id } = seedTwoEfforts(
      "DetEndFallBackRested",
      "2026-11-01",
      true
    );
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  // THE CONTROL THE PAIR ABOVE NEEDS, because two refusals are also what a module that
  // had simply stopped working in this zone would produce. One effort on the SAME
  // profile-local day of the SAME transition, and the end is the minute it really ended.
  it("still finishes a single effort on the transition day", async () => {
    const p = newProfile("DetEndFallBackSingle", "America/New_York");
    seedRestingHrBefore(p, "2026-11-01", 60);
    seedInstants(p, "2026-11-01T04:40:00Z", "2026-11-01T05:20:00Z", 140);
    seedInstants(p, "2026-11-01T05:20:00Z", "2026-11-01T06:00:00Z", 55);
    const id = seedOpenWorkoutOn(
      p,
      "2026-11-01",
      "00:40",
      "2026-11-01T04:45:00Z"
    );
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "01:20", duration_min: 40 });
  });

  // The ordinary-day control: the same timeline on a day with no transition in it reads
  // the same way in all three states. A zone that silenced the module, or a fall-back
  // hour that moved an answer, shows up as these disagreeing with their pair above.
  it("reads the same timeline the same way on an ordinary day", async () => {
    const going = seedTwoEfforts("DetEndControlGoing", "2026-10-25", false);
    expect(detectedWorkoutEndAt(going.p, going.id)).toBeNull();

    const rested = seedTwoEfforts("DetEndControlRested", "2026-10-25", true);
    expect(detectedWorkoutEndAt(rested.p, rested.id)).toBeNull();

    const single = newProfile("DetEndControlSingle", "America/New_York");
    seedRestingHrBefore(single, "2026-10-25", 60);
    seedInstants(single, "2026-10-25T04:40:00Z", "2026-10-25T05:20:00Z", 140);
    seedInstants(single, "2026-10-25T05:20:00Z", "2026-10-25T06:00:00Z", 55);
    const id = seedOpenWorkoutOn(
      single,
      "2026-10-25",
      "00:40",
      "2026-10-25T04:45:00Z"
    );
    expect(finishWorkoutSession(single, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "01:20", duration_min: 40 });
  });
});

// THE TWO SHAPES THE THIRD PASS DROVE, pinned end to end rather than only at the pure
// tier, because both were answers before. A refusal here means the nudge quotes no
// minute and a tap stamps its own instant, as it always did.
describe("the reader refuses what the third pass drove (#5212 R1, R2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // R1. The row was started at 08:00 and the wrist went on at 17:00. Taking the first
  // effort at or after the start answered `19:00` — eleven hours of "strength
  // training", worse than the hour-late tap this module exists to replace.
  it("says nothing when the start's own stretch has no elevated minute", () => {
    const p = newProfile("DetEndNoEffortAtStart");
    seedRestingHr(p, 60);
    // Measured the whole way, so the refusal is the start-containment bound and not the
    // coverage rule standing in for it.
    seedRange(p, "08:00", "18:00", 55);
    seedRange(p, "18:00", "19:00", 150);
    seedRange(p, "19:00", "19:40", 55);
    const id = seedOpenWorkout(p, "08:00", new Date("2026-07-17T08:20:00Z"));

    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  // R1's other half: the wrist goes on MID-RUN, so the trace begins elevated but hours
  // after the row did. It reads as one clean effort on its own terms, which is exactly
  // why the start has to be asked about separately.
  it("says nothing when the trace does not begin until hours after the start", () => {
    const p = newProfile("DetEndWristOnLate");
    seedRestingHr(p, 60);
    seedRange(p, "17:00", "17:40", 150);
    seedRange(p, "17:40", "18:20", 55);
    const id = seedOpenWorkout(p, "08:00", new Date("2026-07-17T08:20:00Z"));

    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  // R2, and it is the one that used to reach a send. A rest longer than this profile's
  // recovery closed the first effort, so the segmented trace hid a frontier that was
  // still ELEVATED and the row flipped `active → finished` mid-workout. Under
  // confirmation the same wrong answer would be a wrong sentence in the nudge and a
  // wrong minute if the person tapped it — smaller, and still worth refusing. The
  // `updated_at` cancel cannot catch it, because a set logged while still elevated
  // stamps BEFORE the candidate.
  it("proposes nothing while the trace is still elevated", () => {
    // The clock sits five minutes past the newest measured minute, because that is what
    // "still going" means and because presence has its own bounds: an hour later this
    // row reads `idle`, and the presence assertions below would be about the wrong
    // thing.
    vi.setSystemTime(new Date("2026-07-17T17:10:00Z"));
    const p = newProfile("DetEndStillGoing");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "16:55", 55); // a rest past the ten-minute default
    seedRange(p, "16:55", "17:05", 140); // and they are lifting again
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T17:00:00Z"));

    expect(getWorkoutPresence(p).state).toBe("active");
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
    // Still the dock's live session, so the Finish they could argue with is still there.
    expect(getWorkoutPresence(p).state).toBe("active");
  });

  // …and it is still refused once they stop. Answering the first half is what finished
  // somebody mid-workout; answering the second would end the session at a later effort's
  // minute. The trace holds two efforts, so it does not say.
  it("refuses that same trace once they stop, rather than picking a half", () => {
    const p = newProfile("DetEndStoppedForReal");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "16:55", 55);
    seedRange(p, "16:55", "17:05", 140);
    seedRange(p, "17:05", "17:45", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:20:00Z"));

    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  // THE CONTROL FOR ALL THREE, so a run of refusals cannot be a module that stopped
  // answering: the same profile and the same day, with the second effort taken out.
  it("finishes the same session when it is the day's only effort", () => {
    const p = newProfile("DetEndSingleEffortDay");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:45", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:20:00Z"));

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });
});

describe("one unmeasured minute is not a shorter rest (#5212 fifth pass)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // THE SAME PAIR OF EFFORTS, differing only in whether the HR minute 16:20 exists. The
  // rest between them is exactly this profile's recovery, so the trace holds two
  // efforts and the reader must refuse. Measured from the first quiet SAMPLE, the
  // missing minute read as a nine-minute rest, the efforts merged, and the answer was
  // `16:40` — a forty-minute session that never happened. The save stamp cannot cancel
  // it: the person stopped saving when the real first effort ended, so it precedes the
  // candidate.
  function seedTwoEffortsRestingTheRecovery(
    name: string,
    dropTransition: boolean
  ): { p: number; id: number } {
    const p = newProfile(name);
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:20", 140);
    seedRange(p, dropTransition ? "16:21" : "16:20", "16:30", 55);
    seedRange(p, "16:30", "16:40", 140);
    seedRange(p, "16:40", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    return { p, id };
  }

  it.each([
    ["contiguous", false],
    ["with 16:20 unmeasured", true],
  ])("refuses the pair %s", (_, drop) => {
    const { p, id } = seedTwoEffortsRestingTheRecovery(
      `DetEndDrop${drop}`,
      drop
    );
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });
});

describe("a usual recovery that rounds to 0 is absent (#5212 sixth pass)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // THE R2 CLASS THROUGH THE PRIORS. A session finished by the stale suggest's TAP has
  // its end stamped after the heart rate came down, so `recoveryMin` measures 0 for it,
  // and three of those are a usual of 0 with no zero guard between them and the
  // detector. Rounded to 0, the recovery emptied the frontier test and the answer was
  // `16:52` for somebody lifting at 140 — which the nudge would then have quoted at
  // them mid-session. The save stamp (16:30) cannot cancel a 16:52.
  /** A finished session on `day` in the shape the tap writes: resting well before the end. */
  function seedTapStampedPrior(profileId: number, day: string): void {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time, end_time, duration_min)
       VALUES (?, ?, 'strength', 'Session', '16:00', '17:00', 60)`
    ).run(profileId, day);
    seedInstants(profileId, `${day}T16:00:00Z`, `${day}T16:35:00Z`, 140);
    seedInstants(profileId, `${day}T16:35:00Z`, `${day}T17:30:00Z`, 55);
  }
  function seedLifterWithTapStampedPriors(name: string): {
    p: number;
    id: number;
  } {
    const p = newProfile(name);
    seedRestingHr(p, 60);
    for (const day of ["2026-07-14", "2026-07-15", "2026-07-16"])
      seedTapStampedPrior(p, day);
    seedRange(p, "16:00", "16:52", 140);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    // The door is real: the priors measure a 0 usual, not "no usual".
    expect(
      usualRecoveryMin(
        p,
        priorEventWindows(p, "strength", { date: today(p), id })
      )
    ).toBe(0);
    return { p, id };
  }

  it("proposes nothing while the trace is still elevated", () => {
    vi.setSystemTime(new Date("2026-07-17T16:52:00Z"));
    const { p, id } = seedLifterWithTapStampedPriors("DetEndZeroUsual");
    expect(getWorkoutPresence(p).state).toBe("active");
    expect(detectedWorkoutEndAt(p, id)).toBeNull();
  });

  // THE CONTROL: the 0 reads as the default, not as a profile the sweep refuses.
  it("finishes that same session once the default's quiet has arrived", () => {
    vi.setSystemTime(new Date("2026-07-17T17:06:00Z"));
    const { p, id } = seedLifterWithTapStampedPriors("DetEndZeroUsualRested");
    seedRange(p, "16:52", "17:05", 55);
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:52", duration_min: 52 });
  });
});

describe("a cross-midnight finish is visible to the safety tier (#5212 pass)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // ONE ROLLOVER RULE, NOT TWO. `finishWorkoutSession` stores an `HH:MM` against the
  // row's own date, so a session that started at 23:50 and ended at 00:20 has an
  // `end_time` EARLIER than its start. Every other reader of a session's span treats
  // that as a crossing (`activityWindow`); workout presence resolved it against the
  // row's date and read an end twenty-three and a half hours BEFORE the start — so the
  // row was never `finished` at any instant, and the safety-tier post-workout dose
  // delivery and the #924 recap were unreachable for it.
  //
  // It reaches an ordinary tapped finish too, but a back-dated end is how you MEET it:
  // a tap at 00:35 used to stamp 00:35 on the row's own day, and only the detected
  // minute puts the end on the far side of the start.
  it("reads as finished right after the tap, on a session that crossed midnight", async () => {
    // The clock sits just after the crossing, because `getWorkoutPresence` bounds its
    // read to `date >= today - 1` — a finish older than that is never `finished` to
    // presence, which is right rather than a gap: a post-workout dose reminder for a
    // session from weeks ago is not a reminder.
    vi.setSystemTime(new Date("2026-05-11T00:35:00Z"));
    const p = newProfile("DetEndMidnightSafety", "UTC");
    seedRestingHrBefore(p, "2026-05-10", 60);
    seedInstants(p, "2026-05-10T23:50:00Z", "2026-05-11T00:20:00Z", 140);
    seedInstants(p, "2026-05-11T00:20:00Z", "2026-05-11T01:00:00Z", 55);
    const id = seedOpenWorkoutOn(
      p,
      "2026-05-10",
      "23:50",
      "2026-05-10T23:55:00Z"
    );

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id).end_time).toBe("00:20");

    // A quarter of an hour after the end it crossed midnight at — inside the window
    // the finish dispatch reads.
    expect(getWorkoutPresence(p).state).toBe("finished");
  });
});

// THE PROPOSAL IS ONLY WORTH ANYTHING IF THE PERSON SEES IT (#5194, owner ruling
// 2026-09-06). The nudge that already asks "Still working out?" is where it goes: it is
// the one message carrying Finish and Discard, so the minute is quoted beside the button
// that will stamp it. No new notification, no new token, no new surface.
describe("the nudge carries the minute, and the tap stamps it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  /** The headline row: elevated 16:00–16:35, quiet after, last saved 16:30, clock 18:00. */
  function seedNudgeableSession(
    name: string,
    withTrace: boolean
  ): {
    p: number;
    id: number;
  } {
    const p = newProfile(name);
    seedRestingHr(p, 60);
    if (withTrace) {
      seedRange(p, "16:00", "16:35", 140);
      seedRange(p, "16:35", "17:00", 55);
    }
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    // The surface's own gate: the nudge only reaches a row that is live AND stale.
    const presence = getWorkoutPresence(p, NOW);
    expect(presence.state).toBe("active");
    expect(presence.stale).toBe(true);
    return { p, id };
  }

  it("quotes the detected minute in the body, and Finish stamps that minute", () => {
    const { p, id } = seedNudgeableSession("DetEndNudge", true);
    const episode = stillGoingEpisodes(p, NOW).find((e) => e.rowId === id);
    expect(episode?.detectedEnd).toBe("16:35");
    expect(renderStillGoingMessage(episode!, p, "Ada", "").body).toContain(
      "ended at 16:35"
    );
    // The button the body is talking about, through the same core the tap runs. Sent
    // and tapped at the SAME instant, which is the only case in which a second reading
    // of the trace cannot disagree with the first. What happens once time passes
    // between the two is the describe below — and it is why the minute is recorded.
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  // THE CONTROL, and it is the one that says the quoting is not unconditional: the same
  // row with no trace gets the copy this nudge has always had, and its Finish stamps the
  // tap's own instant exactly as before.
  it("says what it always said when the trace does not answer", () => {
    const { p, id } = seedNudgeableSession("DetEndNudgeBare", false);
    const episode = stillGoingEpisodes(p, NOW).find((e) => e.rowId === id);
    expect(episode?.detectedEnd).toBeNull();
    expect(renderStillGoingMessage(episode!, p, "Ada", "").body).toContain(
      "quiet for a while"
    );
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id).end_time).toBe("18:00");
  });
});

// THE MINUTE THE MESSAGE PROMISED IS THE MINUTE THE TAP STAMPS (#5194, eighth
// falsifying pass, F1).
//
// The nudge quoted the detected minute when it was SENT and the finish core asked the
// detector again when the button was TAPPED, with nothing carrying the first answer
// forward. Those are two readings of a moving trace, and they disagree in the ORDINARY
// case: a message naming 16:35 wrote 18:30 and a hundred and fifty minutes, and the
// person was told nothing — the answer text and the replacement title are both "Workout
// finished ✓". One measured minute six bpm above the resting ceiling anywhere later in
// the day is enough, so divergence was the expected outcome for any tap that was not
// immediate.
//
// Every case here drives the REAL send — `runStillGoingSuggest` through the stubbed
// Telegram primitives — because the promise only exists once a message carries it, and
// the recording happens on that path. Time then passes before the tap, which is the one
// thing no fixture on the shipped head did.
describe("what the nudge promised survives to the tap (#5194 F1)", () => {
  const SENT = new Date("2026-07-17T17:20:00Z");
  const TAP = new Date("2026-07-17T18:30:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubTelegramSends();
    setSetting("telegram_bot_token", "test-bot-token");
  });
  afterEach(() => vi.useRealTimers());

  /**
   * The pass's own fixture: 16:00–16:35 at 140 bpm, quiet after, last saved 16:30, and
   * a chat to send to. Returns the row and the body that was actually delivered.
   */
  async function nudged(name: string): Promise<{
    p: number;
    id: number;
    body: string;
  }> {
    const p = newProfile(name);
    seedLoginTelegram(p, `chat-${name}`);
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    sendMessageRaw.mockClear();

    vi.setSystemTime(SENT);
    await runStillGoingSuggest(p, "Ada", SENT);
    expect(sendMessageRaw).toHaveBeenCalledTimes(1);
    const [, sent] = sendMessageRaw.mock.calls[0];
    return { p, id, body: plainBody(sent.body) };
  }

  it("stamps the promised minute after an evening walk voids the reading", async () => {
    const { p, id, body } = await nudged("DetEndPromiseWalk");
    expect(body).toContain("ended at 16:35");

    // The notification sits in the chat. An ordinary evening: a fifteen-minute dog walk
    // at 17:45, then quiet again, then the thumb at 18:30.
    seedRange(p, "17:45", "18:00", 100);
    vi.setSystemTime(TAP);
    // THE CONTROL INSIDE THE CASE: the detector genuinely refuses now — a second effort
    // means the trace no longer says — so a tap that re-read would stamp 18:30 and 150
    // minutes. This line is what stops the assertion below from passing by coincidence.
    expect(detectedWorkoutEndAt(p, id)).toBeNull();

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  it("stamps it after a save moves the cancel past the candidate", async () => {
    const { p, id, body } = await nudged("DetEndPromiseSave");
    expect(body).toContain("ended at 16:35");

    // The second door, and it needs no heart rate at all: the person opens the app and
    // adds the set they forgot, so `updated_at` moves past the candidate minute and the
    // "a rest is not an end" cancel refuses.
    db.prepare("UPDATE activities SET updated_at = ? WHERE id = ?").run(
      utcSqlString(new Date("2026-07-17T17:35:00Z")),
      id
    );
    vi.setSystemTime(TAP);
    expect(detectedWorkoutEndAt(p, id)).toBeNull();

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });

  // THE REVERSE, which is the same mechanism from the other side. A message that names
  // no minute says "Finish it or discard the draft" — it promises the tap's own instant
  // — so a watch that syncs the whole session AFTER the send must not silently back-date
  // the row to a minute nobody was shown.
  it("keeps the tap's own minute when the message named none", async () => {
    const p = newProfile("DetEndPromiseBare");
    seedLoginTelegram(p, "chat-bare");
    seedRestingHr(p, 60);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    sendMessageRaw.mockClear();

    vi.setSystemTime(SENT);
    await runStillGoingSuggest(p, "Ada", SENT);
    expect(sendMessageRaw).toHaveBeenCalledTimes(1);
    expect(plainBody(sendMessageRaw.mock.calls[0][1].body)).toContain(
      "quiet for a while"
    );

    // The wrist syncs its backlog at 18:00: the whole session is suddenly on record.
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    vi.setSystemTime(TAP);
    expect(detectedWorkoutEndAt(p, id)).toEqual(
      new Date("2026-07-17T16:35:00Z")
    );

    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "18:30", duration_min: 150 });
  });

  // A FINISH NOBODY WAS SENT A MESSAGE ABOUT still reads the trace at the tap, which is
  // the request path (`finishWorkout`) and any future programmatic finish. There is no
  // promise to keep there, so the correction still rides it — this is the ordering the
  // core states, pinned from the side that has no record.
  it("still reads the trace for a finish no message proposed", async () => {
    const p = newProfile("DetEndNoPromise");
    seedRestingHr(p, 60);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));

    vi.setSystemTime(TAP);
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "16:35", duration_min: 35 });
  });
});
