// SERVER-ACTION TIER — the Sleep and Mood Log's per-row delete (issue #2556).
//
// The log could list a manual sleep duration and a mood check-in it had no way to
// remove. The write core (`deleteMetricRow`) already existed; what this covers is the
// action boundary added around it — the gate, the NARROWING of the posted target, and
// the undo token the toast needs.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { deleteSleepMoodRow } from "@/app/(app)/sleep/actions";
import { getMoodOnDate } from "@/lib/queries";
import { readingTargetToken } from "@/lib/reading-placement";
import { upsertMoodLog } from "@/lib/offline/writes";
import { actAs, createLogin, createProfile, fd } from "./harness";

function seedManualSleep(profileId: number, date: string, minutes: number) {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
      )
      .run(profileId, date, `${date}T00:00:00`, `${date}T00:00:00`, minutes)
      .lastInsertRowid
  );
}

function sleepTarget(id: number) {
  return readingTargetToken({
    store: "metric_samples",
    id,
    metric: "sleep_min",
  });
}

describe("deleteSleepMoodRow", () => {
  it("removes the manual sleep sample the log listed", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-delete", login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const id = seedManualSleep(profile.id, date, 450);

    const result = await deleteSleepMoodRow(fd({ target: sleepTarget(id) }));

    expect(result.undoId).toBeTypeOf("number");
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE id = ?")
        .get(id)
    ).toEqual({ n: 0 });
  });

  it("removes a mood check-in and answers with an undo token", async () => {
    const login = createLogin();
    const profile = createProfile("mood-delete", login.id);
    actAs(login, profile);
    const date = today(profile.id);
    upsertMoodLog(profile.id, date, { valence: "4", note: "fine" });
    const mood = getMoodOnDate(profile.id, date)!;

    const result = await deleteSleepMoodRow(
      fd({
        target: readingTargetToken({
          store: "mood",
          id: mood.id,
          series: "valence",
        }),
      })
    );

    expect(result.undoId).toBeTypeOf("number");
    expect(getMoodOnDate(profile.id, date)).toBeNull();
  });

  // THE NARROWING. `target` is posted by the client, so "some row of this profile" is
  // not a small enough surface: the Sleep log may only delete the two kinds of row it
  // actually lists. A steps sample is a rejected no-op, not a delete.
  it("refuses a target naming another metric in the same store", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-delete-narrow", login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const id = Number(
      db
        .prepare(
          `INSERT INTO metric_samples
             (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'manual', 'steps', ?, ?, ?, 9000)`
        )
        .run(profile.id, date, `${date}T00:00:00`, `${date}T00:00:00`)
        .lastInsertRowid
    );

    const result = await deleteSleepMoodRow(
      fd({
        target: readingTargetToken({
          store: "metric_samples",
          id,
          metric: "steps",
        }),
      })
    );

    expect(result).toEqual({ undoId: null });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE id = ?")
        .get(id)
    ).toEqual({ n: 1 });
  });

  it("refuses a malformed target without touching anything", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-delete-garbage", login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const id = seedManualSleep(profile.id, date, 400);

    expect(await deleteSleepMoodRow(fd({ target: "nonsense" }))).toEqual({
      undoId: null,
    });
    expect(await deleteSleepMoodRow(fd({}))).toEqual({ undoId: null });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE id = ?")
        .get(id)
    ).toEqual({ n: 1 });
  });

  // Profile scoping is the core's own `WHERE profile_id = ?`; a crafted id belonging
  // to somebody else can only ever miss.
  it("cannot reach another profile's row", async () => {
    const login = createLogin();
    const mine = createProfile("sleep-delete-mine", login.id);
    const theirs = createProfile("sleep-delete-theirs", login.id);
    const date = today(theirs.id);
    const id = seedManualSleep(theirs.id, date, 420);
    actAs(login, mine);

    expect(await deleteSleepMoodRow(fd({ target: sleepTarget(id) }))).toEqual({
      undoId: null,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE id = ?")
        .get(id)
    ).toEqual({ n: 1 });
  });
});
