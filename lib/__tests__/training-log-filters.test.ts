// PURE TIER — the Training Log feed's ONE filter predicate (issue #1634).
//
// trainingLogCardMatches is what the server-filtered page and the client's instant
// refinement BOTH apply, so the two cannot disagree once a round-trip settles. The
// SQL day-scan in lib/queries/training/activities.ts is a deliberate SUPERSET of
// what is pinned here; the DB tier proves the superset holds end to end.

import { describe, it, expect } from "vitest";
import {
  EMPTY_TRAINING_LOG_FILTERS,
  filterTrainingLogGroups,
  trainingLogCardMatches,
  trainingLogFiltersActive,
  trainingLogFiltersKey,
  normalizeTrainingLogFilters,
  type TrainingLogFilters,
} from "@/lib/training-log-filters";
import type { DayGroup, TrainingLogCardData } from "@/lib/training-log-card";
import type { ActivityType } from "@/lib/types";

function card(opts: {
  id: number;
  title: string;
  type?: ActivityType;
  source?: string | null;
  fault?: string | null;
  parts?: {
    name: string;
    muscle?: string | null;
    kind?: "strength" | "cardio";
  }[];
}): TrainingLogCardData {
  return {
    activity: {
      id: opts.id,
      type: opts.type ?? "strength",
      title: opts.title,
      date: "2026-05-01",
      duration_min: null,
      distance_km: null,
      intensity: null,
      start_time: null,
      end_time: null,
      components: null,
      notes: null,
      source: opts.source === undefined ? null : opts.source,
      sets: [],
    },
    timeText: null,
    durationText: null,
    distanceText: null,
    speedText: null,
    heartRateText: null,
    calorieText: null,
    metrics: [],
    gear: null,
    parts: (opts.parts ?? []).map((p) =>
      (p.kind ?? "strength") === "strength"
        ? {
            kind: "strength" as const,
            name: p.name,
            muscle: p.muscle ?? null,
            text: "",
            status: null,
          }
        : { kind: "cardio" as const, name: p.name, detail: "" }
    ),
    fault: opts.fault ?? null,
    provenance: {
      label: "Manual",
      createdAt: "2026-05-01 08:00:00",
      updatedAt: null,
      editLocked: false,
    },
    foldValues: {},
    routePolyline: null,
    videos: [],
  } as unknown as TrainingLogCardData;
}

const withFilters = (
  over: Partial<TrainingLogFilters>
): TrainingLogFilters => ({
  ...EMPTY_TRAINING_LOG_FILTERS,
  ...over,
});

describe("trainingLogFiltersActive / trainingLogFiltersKey", () => {
  it("treats a whitespace-only query as no filter at all", () => {
    expect(trainingLogFiltersActive(withFilters({ query: "   " }))).toBe(false);
    expect(trainingLogFiltersActive(withFilters({ query: " squat " }))).toBe(
      true
    );
  });

  it("is active for each individual filter", () => {
    expect(trainingLogFiltersActive(withFilters({ type: "cardio" }))).toBe(
      true
    );
    expect(trainingLogFiltersActive(withFilters({ faultOnly: true }))).toBe(
      true
    );
    expect(trainingLogFiltersActive(withFilters({ source: "strava" }))).toBe(
      true
    );
    expect(
      trainingLogFiltersActive(
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(true);
  });

  it("keys equal filter sets identically and different ones apart", () => {
    // Trim/case-insensitivity is part of the key: retyping the same query with
    // different spacing must not fire a second round-trip or invalidate the
    // response already on screen.
    expect(trainingLogFiltersKey(withFilters({ query: " Squat " }))).toBe(
      trainingLogFiltersKey(withFilters({ query: "squat" }))
    );
    expect(trainingLogFiltersKey(withFilters({ source: "strava" }))).not.toBe(
      trainingLogFiltersKey(withFilters({ source: "oura" }))
    );
  });
});

describe("normalizeTrainingLogFilters — untrusted Server Action payload", () => {
  it("degrades an unknown activity type to no type filter", () => {
    expect(normalizeTrainingLogFilters({ type: "telepathy" }).type).toBeNull();
    expect(normalizeTrainingLogFilters({ type: "sport" }).type).toBe("sport");
  });

  it("drops a malformed tag rather than trusting it", () => {
    expect(
      normalizeTrainingLogFilters({ tag: { kind: "muscle" } }).tag
    ).toBeNull();
    expect(normalizeTrainingLogFilters({ tag: "Legs" }).tag).toBeNull();
    expect(
      normalizeTrainingLogFilters({ tag: { kind: "region", value: "Legs" } })
        .tag
    ).toEqual({ kind: "region", value: "Legs" });
  });

  it("caps the free-text query and rejects an over-long source", () => {
    const long = "x".repeat(500);
    expect(normalizeTrainingLogFilters({ query: long }).query).toHaveLength(
      200
    );
    expect(normalizeTrainingLogFilters({ source: long }).source).toBeNull();
  });

  it("returns the empty set for a non-object payload", () => {
    expect(normalizeTrainingLogFilters(null)).toEqual(
      EMPTY_TRAINING_LOG_FILTERS
    );
    expect(normalizeTrainingLogFilters("squat")).toEqual(
      EMPTY_TRAINING_LOG_FILTERS
    );
  });
});

describe("trainingLogCardMatches", () => {
  const bench = card({
    id: 1,
    title: "Push day",
    parts: [{ name: "Barbell Bench Press", muscle: "Chest" }],
  });
  const run = card({
    id: 2,
    title: "Morning run",
    type: "cardio",
    source: "strava",
    parts: [{ name: "Running", kind: "cardio" }],
  });

  it("matches free text against the title AND the part names", () => {
    expect(trainingLogCardMatches(bench, withFilters({ query: "push" }))).toBe(
      true
    );
    expect(trainingLogCardMatches(bench, withFilters({ query: "bench" }))).toBe(
      true
    );
    expect(trainingLogCardMatches(bench, withFilters({ query: "kayak" }))).toBe(
      false
    );
  });

  it("is case-insensitive and trims the query", () => {
    expect(
      trainingLogCardMatches(run, withFilters({ query: " RUNNING " }))
    ).toBe(true);
  });

  it("filters by activity type", () => {
    expect(trainingLogCardMatches(run, withFilters({ type: "cardio" }))).toBe(
      true
    );
    expect(trainingLogCardMatches(run, withFilters({ type: "strength" }))).toBe(
      false
    );
  });

  it("filters by provenance KEY, not by raw source", () => {
    expect(trainingLogCardMatches(run, withFilters({ source: "strava" }))).toBe(
      true
    );
    expect(trainingLogCardMatches(run, withFilters({ source: "manual" }))).toBe(
      false
    );
    // A NULL source is manual — the same collapse the card chip's label makes.
    expect(
      trainingLogCardMatches(bench, withFilters({ source: "manual" }))
    ).toBe(true);
    // Every document-extracted row shares ONE option, whatever its document id.
    const doc = card({
      id: 3,
      title: "Imported session",
      source: "document:7",
    });
    expect(
      trainingLogCardMatches(doc, withFilters({ source: "document" }))
    ).toBe(true);
  });

  it("filters by muscle badge and by derived region", () => {
    expect(
      trainingLogCardMatches(
        bench,
        withFilters({ tag: { kind: "muscle", value: "Chest" } })
      )
    ).toBe(true);
    expect(
      trainingLogCardMatches(
        bench,
        withFilters({ tag: { kind: "region", value: "Chest" } })
      )
    ).toBe(true);
    expect(
      trainingLogCardMatches(
        bench,
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(false);
    // A cardio part carries no muscle/region, so a tag filter never matches it.
    expect(
      trainingLogCardMatches(
        run,
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(false);
  });

  it("filters to rows the editor can't re-save as-is", () => {
    const faulty = card({ id: 4, title: "Legacy import", fault: "No sets." });
    expect(
      trainingLogCardMatches(faulty, withFilters({ faultOnly: true }))
    ).toBe(true);
    expect(
      trainingLogCardMatches(bench, withFilters({ faultOnly: true }))
    ).toBe(false);
  });

  it("ANDs every active filter", () => {
    expect(
      trainingLogCardMatches(
        run,
        withFilters({ query: "run", type: "cardio", source: "strava" })
      )
    ).toBe(true);
    expect(
      trainingLogCardMatches(
        run,
        withFilters({ query: "run", type: "cardio", source: "manual" })
      )
    ).toBe(false);
  });
});

describe("filterTrainingLogGroups", () => {
  const groups: DayGroup[] = [
    {
      date: "2026-05-02",
      label: "May 2",
      cards: [
        card({ id: 1, title: "Push day" }),
        card({ id: 2, title: "Evening walk", type: "cardio" }),
      ],
    },
    {
      date: "2026-05-01",
      label: "May 1",
      cards: [card({ id: 3, title: "Rest-day mobility", type: "recovery" })],
    },
  ];

  it("returns the same groups untouched when no filter is active", () => {
    expect(filterTrainingLogGroups(groups, EMPTY_TRAINING_LOG_FILTERS)).toBe(
      groups
    );
  });

  it("narrows a day to its matching cards and drops days left empty", () => {
    const out = filterTrainingLogGroups(
      groups,
      withFilters({ type: "cardio" })
    );
    expect(out.map((g) => g.date)).toEqual(["2026-05-02"]);
    expect(out[0].cards.map((c) => c.activity.id)).toEqual([2]);
  });

  it("keeps the day label and does not mutate the source groups", () => {
    const out = filterTrainingLogGroups(groups, withFilters({ query: "push" }));
    expect(out[0].label).toBe("May 2");
    expect(groups[0].cards).toHaveLength(2);
  });
});
