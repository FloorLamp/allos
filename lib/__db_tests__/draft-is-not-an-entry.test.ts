// DB TIER — the remainder of the #3056 census: a create-at-start draft is an
// ADDRESS, not an entry (#3189, #3190, #3191).
//
// `isDraftActivityRow` (lib/activity-draft.ts) settles that a started manual session
// with no sets, no components, no note, no distance and no stored duration is a
// place to log into rather than something the person did. The Training Log's feed
// applied it; #3188 brought the week caption and the day strip along. This file
// covers every reader that was still counting the husk, and it is written as a
// CENSUS: each surface is read three times — with nothing, with one untouched draft,
// and again with a real logged activity — so a "the draft did not move it" assertion
// cannot pass by reading a number that could never have moved. That positive control
// is not decoration: the first pass of the original probe produced two "immune"
// readings that were artifacts of a fixture the reader could not see at all.
//
// AND ONE READER THAT MUST KEEP SEEING IT. `getWorkoutPresence` is immune BY INTENT
// — it is the dock's "you have a session running" surface, and the app deliberately
// KEEPS an abandoned draft so the dock can offer "finish or discard" rather than
// silently dropping a session someone started (#3163, #3170, #3056). Its case is at
// the bottom, and it is the reason none of the fixes here may be written as "delete
// the row" or "hide it everywhere".
//
// SYNTHETIC ONLY: fictional profiles, invented titles. No PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { utcSqlString } from "@/lib/date";
import {
  getActivityDates,
  getFrequencyTargetProgress,
  getProtocol,
  getProtocolUsage,
  getWorkoutActivityDays,
  getWorkoutPresence,
} from "@/lib/queries";
import { getSegmentLogDays } from "@/lib/queries/log-sheet";
import { gatherMilestoneInput } from "@/lib/milestones-db";
import { setProfileSetting, setStoredAge } from "@/lib/settings";

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Pinned so a profile-local day is the UTC day: every date below is written by
  // hand, and the presence case reconstructs a wall clock from one.
  setProfileSetting(id, "timezone", "UTC");
  return id;
}

// A live session's row exactly as create-at-start writes it: dated, typed, titled,
// started, and carrying nothing else at all. `touch` is what the dock reads as the
// last edit; every other reader here ignores it.
function addDraft(
  profileId: number,
  date: string,
  type: string,
  title: string,
  touch: Date = new Date()
): number {
  const stamp = utcSqlString(touch);
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, '09:00', ?, ?)`
      )
      .run(profileId, date, type, title, stamp, stamp).lastInsertRowid
  );
}

// THE POSITIVE CONTROL: a session that was actually logged — a duration and a set.
function addLogged(
  profileId: number,
  date: string,
  type: string,
  title: string
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, end_time)
         VALUES (?, ?, ?, ?, 30, '10:00')`
      )
      .run(profileId, date, type, title).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Squat', 1, 60, 5)`
  ).run(id);
  return id;
}

// ── #3189 — the days the coach believes this person trained ────────────────────
//
// The widest reach in the census: `getActivityDates` is the coaching engine's
// training history, the rule findings' workout days, and the day set both intake
// notification paths and the supplement/medication timing surfaces read. None of
// them is shown to the person, so a day they did not train shapes advice with
// nothing on screen to disbelieve.
describe("getActivityDates — a day a session was only OPENED is not a training day", () => {
  it("stays empty under a draft, and reports the day a real session lands on", () => {
    const id = makeProfile("DATES");
    const day = today(id);

    expect(getActivityDates(id)).toEqual([]);
    addDraft(id, day, "strength", "Opened and abandoned");
    expect(getActivityDates(id)).toEqual([]);
    addLogged(id, day, "strength", "Actually trained");
    expect(getActivityDates(id)).toEqual([day]);
  });

  it("reports each day once, newest first, with husk days absent", () => {
    const id = makeProfile("DATES ORDER");
    const day = today(id);
    addLogged(id, "2026-03-01", "cardio", "Older run");
    addLogged(id, "2026-03-03", "cardio", "Newer run");
    addLogged(id, "2026-03-03", "strength", "Same day, second session");
    addDraft(id, "2026-03-02", "strength", "Between the two, never logged");
    addDraft(id, day, "strength", "Today, never logged");

    // The DISTINCT and the DESC ordering the SQL used to supply are now the fold's,
    // so both are pinned: 03-02 and today are missing, and 03-03 appears once.
    expect(getActivityDates(id)).toEqual(["2026-03-03", "2026-03-01"]);
  });

  // Every "not a draft" clause of the rule gets its own day, so this reader is
  // exposed to the WHOLE rule rather than to "started and not ended". A fixture
  // whose rows all carry a duration settles them before the set-count clause is
  // ever reached, which is exactly the gap #3188 called out.
  it("keeps a started session that logged ANYTHING at all", () => {
    const id = makeProfile("DATES RULE");

    const started = (date: string, title: string) =>
      addDraft(id, date, "strength", title, new Date());

    const withSet = started("2026-04-01", "a set");
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Bench', 1, 40, 5)`
    ).run(withSet);

    const withNote = started("2026-04-02", "a note");
    db.prepare("UPDATE activities SET notes = ? WHERE id = ?").run(
      "felt easy",
      withNote
    );

    const withDistance = started("2026-04-03", "a distance");
    db.prepare("UPDATE activities SET distance_km = 5 WHERE id = ?").run(
      withDistance
    );

    const imported = started("2026-04-04", "a provider row");
    db.prepare("UPDATE activities SET source = 'strava' WHERE id = ?").run(
      imported
    );

    const ended = started("2026-04-05", "an end");
    db.prepare("UPDATE activities SET end_time = '10:30' WHERE id = ?").run(
      ended
    );

    const withComponent = started("2026-04-06", "a component");
    db.prepare("UPDATE activities SET components = ? WHERE id = ?").run(
      JSON.stringify([{ type: "cardio", name: "Row" }]),
      withComponent
    );

    // And one that logged nothing, to prove the fixture can still say no.
    started("2026-04-07", "nothing at all");

    expect(getActivityDates(id)).toEqual([
      "2026-04-06",
      "2026-04-05",
      "2026-04-04",
      "2026-04-03",
      "2026-04-02",
      "2026-04-01",
    ]);
  });
});

// ── #3191 — the Trends → Fitness day-history matrix ────────────────────────────
//
// A separate statement from the day-density gather #3188 fixed, and its own surface.
// A draft is titled and typed the moment the session opens, so it lands on a real
// activity's row in the matrix and reads there as a session of it.
describe("getWorkoutActivityDays — a husk is not a session of that activity", () => {
  it("makes no cell, and does not inflate a real activity's cell", () => {
    const id = makeProfile("MATRIX");
    const day = today(id);
    const cells = () => getWorkoutActivityDays(id, day, day);

    expect(cells()).toEqual([]);
    addDraft(id, day, "strength", "Push Day");
    expect(cells()).toEqual([]);
    addLogged(id, day, "strength", "Push Day");
    expect(cells()).toEqual([
      { date: day, key: "push day", label: "Push Day", count: 1, minutes: 30 },
    ]);
  });
});

// ── #3190 — credit ─────────────────────────────────────────────────────────────
//
// Owner ruling: a draft credits NEITHER a frequency target NOR an Nth-workout
// milestone. Both of these DO something — the target flips met/pace/atCeiling, which
// silences the nudge that would have asked the person to train, and a milestone
// notification cannot be recalled once sent.
describe("getFrequencyTargetProgress — a husk does not credit a weekly target", () => {
  it("credits nothing, and a real session credits one", () => {
    const id = makeProfile("TARGET");
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'type', 'strength', 3)`
    ).run(id);
    const day = today(id);
    const count = () =>
      getFrequencyTargetProgress(id).find(
        (t) => t.target.scope_value === "strength"
      )?.count;

    expect(count()).toBe(0);
    addDraft(id, day, "strength", "Opened and abandoned");
    expect(count()).toBe(0);
    addLogged(id, day, "strength", "Actually trained");
    expect(count()).toBe(1);
  });
});

describe("gatherMilestoneInput — a husk is not the Nth workout", () => {
  it("does not count toward the thresholds", () => {
    const id = makeProfile("MILESTONE");
    setStoredAge(id, 30); // the training-relevance gate, open
    const day = today(id);
    const total = () => gatherMilestoneInput(id).totalWorkouts;

    expect(total()).toBe(0);
    addDraft(id, day, "strength", "Opened and abandoned");
    expect(total()).toBe(0);
    addLogged(id, day, "strength", "Actually trained");
    expect(total()).toBe(1);
  });
});

// ── #3191 — protocol adherence ─────────────────────────────────────────────────
//
// An N-of-1's whole point is what the person actually did during the window. This
// entry was READ-VERIFIED but not probed when the census was filed; it was probed
// before this fix and behaved exactly as predicted (0 → 1 under the draft, → 2 under
// the control).
describe("getProtocolUsage — a husk is not a use of the intervention", () => {
  it("reports no sessions for a draft in the protocol's lane", () => {
    const id = makeProfile("PROTOCOL");
    const day = today(id);
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'type', 'cardio', 4)`
        )
        .run(id).lastInsertRowid
    );
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, end_date, frequency_target_id)
           VALUES (?, 'Zone 2 block', ?, NULL, ?)`
        )
        .run(id, day, targetId).lastInsertRowid
    );
    const sessions = () =>
      getProtocolUsage(id, getProtocol(id, protocolId)!, day).sessions;

    expect(sessions()).toBe(0);
    addDraft(id, day, "cardio", "Opened and abandoned");
    expect(sessions()).toBe(0);
    addLogged(id, day, "cardio", "Actually trained");
    expect(sessions()).toBe(1);
  });
});

// ── #3191 — the log sheet's habit days ─────────────────────────────────────────
//
// Low harm on its own (it opens the wrong tab), and the same defect. The Train arm
// counts manually logged days, and a draft is manual.
describe("getSegmentLogDays — a husk is not a day this person logged training", () => {
  it("makes no Train habit day, and a real session makes one", () => {
    const id = makeProfile("HABIT");
    const day = today(id);
    const train = () => getSegmentLogDays(id, day).train;

    expect(train()).toBeUndefined();
    addDraft(id, day, "strength", "Opened and abandoned");
    expect(train()).toBeUndefined();
    addLogged(id, day, "strength", "Actually trained");
    expect(train()).toBe(1);
  });

  it("leaves every other segment's days alone", () => {
    const id = makeProfile("HABIT OTHERS");
    const day = today(id);
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70)`
    ).run(id, day);
    addDraft(id, day, "strength", "Opened and abandoned");
    // The Train arm left the union statement to get its own fold; the other seven
    // arms still answer, which a split that dropped them would not show anywhere
    // else.
    expect(getSegmentLogDays(id, day)).toEqual({ body: 1 });
  });
});

// ── THE ONE READER THAT MUST STILL SEE IT ──────────────────────────────────────
describe("getWorkoutPresence keeps seeing the draft — immune BY INTENT", () => {
  it("reports a live session for the row every other reader here ignores", () => {
    const id = makeProfile("DOCK");
    const day = today(id);
    // The dock reconstructs the session's start from its wall clock on its own
    // date, so `now` is built from the same day rather than from the host clock.
    const now = new Date(`${day}T09:30:00.000Z`);
    const activityId = addDraft(
      id,
      day,
      "strength",
      "Live session",
      new Date(now.getTime() - 2 * 60_000)
    );

    // The activity-date reader does not count it...
    expect(getActivityDates(id)).toEqual([]);
    // ...and the dock still has a session running, which is the whole reason the
    // row is kept rather than discarded when someone walks away from it.
    expect(getWorkoutPresence(id, now)).toMatchObject({
      state: "active",
      activityId,
      sinceMin: 30,
    });
  });
});
