// SERVER-ACTION TIER — the headless "Finish workout" action (#1124/#1205) and the
// #1202 active-vs-elapsed write path, driven through the real saveActivity /
// finishWorkout actions against the in-memory schema.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { saveActivity, finishWorkout } from "@/app/(app)/journal/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

function row(id: number): {
  duration_min: number | null;
  elapsed_min: number | null;
  end_time: string | null;
} {
  return db
    .prepare(
      "SELECT duration_min, elapsed_min, end_time FROM activities WHERE id = ?"
    )
    .get(id) as {
    duration_min: number | null;
    elapsed_min: number | null;
    end_time: string | null;
  };
}

const runningComponent = (durationMin: number | null) =>
  JSON.stringify([
    { name: "Running", type: "cardio", distance: 8, duration_min: durationMin },
  ]);

describe("saveActivity active vs elapsed (#1202)", () => {
  it("a paused run stores active = moving (45), elapsed = the clock span (60)", async () => {
    const login = createLogin();
    const profile = createProfile("paused-run", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Paused run",
        date: "2026-07-01",
        components: runningComponent(45), // moving time typed
        sets: "[]",
        start_time: "07:00",
        end_time: "08:00", // 60-min wall-clock span
      })
    );
    if (!res.ok) throw new Error(`save failed: ${res.reason}`);
    const r = row(res.id);
    expect(r.duration_min).toBe(45); // active = moving
    expect(r.elapsed_min).toBe(60); // elapsed = clock span
  });

  it("editing the paused run (title only) does NOT flip active up to elapsed", async () => {
    const login = createLogin();
    const profile = createProfile("paused-edit", login.id);
    actAs(login, profile);

    const created = await saveActivity(
      fd({
        type: "cardio",
        title: "Paused run",
        date: "2026-07-02",
        components: runningComponent(45),
        sets: "[]",
        start_time: "07:00",
        end_time: "08:00",
      })
    );
    if (!created.ok) throw new Error("create failed");
    expect(row(created.id).duration_min).toBe(45);

    // Re-save the same row with only the title changed — the moving time (45)
    // must survive (the #1202 regression: it used to flip to the 60-min elapsed).
    const edited = await saveActivity(
      fd({
        id: created.id,
        type: "cardio",
        title: "Paused run (renamed)",
        date: "2026-07-02",
        components: runningComponent(45),
        sets: "[]",
        start_time: "07:00",
        end_time: "08:00",
      })
    );
    if (!edited.ok) throw new Error("edit failed");
    const r = row(created.id);
    expect(r.duration_min).toBe(45); // NOT 60
    expect(r.elapsed_min).toBe(60);
  });
});

// A live strength draft created through saveActivity (start set, no end).
async function seedLiveDraft(date: string, title = "Live"): Promise<number> {
  const res = await saveActivity(
    fd({
      type: "strength",
      title,
      date,
      components: JSON.stringify([
        {
          name: "Bench Press",
          type: "strength",
          distance: null,
          duration_min: null,
        },
      ]),
      sets: JSON.stringify([
        {
          exercise: "Bench Press",
          weight: 60,
          reps: 5,
          weightRight: null,
          repsRight: null,
          durationSec: null,
          durationSecRight: null,
          equipmentId: null,
        },
      ]),
      start_time: "07:00",
    })
  );
  if (!res.ok) throw new Error(`draft save failed: ${res.reason}`);
  return res.id;
}

describe("finishWorkout action (#1124/#1205)", () => {
  it("stamps end = now on a live draft and returns finished", async () => {
    const login = createLogin();
    const profile = createProfile("finish-ok", login.id);
    actAs(login, profile);
    const id = await seedLiveDraft(today(profile.id));
    expect(row(id).end_time).toBeNull();

    const outcome = await finishWorkout(id);
    expect(outcome.kind).toBe("finished");
    expect(row(id).end_time).not.toBeNull();
  });

  it("a second finish is idempotent (already-finished, no re-stamp)", async () => {
    const login = createLogin();
    const profile = createProfile("finish-twice", login.id);
    actAs(login, profile);
    const id = await seedLiveDraft(today(profile.id));

    await finishWorkout(id);
    const firstEnd = row(id).end_time;
    const again = await finishWorkout(id);
    expect(again.kind).toBe("already-finished");
    expect(row(id).end_time).toBe(firstEnd);
  });

  it("refuses a foreign / non-existent id (not-found)", async () => {
    const login = createLogin();
    const profile = createProfile("finish-foreign", login.id);
    actAs(login, profile);
    const outcome = await finishWorkout(999999);
    expect(outcome.kind).toBe("not-found");
  });
});
