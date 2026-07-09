import { describe, expect, it } from "vitest";
import {
  storedActivityFault,
  type StoredActivity,
  type StoredSet,
} from "@/lib/activity-validate";

const act = (over: Partial<StoredActivity> = {}): StoredActivity => ({
  type: "strength",
  title: "Workout",
  start_time: null,
  end_time: null,
  components: null,
  distance_km: null,
  duration_min: null,
  ...over,
});

const set = (over: Partial<StoredSet> & { exercise: string }): StoredSet => ({
  weight_kg: null,
  reps: null,
  weight_kg_right: null,
  reps_right: null,
  duration_sec: null,
  duration_sec_right: null,
  equipment_id: null,
  ...over,
});

const comps = (...list: { name: string; type: string }[]) =>
  JSON.stringify(
    list.map((c) => ({ ...c, distance_km: null, duration_min: null }))
  );

describe("storedActivityFault", () => {
  it("passes a normal strength activity", () => {
    expect(
      storedActivityFault(act(), [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
      ])
    ).toBeNull();
  });

  it("passes bodyweight (reps only) and timed (hold only) sets", () => {
    expect(
      storedActivityFault(act(), [set({ exercise: "Pull Up", reps: 8 })])
    ).toBeNull();
    // Bodyweight lifts beyond the pull-up family — hamstrings and core work
    // the body loads — also save on reps alone, no weight required.
    expect(
      storedActivityFault(act(), [set({ exercise: "Nordic Curl", reps: 6 })])
    ).toBeNull();
    expect(
      storedActivityFault(act(), [set({ exercise: "Crunch", reps: 20 })])
    ).toBeNull();
    expect(
      storedActivityFault(act(), [set({ exercise: "Plank", duration_sec: 60 })])
    ).toBeNull();
  });

  it("passes a per-side set complete on one side only", () => {
    expect(
      storedActivityFault(act(), [
        set({
          exercise: "Back Squat",
          weight_kg_right: 100,
          reps_right: 5,
        }),
      ])
    ).toBeNull();
  });

  it("matches components to sets case-insensitively, like the editor", () => {
    expect(
      storedActivityFault(
        act({ components: comps({ name: "back squat", type: "strength" }) }),
        [set({ exercise: "Back Squat", weight_kg: 100, reps: 5 })]
      )
    ).toBeNull();
  });

  it("flags a half-filled set (weight without reps)", () => {
    expect(
      storedActivityFault(act(), [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
        set({ exercise: "Back Squat", weight_kg: 100 }),
      ])
    ).toMatch(/half-filled/);
  });

  it("flags a bare variant base with no equipment", () => {
    expect(
      storedActivityFault(act(), [
        set({ exercise: "Curl", weight_kg: 20, reps: 10 }),
      ])
    ).toMatch(/equipment/);
  });

  it("accepts a bare variant base once any set carries an implement", () => {
    expect(
      storedActivityFault(act(), [
        set({ exercise: "Curl", weight_kg: 20, reps: 10, equipment_id: 3 }),
      ])
    ).toBeNull();
  });

  it("flags an end time before the start time", () => {
    expect(
      storedActivityFault(act({ start_time: "10:00", end_time: "09:00" }), [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
      ])
    ).toMatch(/end time/i);
  });

  it("flags a strength component with no completed set", () => {
    expect(
      storedActivityFault(
        act({
          components: comps(
            { name: "Back Squat", type: "strength" },
            { name: "Leg Press", type: "strength" }
          ),
        }),
        [set({ exercise: "Back Squat", weight_kg: 100, reps: 5 })]
      )
    ).toMatch(/Leg Press.*no completed set/);
  });

  it("flags a cardio component with no content, unless a time range stands in", () => {
    const c = act({
      type: "cardio",
      components: comps({ name: "Running", type: "cardio" }),
    });
    expect(storedActivityFault(c, [])).toMatch(/Running/);
    expect(
      storedActivityFault({ ...c, start_time: "07:00", end_time: "07:30" }, [])
    ).toBeNull();
  });

  it("flags a stored-but-empty components list — the editor shows no parts", () => {
    expect(
      storedActivityFault(act({ components: "[]" }), [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
      ])
    ).toMatch(/No activities listed/);
  });

  it("flags orphan sets the components don't list — an edit would drop them", () => {
    const a = act({
      components: comps({ name: "Back Squat", type: "strength" }),
    });
    expect(
      storedActivityFault(a, [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
        set({ exercise: "Curl", weight_kg: 20, reps: 10 }),
      ])
    ).toMatch(/Curl.*drop/);
    // ...and their equipment/half-filled state is NOT judged (the editor
    // never loads them, so it can't block on them).
    expect(
      storedActivityFault(a, [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
        set({ exercise: "Curl", weight_kg: 20 }), // orphan AND half-filled
      ])
    ).toMatch(/drop/);
  });

  it("legacy strength: every exercise needs a completed set, not just one", () => {
    expect(
      storedActivityFault(act(), [
        set({ exercise: "Back Squat", weight_kg: 100, reps: 5 }),
        // A rep exercise carrying only a duration: neither complete nor
        // partial, but the editor still builds a contentless part from it.
        set({ exercise: "Face Pull", duration_sec: 60 }),
      ])
    ).toMatch(/Face Pull.*no completed set/);
  });

  it("flags legacy rows (no components) without any content", () => {
    expect(storedActivityFault(act(), [])).toMatch(/No completed set/);
    expect(storedActivityFault(act({ type: "cardio" }), [])).toMatch(
      /No distance/
    );
    expect(
      storedActivityFault(act({ type: "cardio", duration_min: 30 }), [])
    ).toBeNull();
  });

  it("legacy cardio: an unrecognized title-derived name is not a fault", () => {
    // The editor loads it as a committed custom activity (typed by the row),
    // so free-text names are editable and re-savable — never flagged.
    const jog = act({
      type: "cardio",
      title: "Morning Zwift - Watopia Session",
      duration_min: 45,
    });
    expect(storedActivityFault(jog, [])).toBeNull();
  });

  it("legacy cardio with exercise sets: an edit would drop them", () => {
    expect(
      storedActivityFault(
        act({
          type: "cardio",
          title: "Morning Running Session",
          duration_min: 30,
        }),
        [set({ exercise: "Back Squat", weight_kg: 100, reps: 5 })]
      )
    ).toMatch(/drop/);
  });
});
