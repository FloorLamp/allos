// PURE tier — pins the Journal feed's card construction (issue #334) that used to
// live inline in app/(app)/training/HistorySection.tsx. Covers set-grouping, the
// components-vs-legacy branch, the single-pure-effort header fold, the cardio
// distance/duration/speed detail string, the imported-metric chips, and day
// grouping/labels. No DB — buildJournalCards takes already-loaded rows.

import { describe, it, expect } from "vitest";
import {
  buildJournalCards,
  activityMetrics,
  appendDayGroups,
  reconcileJournalPaging,
} from "@/lib/journal-card";
import type { Activity, ExerciseSet } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { DatedWeight } from "@/lib/calorie-estimate";

const KG: UnitPrefs = { weightUnit: "kg", distanceUnit: "km" };

function activity(over: Partial<Activity> & { id: number }): Activity {
  return {
    date: "2026-06-10",
    type: "strength",
    title: "Session",
    notes: null,
    duration_min: null,
    distance_km: null,
    intensity: null,
    start_time: null,
    end_time: null,
    components: null,
    created_at: "2026-06-10 08:00:00",
    updated_at: null,
    source: null,
    external_id: null,
    edited: null,
    avg_hr: null,
    max_hr: null,
    elevation_m: null,
    avg_speed_kmh: null,
    max_speed_kmh: null,
    relative_effort: null,
    avg_power_w: null,
    max_power_w: null,
    weighted_avg_power_w: null,
    avg_cadence: null,
    avg_temp_c: null,
    kilojoules: null,
    workout_type: null,
    est_calories: null,
    equipment_id: null,
    ...over,
  };
}

function set(
  over: Partial<ExerciseSet> & { id: number; activity_id: number }
): ExerciseSet {
  return {
    exercise: "Bench Press",
    set_number: 1,
    weight_kg: 100,
    reps: 5,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    target_reps: null,
    to_failure: null,
    equipment_id: null,
    warmup: 0,
    ...over,
  };
}

const build = (
  activities: Activity[],
  sets: ExerciseSet[],
  opts: Partial<{
    equipmentNames: Map<number, string>;
    weights: DatedWeight[];
    units: UnitPrefs;
    today: string;
    yesterday: string;
  }> = {}
) =>
  buildJournalCards({
    activities,
    sets,
    equipmentNames: opts.equipmentNames ?? new Map(),
    weights: opts.weights ?? [],
    units: opts.units ?? KG,
    today: opts.today ?? "2026-06-11",
    yesterday: opts.yesterday ?? "2026-06-10",
  });

describe("buildJournalCards — day grouping", () => {
  it("groups activities by date (newest-first order preserved) and labels Today/Yesterday", () => {
    const acts = [
      activity({ id: 3, date: "2026-06-11", title: "A" }),
      activity({ id: 2, date: "2026-06-10", title: "B" }),
      activity({ id: 1, date: "2026-06-01", title: "C" }),
    ];
    const groups = build(acts, [], {
      today: "2026-06-11",
      yesterday: "2026-06-10",
    });
    expect(groups.map((g) => g.date)).toEqual([
      "2026-06-11",
      "2026-06-10",
      "2026-06-01",
    ]);
    expect(groups[0].label).toBe("Today");
    expect(groups[1].label).toBe("Yesterday");
    // An older day falls back to the long-date formatter (not Today/Yesterday).
    expect(groups[2].label).not.toBe("Today");
    expect(groups[2].label).not.toBe("Yesterday");
  });

  it("keeps multiple activities in one day group in input order", () => {
    const acts = [
      activity({ id: 2, date: "2026-06-10", title: "Second" }),
      activity({ id: 1, date: "2026-06-10", title: "First" }),
    ];
    const [group] = build(acts, []);
    expect(group.cards.map((c) => c.activity.title)).toEqual([
      "Second",
      "First",
    ]);
  });
});

describe("buildJournalCards — strength parts", () => {
  it("groups sets by lowercased exercise and summarizes each as a strength part", () => {
    const a = activity({ id: 1, type: "strength", title: "Push day" });
    const sets = [
      set({ id: 1, activity_id: 1, exercise: "Bench Press", set_number: 1 }),
      // Casing drift still groups with the first (imports lowercase-match).
      set({ id: 2, activity_id: 1, exercise: "bench press", set_number: 2 }),
      set({
        id: 3,
        activity_id: 1,
        exercise: "Overhead Press",
        set_number: 1,
        weight_kg: 40,
        reps: 8,
      }),
    ];
    const [group] = build([a], sets);
    const parts = group.cards[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ kind: "strength", name: "Bench Press" });
    // Two grouped sets → "100kg × 5 × 2".
    expect(parts[0]).toHaveProperty("text", "100kg × 5 × 2");
    expect(parts[1]).toMatchObject({
      kind: "strength",
      name: "Overhead Press",
    });
  });

  it("labels a set's equipment from the equipment-name map", () => {
    const a = activity({ id: 1, type: "strength" });
    const sets = [set({ id: 1, activity_id: 1, equipment_id: 7 })];
    const [group] = build([a], sets, {
      equipmentNames: new Map([[7, "Trap Bar"]]),
    });
    const part = group.cards[0].parts[0];
    expect(part).toMatchObject({ kind: "strength", equipment: "Trap Bar" });
  });
});

describe("buildJournalCards — components vs legacy", () => {
  it("renders parts from the stored components list, in list order", () => {
    const a = activity({
      id: 1,
      type: "strength",
      components: JSON.stringify([
        {
          name: "Squat",
          type: "strength",
          distance_km: null,
          duration_min: null,
        },
        { name: "Row", type: "cardio", distance_km: 2, duration_min: 10 },
      ]),
    });
    const sets = [set({ id: 1, activity_id: 1, exercise: "Squat" })];
    const [group] = build([a], sets);
    const parts = group.cards[0].parts;
    expect(parts.map((p) => p.kind)).toEqual(["strength", "cardio"]);
    expect(parts[0]).toMatchObject({ name: "Squat" });
    // cardio detail = "distance · duration · speed"
    expect(parts[1]).toMatchObject({
      kind: "cardio",
      name: "Row",
      detail: "2 km · 10 min · 12 km/h",
    });
  });

  it("falls back to legacy per-exercise parts when components is null", () => {
    const a = activity({ id: 1, type: "strength", components: null });
    const sets = [
      set({ id: 1, activity_id: 1, exercise: "Deadlift" }),
      set({ id: 2, activity_id: 1, exercise: "Curl", weight_kg: 20, reps: 12 }),
    ];
    const [group] = build([a], sets);
    expect(group.cards[0].parts.map((p) => p.name)).toEqual([
      "Deadlift",
      "Curl",
    ]);
  });
});

describe("buildJournalCards — single-pure-effort header fold", () => {
  it("surfaces a lone cardio effort as a clickable row and drops the header meta", () => {
    const a = activity({
      id: 1,
      type: "cardio",
      title: "Morning run",
      duration_min: 30,
      distance_km: 5,
      components: JSON.stringify([
        { name: "Run", type: "cardio", distance_km: 5, duration_min: 30 },
      ]),
    });
    const [group] = build([a], []);
    const card = group.cards[0];
    // The single cardio part is shown as a row…
    expect(card.parts).toHaveLength(1);
    expect(card.parts[0]).toMatchObject({ kind: "cardio", name: "Run" });
    // …and the now-redundant header meta is suppressed.
    expect(card.durationText).toBeNull();
    expect(card.distanceText).toBeNull();
    expect(card.speedText).toBeNull();
  });

  it("keeps the header meta for a strength activity and hides a lone folded part", () => {
    const a = activity({
      id: 1,
      type: "strength",
      duration_min: 45,
      distance_km: null,
      components: JSON.stringify([
        {
          name: "Bench Press",
          type: "strength",
          distance_km: null,
          duration_min: null,
        },
      ]),
    });
    const sets = [set({ id: 1, activity_id: 1, exercise: "Bench Press" })];
    const [group] = build([a], sets);
    const card = group.cards[0];
    expect(card.durationText).toBe("45 min");
    // A single strength part is still surfaced as a row.
    expect(card.parts.map((p) => p.name)).toEqual(["Bench Press"]);
  });
});

describe("buildJournalCards — metric chips + provenance", () => {
  it("emits imported-metric chips and a source/edited provenance label", () => {
    const a = activity({
      id: 1,
      type: "cardio",
      source: "strava",
      external_id: "strava:1",
      edited: 1,
      avg_hr: 150,
      max_hr: 172,
    });
    const [group] = build([a], []);
    const card = group.cards[0];
    expect(card.metrics).toContain("♥ 150/172 bpm");
    expect(card.provenance.label).toBe("Strava · edited");
  });

  it("carries createdAt/updatedAt onto the provenance block", () => {
    const a = activity({
      id: 1,
      created_at: "2026-06-10 08:00:00",
      updated_at: "2026-06-10 09:00:00",
    });
    const [group] = build([a], []);
    expect(group.cards[0].provenance).toMatchObject({
      createdAt: "2026-06-10 08:00:00",
      updatedAt: "2026-06-10 09:00:00",
    });
  });
});

describe("activityMetrics", () => {
  it("formats only the non-null columns, in order", () => {
    const a = activity({
      id: 1,
      workout_type: "long run",
      avg_hr: 150,
      elevation_m: 120,
      avg_power_w: 200,
      weighted_avg_power_w: 210,
      avg_cadence: 85,
      kilojoules: 500,
      avg_temp_c: 18,
      relative_effort: 42,
    });
    expect(activityMetrics(a, "km")).toEqual([
      "Long run",
      "♥ 150 bpm",
      "↑ 120 m",
      "200 W (210 NP)",
      "85 rpm",
      "500 kJ",
      "18°C",
      "Effort 42",
    ]);
  });

  it("renders elevation in feet for the mile preference", () => {
    const a = activity({ id: 1, elevation_m: 100 });
    expect(activityMetrics(a, "mi")).toEqual(["↑ 328 ft"]);
  });
});

describe("appendDayGroups — server-paged feed accumulation (#451)", () => {
  // First page: two newest days. Second page: an older, disjoint day.
  const page1 = build(
    [
      activity({ id: 3, date: "2026-06-11", title: "A" }),
      activity({ id: 2, date: "2026-06-10", title: "B" }),
    ],
    []
  );
  const page2 = build(
    [activity({ id: 1, date: "2026-06-01", title: "C" })],
    []
  );

  it("concatenates disjoint older pages, preserving newest-first date order", () => {
    const merged = appendDayGroups(page1, page2);
    expect(merged.map((g) => g.date)).toEqual([
      "2026-06-11",
      "2026-06-10",
      "2026-06-01",
    ]);
    // Cards are carried through unchanged.
    expect(merged[2].cards.map((c) => c.activity.id)).toEqual([1]);
  });

  it("is a no-op for an empty incoming page and returns the existing groups", () => {
    expect(appendDayGroups(page1, [])).toBe(page1);
  });

  it("reconciles the load-more cursor when the server window shifts (#503)", () => {
    // Newest window: days …Day13 down to Day14; cursor seeded to the oldest loaded
    // day (Day14). No shift while the server cursor is unchanged.
    expect(reconcileJournalPaging("2026-06-14", "2026-06-14")).toEqual({
      changed: false,
      cursor: "2026-06-14",
    });
    // Logging a new day rolls Day14 out of the first page; the server's fresh cursor
    // is now Day13. The stale cursor must reset to it so "Load more" fetches
    // `date < Day13` and re-includes Day14 (which `date < Day14` never would).
    expect(reconcileJournalPaging("2026-06-14", "2026-06-13")).toEqual({
      changed: true,
      cursor: "2026-06-13",
    });
    // A first page that now covers the whole history (cursor → null) also resets.
    expect(reconcileJournalPaging("2026-06-14", null)).toEqual({
      changed: true,
      cursor: null,
    });
    // Null → same null is a no-op (already exhausted, nothing to page).
    expect(reconcileJournalPaging(null, null)).toEqual({
      changed: false,
      cursor: null,
    });
  });

  it("merges a boundary day and dedups by activity id (no duplicate cards)", () => {
    // A re-fetch whose window overlaps the boundary day 06-10, carrying the SAME
    // activity 2 plus a NEW same-day activity 20 — must merge into one 06-10 group
    // with each id once, not split the day or double-list card 2.
    const overlap = build(
      [
        activity({ id: 20, date: "2026-06-10", title: "B2" }),
        activity({ id: 2, date: "2026-06-10", title: "B" }),
        activity({ id: 1, date: "2026-06-01", title: "C" }),
      ],
      []
    );
    const merged = appendDayGroups(page1, overlap);
    expect(merged.map((g) => g.date)).toEqual([
      "2026-06-11",
      "2026-06-10",
      "2026-06-01",
    ]);
    const boundary = merged.find((g) => g.date === "2026-06-10")!;
    expect(boundary.cards.map((c) => c.activity.id).sort()).toEqual([2, 20]);
    // The existing input is not mutated.
    expect(page1.find((g) => g.date === "2026-06-10")!.cards).toHaveLength(1);
  });
});
