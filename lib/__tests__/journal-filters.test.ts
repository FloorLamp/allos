// PURE TIER — the Journal feed's ONE filter predicate (issue #1634).
//
// journalCardMatches is what the server-filtered page and the client's instant
// refinement BOTH apply, so the two cannot disagree once a round-trip settles. The
// SQL day-scan in lib/queries/training/activities.ts is a deliberate SUPERSET of
// what is pinned here; the DB tier proves the superset holds end to end.

import { describe, it, expect } from "vitest";
import {
  EMPTY_JOURNAL_FILTERS,
  filterJournalGroups,
  journalCardMatches,
  journalFiltersActive,
  journalFiltersKey,
  normalizeJournalFilters,
  type JournalFilters,
} from "@/lib/journal-filters";
import type { DayGroup, JournalCardData } from "@/lib/journal-card";
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
}): JournalCardData {
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
  } as unknown as JournalCardData;
}

const withFilters = (over: Partial<JournalFilters>): JournalFilters => ({
  ...EMPTY_JOURNAL_FILTERS,
  ...over,
});

describe("journalFiltersActive / journalFiltersKey", () => {
  it("treats a whitespace-only query as no filter at all", () => {
    expect(journalFiltersActive(withFilters({ query: "   " }))).toBe(false);
    expect(journalFiltersActive(withFilters({ query: " squat " }))).toBe(true);
  });

  it("is active for each individual filter", () => {
    expect(journalFiltersActive(withFilters({ type: "cardio" }))).toBe(true);
    expect(journalFiltersActive(withFilters({ faultOnly: true }))).toBe(true);
    expect(journalFiltersActive(withFilters({ source: "strava" }))).toBe(true);
    expect(
      journalFiltersActive(
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(true);
  });

  it("keys equal filter sets identically and different ones apart", () => {
    // Trim/case-insensitivity is part of the key: retyping the same query with
    // different spacing must not fire a second round-trip or invalidate the
    // response already on screen.
    expect(journalFiltersKey(withFilters({ query: " Squat " }))).toBe(
      journalFiltersKey(withFilters({ query: "squat" }))
    );
    expect(journalFiltersKey(withFilters({ source: "strava" }))).not.toBe(
      journalFiltersKey(withFilters({ source: "oura" }))
    );
  });
});

describe("normalizeJournalFilters — untrusted Server Action payload", () => {
  it("degrades an unknown activity type to no type filter", () => {
    expect(normalizeJournalFilters({ type: "telepathy" }).type).toBeNull();
    expect(normalizeJournalFilters({ type: "sport" }).type).toBe("sport");
  });

  it("drops a malformed tag rather than trusting it", () => {
    expect(normalizeJournalFilters({ tag: { kind: "muscle" } }).tag).toBeNull();
    expect(normalizeJournalFilters({ tag: "Legs" }).tag).toBeNull();
    expect(
      normalizeJournalFilters({ tag: { kind: "region", value: "Legs" } }).tag
    ).toEqual({ kind: "region", value: "Legs" });
  });

  it("caps the free-text query and rejects an over-long source", () => {
    const long = "x".repeat(500);
    expect(normalizeJournalFilters({ query: long }).query).toHaveLength(200);
    expect(normalizeJournalFilters({ source: long }).source).toBeNull();
  });

  it("returns the empty set for a non-object payload", () => {
    expect(normalizeJournalFilters(null)).toEqual(EMPTY_JOURNAL_FILTERS);
    expect(normalizeJournalFilters("squat")).toEqual(EMPTY_JOURNAL_FILTERS);
  });
});

describe("journalCardMatches", () => {
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
    expect(journalCardMatches(bench, withFilters({ query: "push" }))).toBe(
      true
    );
    expect(journalCardMatches(bench, withFilters({ query: "bench" }))).toBe(
      true
    );
    expect(journalCardMatches(bench, withFilters({ query: "kayak" }))).toBe(
      false
    );
  });

  it("is case-insensitive and trims the query", () => {
    expect(journalCardMatches(run, withFilters({ query: " RUNNING " }))).toBe(
      true
    );
  });

  it("filters by activity type", () => {
    expect(journalCardMatches(run, withFilters({ type: "cardio" }))).toBe(true);
    expect(journalCardMatches(run, withFilters({ type: "strength" }))).toBe(
      false
    );
  });

  it("filters by provenance KEY, not by raw source", () => {
    expect(journalCardMatches(run, withFilters({ source: "strava" }))).toBe(
      true
    );
    expect(journalCardMatches(run, withFilters({ source: "manual" }))).toBe(
      false
    );
    // A NULL source is manual — the same collapse the card chip's label makes.
    expect(journalCardMatches(bench, withFilters({ source: "manual" }))).toBe(
      true
    );
    // Every document-extracted row shares ONE option, whatever its document id.
    const doc = card({
      id: 3,
      title: "Imported session",
      source: "document:7",
    });
    expect(journalCardMatches(doc, withFilters({ source: "document" }))).toBe(
      true
    );
  });

  it("filters by muscle badge and by derived region", () => {
    expect(
      journalCardMatches(
        bench,
        withFilters({ tag: { kind: "muscle", value: "Chest" } })
      )
    ).toBe(true);
    expect(
      journalCardMatches(
        bench,
        withFilters({ tag: { kind: "region", value: "Chest" } })
      )
    ).toBe(true);
    expect(
      journalCardMatches(
        bench,
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(false);
    // A cardio part carries no muscle/region, so a tag filter never matches it.
    expect(
      journalCardMatches(
        run,
        withFilters({ tag: { kind: "region", value: "Legs" } })
      )
    ).toBe(false);
  });

  it("filters to rows the editor can't re-save as-is", () => {
    const faulty = card({ id: 4, title: "Legacy import", fault: "No sets." });
    expect(journalCardMatches(faulty, withFilters({ faultOnly: true }))).toBe(
      true
    );
    expect(journalCardMatches(bench, withFilters({ faultOnly: true }))).toBe(
      false
    );
  });

  it("ANDs every active filter", () => {
    expect(
      journalCardMatches(
        run,
        withFilters({ query: "run", type: "cardio", source: "strava" })
      )
    ).toBe(true);
    expect(
      journalCardMatches(
        run,
        withFilters({ query: "run", type: "cardio", source: "manual" })
      )
    ).toBe(false);
  });
});

describe("filterJournalGroups", () => {
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
    expect(filterJournalGroups(groups, EMPTY_JOURNAL_FILTERS)).toBe(groups);
  });

  it("narrows a day to its matching cards and drops days left empty", () => {
    const out = filterJournalGroups(groups, withFilters({ type: "cardio" }));
    expect(out.map((g) => g.date)).toEqual(["2026-05-02"]);
    expect(out[0].cards.map((c) => c.activity.id)).toEqual([2]);
  });

  it("keeps the day label and does not mutate the source groups", () => {
    const out = filterJournalGroups(groups, withFilters({ query: "push" }));
    expect(out[0].label).toBe("May 2");
    expect(groups[0].cards).toHaveLength(2);
  });
});
