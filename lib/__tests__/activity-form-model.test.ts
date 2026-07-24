import { describe, it, expect } from "vitest";
import {
  blankPart,
  buildRepeatPrefill,
  initialPartsFromSeed,
  partIntent,
  partTotal,
  groupEditSets,
  recentSessionsForForm,
  repeatSessionFill,
  setComplete,
  type ActivityEditData,
  type PartEntry,
  type RepeatSourceSet,
} from "@/components/activity-form/model";
import type { UnitPrefs } from "@/lib/settings";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "C",
};
// The picker-vocabulary predicate the form passes in; the catalog names count as
// known, everything else is a free-text custom.
const KNOWN = new Set(["bench press", "running", "cycling"]);
const isKnown = (n: string) => KNOWN.has(n.trim().toLowerCase());

// A stored set with sensible defaults; override only the fields a case cares
// about. Shape mirrors ActivityEditData["sets"][number].
const storedSet = (
  o: Partial<ActivityEditData["sets"][number]> & { set_number: number }
): ActivityEditData["sets"][number] => ({
  exercise: "Bench Press",
  weight_kg: null,
  reps: null,
  weight_kg_right: null,
  reps_right: null,
  duration_sec: null,
  duration_sec_right: null,
  equipment_id: null,
  target_reps: null,
  to_failure: null,
  warmup: null,
  rpe: null,
  ...o,
});

const part = (o: Partial<PartEntry>): PartEntry => ({ ...blankPart(), ...o });

describe("buildRepeatPrefill", () => {
  const source: ActivityEditData = {
    id: 42,
    type: "strength",
    title: "Morning Push",
    date: "2026-06-01",
    duration_min: 45,
    distance_km: null,
    intensity: "hard",
    start_time: "07:30",
    end_time: "08:15",
    components: '[{"name":"Bench Press","type":"strength"}]',
    notes: "felt strong",
    source: "strava",
    edited: 1,
    created_at: "2026-06-01 07:30:00",
    updated_at: "2026-06-02 09:00:00",
    calorie_kcal: 648,
    calorie_estimated: false,
    route_polyline: "encoded-route",
    sets: [
      storedSet({
        set_number: 1,
        exercise: "Bench Press",
        weight_kg: 80,
        reps: 5,
      }),
    ],
  };

  it("keeps the title, components, and sets", () => {
    const p = buildRepeatPrefill(source, "2026-07-09");
    expect(p.title).toBe("Morning Push");
    expect(p.components).toBe(source.components);
    expect(p.sets).toEqual(source.sets);
  });

  it("resets the date to today and clears session context + provenance", () => {
    const p = buildRepeatPrefill(source, "2026-07-09");
    expect(p.date).toBe("2026-07-09");
    expect(p.start_time).toBeNull();
    expect(p.end_time).toBeNull();
    expect(p.notes).toBeNull();
    expect(p.source).toBeNull();
    expect(p.edited).toBeNull();
    expect(p.created_at).toBeUndefined();
    expect(p.updated_at).toBeNull();
    expect(p.calorie_kcal).toBeUndefined();
    expect(p.calorie_estimated).toBeUndefined();
    expect(p.route_polyline).toBeUndefined();
  });

  it("deep-copies sets so mutating the prefill can't touch the source", () => {
    const p = buildRepeatPrefill(source, "2026-07-09");
    p.sets[0].weight_kg = 999;
    expect(source.sets[0].weight_kg).toBe(80);
  });

  it("drops the subject stamp so a repeat writes to the ACTING profile (#1330)", () => {
    // Repeating another member's card must log it as YOURS — never a cross-profile
    // write. The prefill carries no subjectProfileId, so the save falls back to the
    // acting-profile requireWriteAccess gate.
    const withSubject: ActivityEditData = { ...source, subjectProfileId: 77 };
    const p = buildRepeatPrefill(withSubject, "2026-07-09");
    expect(p.subjectProfileId).toBeUndefined();
  });
});

describe("partIntent", () => {
  it("applies to a rep-based bilateral part and reads its target", () => {
    expect(partIntent(part({ name: "Bench Press", targetReps: "5" }))).toEqual({
      applies: true,
      target: 5,
      toFailure: false,
    });
  });

  it("drops the numeric target when the part is to-failure (AMRAP)", () => {
    expect(
      partIntent(
        part({ name: "Bench Press", targetReps: "5", toFailure: true })
      )
    ).toEqual({ applies: true, target: null, toFailure: true });
  });

  it("has no target when none is entered", () => {
    expect(partIntent(part({ name: "Bench Press" })).target).toBeNull();
  });

  it("does not apply to a per-side part (intent is inert and nulled)", () => {
    expect(
      partIntent(part({ name: "Bench Press", perSide: true, targetReps: "5" }))
    ).toEqual({ applies: false, target: null, toFailure: false });
  });

  it("does not apply to a timed hold", () => {
    // Plank is a timed lift; a target rep count is meaningless there.
    expect(partIntent(part({ name: "Plank", targetReps: "5" })).applies).toBe(
      false
    );
  });
});

describe("partTotal", () => {
  it("sums weight × reps across sets", () => {
    const p = part({
      sets: [
        { ...blankPart().sets[0], weight: "100", reps: "5" },
        { ...blankPart().sets[0], weight: "100", reps: "3" },
      ],
    });
    expect(partTotal(p)).toBe(800);
  });

  it("adds the right side only when tracking per-side", () => {
    const sets = [
      {
        ...blankPart().sets[0],
        weight: "20",
        reps: "10",
        weightRight: "25",
        repsRight: "10",
      },
    ];
    expect(partTotal(part({ perSide: false, sets }))).toBe(200);
    expect(partTotal(part({ perSide: true, sets }))).toBe(200 + 250);
  });

  it("excludes warmup sets from the volume total (#338)", () => {
    const p = part({
      sets: [
        { ...blankPart().sets[0], weight: "60", reps: "5", warmup: true },
        { ...blankPart().sets[0], weight: "100", reps: "5" },
      ],
    });
    expect(partTotal(p)).toBe(500); // only the 100×5 working set
  });
});

describe("setComplete", () => {
  it("needs both weight and reps for a normal lift", () => {
    const s = { ...blankPart().sets[0], weight: "100" };
    expect(setComplete("Bench Press", s, false)).toBe(false);
    expect(setComplete("Bench Press", { ...s, reps: "5" }, false)).toBe(true);
  });

  it("counts a completed right side on a per-side part", () => {
    const s = {
      ...blankPart().sets[0],
      weightRight: "20",
      repsRight: "8",
    };
    expect(setComplete("Bench Press", s, false)).toBe(false);
    expect(setComplete("Bench Press", s, true)).toBe(true);
  });
});

describe("groupEditSets", () => {
  it("groups stored sets by exercise, ordered by set_number", () => {
    const grouped = groupEditSets(
      [
        storedSet({
          exercise: "Squat",
          set_number: 2,
          weight_kg: 105,
          reps: 5,
        }),
        storedSet({
          exercise: "Squat",
          set_number: 1,
          weight_kg: 100,
          reps: 5,
        }),
        storedSet({
          exercise: "Bench Press",
          set_number: 3,
          weight_kg: 60,
          reps: 8,
        }),
      ],
      "kg"
    );
    expect(grouped.map((g) => g.name)).toEqual(["Squat", "Bench Press"]);
    expect(grouped[0].sets.map((s) => s.weight)).toEqual(["100", "105"]);
    expect(grouped[0].sets.map((s) => s.reps)).toEqual(["5", "5"]);
  });

  it("marks a part per-side when any set carries right-side data", () => {
    const grouped = groupEditSets(
      [
        storedSet({
          set_number: 1,
          weight_kg: 20,
          reps: 10,
          weight_kg_right: 22,
          reps_right: 10,
        }),
      ],
      "kg"
    );
    expect(grouped[0].perSide).toBe(true);
    expect(grouped[0].sets[0].weightRight).toBe("22");
  });

  it("keeps to-failure only when EVERY set is AMRAP", () => {
    const mixed = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, to_failure: 1 }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 5, to_failure: null }),
      ],
      "kg"
    );
    expect(mixed[0].toFailure).toBe(false);

    const allAmrap = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, to_failure: 1 }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 3, to_failure: 1 }),
      ],
      "kg"
    );
    expect(allAmrap[0].toFailure).toBe(true);
  });

  it("adopts the first declared target rep count it finds", () => {
    const grouped = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, target_reps: null }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 5, target_reps: 8 }),
      ],
      "kg"
    );
    expect(grouped[0].targetReps).toBe("8");
  });
});

describe("recentSessionsForForm", () => {
  // Newest-first, as the history query ships them.
  const sessions = [
    { activityId: 40, date: "2026-03-10" },
    { activityId: 30, date: "2026-03-03" },
    { activityId: 20, date: "2026-02-24" },
    { activityId: 10, date: "2026-02-17" },
  ];

  it("returns [] when there is no history", () => {
    expect(recentSessionsForForm(undefined, null, null)).toEqual([]);
    expect(recentSessionsForForm([], 10, null)).toEqual([]);
  });

  it("create mode with no saved row yet shows the newest sessions", () => {
    // currentActivityId null (nothing auto-saved), no edited date.
    const r = recentSessionsForForm(sessions, null, null);
    expect(r.map((s) => s.activityId)).toEqual([40, 30, 20]);
  });

  it("create mode excludes the auto-saved row so it never lists itself", () => {
    // Once auto-save creates the row (id 40, newest), it drops out and the
    // spare session keeps three priors visible.
    const r = recentSessionsForForm(sessions, 40, null);
    expect(r.map((s) => s.activityId)).toEqual([30, 20, 10]);
  });

  it("edit mode excludes the edited session by id (self-exclusion)", () => {
    // Editing session 30: it must not appear in its own "Recent".
    const r = recentSessionsForForm(sessions, 30, "2026-03-03");
    expect(r.map((s) => s.activityId)).not.toContain(30);
  });

  it("edit mode drops sessions logged AFTER the edited one", () => {
    // Editing back-dated session 20 (2026-02-24): the later 40/30 sessions are
    // not "previous" and must be hidden; only the older 10 remains.
    const r = recentSessionsForForm(sessions, 20, "2026-02-24");
    expect(r.map((s) => s.activityId)).toEqual([10]);
  });

  it("edit mode keeps same-day siblings (not 'after')", () => {
    const sameDay = [
      { activityId: 41, date: "2026-03-10" },
      { activityId: 40, date: "2026-03-10" },
      { activityId: 30, date: "2026-03-03" },
    ];
    // Editing 40: its same-day sibling 41 stays (same date is not after),
    // 40 itself is excluded by id.
    const r = recentSessionsForForm(sameDay, 40, "2026-03-10");
    expect(r.map((s) => s.activityId)).toEqual([41, 30]);
  });

  it("honours the limit and preserves newest-first order", () => {
    const r = recentSessionsForForm(sessions, null, null, 2);
    expect(r.map((s) => s.activityId)).toEqual([40, 30]);
  });
});

// #923 — the "repeat last session" fill: a prior session's stored sets → editable set
// rows. A literal repeat (weights/reps/holds), warmup flags (#338) and per-side values
// (#335) preserved; RPE/intent NOT carried; perSide follows the source session.
describe("repeatSessionFill", () => {
  const src = (
    o: Partial<RepeatSourceSet> & { set_number: number }
  ): RepeatSourceSet => ({
    weight_kg: null,
    reps: null,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    warmup: null,
    ...o,
  });

  it("maps a bilateral session to weight/reps rows in the login's unit", () => {
    const { sets, perSide } = repeatSessionFill(
      [
        src({ set_number: 1, weight_kg: 60, reps: 8 }),
        src({ set_number: 2, weight_kg: 62.5, reps: 6 }),
      ],
      "kg"
    );
    expect(perSide).toBe(false);
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ weight: "60", reps: "8", warmup: false });
    expect(sets[1]).toMatchObject({ weight: "62.5", reps: "6" });
  });

  it("converts stored kg to the login's display unit (lb)", () => {
    const { sets } = repeatSessionFill(
      [src({ set_number: 1, weight_kg: 100, reps: 5 })],
      "lb"
    );
    // 100 kg ≈ 220.5 lb (round to 1 dp).
    expect(sets[0].weight).toBe("220.5");
    expect(sets[0].reps).toBe("5");
  });

  it("preserves warmup flags and orders by set_number", () => {
    const { sets } = repeatSessionFill(
      [
        src({ set_number: 2, weight_kg: 60, reps: 8, warmup: 0 }),
        src({ set_number: 1, weight_kg: 20, reps: 10, warmup: 1 }),
      ],
      "kg"
    );
    expect(sets.map((s) => s.warmup)).toEqual([true, false]);
    expect(sets.map((s) => s.weight)).toEqual(["20", "60"]);
  });

  it("carries per-side values and sets perSide when a right side is present", () => {
    const { sets, perSide } = repeatSessionFill(
      [
        src({
          set_number: 1,
          weight_kg: 20,
          reps: 12,
          weight_kg_right: 22.5,
          reps_right: 10,
        }),
      ],
      "kg"
    );
    expect(perSide).toBe(true);
    expect(sets[0]).toMatchObject({
      weight: "20",
      reps: "12",
      weightRight: "22.5",
      repsRight: "10",
    });
  });

  it("maps a timed hold to an m:ss duration", () => {
    const { sets } = repeatSessionFill(
      [src({ set_number: 1, duration_sec: 90 })],
      "kg"
    );
    expect(sets[0].duration).toBe("1:30");
    expect(sets[0].weight).toBe("");
    expect(sets[0].reps).toBe("");
  });

  it("never carries an RPE onto the repeated set (#743)", () => {
    const { sets } = repeatSessionFill(
      [src({ set_number: 1, weight_kg: 60, reps: 8 })],
      "kg"
    );
    expect(sets[0].rpe).toBeNull();
  });
});

describe("initialPartsFromSeed", () => {
  const base: ActivityEditData = {
    id: 1,
    type: "strength",
    title: "Push",
    date: "2026-06-01",
    duration_min: null,
    distance_km: null,
    intensity: null,
    start_time: null,
    end_time: null,
    components: null,
    notes: null,
    source: null,
    edited: null,
    created_at: "2026-06-01 07:00:00",
    updated_at: "2026-06-01 07:00:00",
    calorie_kcal: null,
    calorie_estimated: undefined,
    route_polyline: null,
    sets: [],
  };

  it("returns a single blank part with no seed (fresh create)", () => {
    const parts = initialPartsFromSeed(null, UNITS, isKnown);
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("");
    expect(parts[0].sets).toHaveLength(1);
  });

  it("loads structured components: a strength part joined back to its sets", () => {
    const parts = initialPartsFromSeed(
      {
        ...base,
        components: '[{"name":"Bench Press","type":"strength"}]',
        sets: [
          storedSet({
            set_number: 1,
            exercise: "Bench Press",
            weight_kg: 80,
            reps: 5,
          }),
        ],
      },
      UNITS,
      isKnown
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Bench Press");
    expect(parts[0].sets[0]).toMatchObject({ weight: "80", reps: "5" });
  });

  it("loads a non-curated cardio component as a custom, typed part", () => {
    const parts = initialPartsFromSeed(
      {
        ...base,
        type: "cardio",
        components:
          '[{"name":"Zorbing Sprints","type":"cardio","distance_km":4,"duration_min":50}]',
      },
      UNITS,
      isKnown
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      name: "Zorbing Sprints",
      custom: true,
      customType: "cardio",
      distance: "4",
      durationMin: "50",
    });
  });

  it("groups a legacy strength row (no components) by exercise", () => {
    const parts = initialPartsFromSeed(
      {
        ...base,
        components: null,
        sets: [
          storedSet({
            set_number: 1,
            exercise: "Bench Press",
            weight_kg: 80,
            reps: 5,
          }),
          storedSet({
            set_number: 2,
            exercise: "Bench Press",
            weight_kg: 80,
            reps: 4,
          }),
        ],
      },
      UNITS,
      isKnown
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Bench Press");
    expect(parts[0].sets).toHaveLength(2);
  });

  it("derives a legacy cardio row's part from its title via isKnown", () => {
    const parts = initialPartsFromSeed(
      { ...base, type: "cardio", title: "Morning Running", distance_km: 5 },
      UNITS,
      isKnown
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Running");
    expect(parts[0].distance).toBe("5");
  });
});
