import { describe, expect, it } from "vitest";

import { isSeedFresh, RECENT_WINDOW_DAYS } from "../exercise-window";
import { shiftDateStr } from "../date";
import {
  classifyBodyweightByExercise,
  exerciseHistoryKey,
  exerciseHistoryNames,
  type BodyweightClassifyRow,
} from "../lifts";

// Defect 2 of #331: strength history is keyed purely by the exact logged name, so
// renaming "Barbell Curl" → "Curl" (or logging a lift under two variant spellings)
// splits one exercise into two independent histories — PRs, session counts, and
// the progression seed reset to whichever name was logged last. The fix routes
// every strength history builder's aggregation key through exerciseHistoryKey,
// which collapses a composed equipment variant onto its base so a variant and its
// base aggregate as one.

describe("exerciseHistoryKey (#331 defect 2)", () => {
  it("collapses a composed variant and its bare base to one key", () => {
    expect(exerciseHistoryKey("Barbell Curl")).toBe("curl");
    expect(exerciseHistoryKey("Curl")).toBe("curl");
    // The rename case the issue names: both spellings share one history key.
    expect(exerciseHistoryKey("Barbell Curl")).toBe(exerciseHistoryKey("Curl"));
  });

  it("folds every equipment variant of a base together", () => {
    const keys = ["Barbell Curl", "Dumbbell Curl", "Cable Curl", "Curl"].map(
      exerciseHistoryKey
    );
    expect(new Set(keys)).toEqual(new Set(["curl"]));
  });

  it("is case- and whitespace-insensitive", () => {
    expect(exerciseHistoryKey("  dumbbell CURL ")).toBe("curl");
    expect(exerciseHistoryKey("BENCH PRESS")).toBe("bench press");
  });

  it("keeps a truly custom (non-catalog) lift under its own key", () => {
    expect(exerciseHistoryKey("Sled Drag")).toBe("sled drag");
    expect(exerciseHistoryKey("Zercher Carry")).toBe("zercher carry");
    // Two distinct customs stay distinct.
    expect(exerciseHistoryKey("Sled Drag")).not.toBe(
      exerciseHistoryKey("Zercher Carry")
    );
  });
});

describe("exerciseHistoryNames — the canonical key's finite preimage (#394)", () => {
  // getExerciseComparison pushes its variant filter into SQL as `IN (...)`; the
  // placeholder set is exactly the names that collapse to the canonical key. Every
  // returned name must in turn map back to the same key, so the SQL scan and the
  // old JS `exerciseHistoryKey(r.exercise) === key` filter select identical rows.
  it("expands a variant group to its base plus every composed variant", () => {
    const names = exerciseHistoryNames("Barbell Curl");
    expect(new Set(names)).toEqual(
      new Set([
        "curl",
        "barbell curl",
        "dumbbell curl",
        "cable curl",
        "machine curl",
      ])
    );
  });

  it("returns the same preimage whether asked by base or by any variant", () => {
    const byBase = new Set(exerciseHistoryNames("Curl"));
    for (const v of ["Barbell Curl", "Dumbbell Curl", "Cable Curl"]) {
      expect(new Set(exerciseHistoryNames(v))).toEqual(byBase);
    }
  });

  it("every name in the preimage maps back to the one canonical key", () => {
    for (const v of ["Curl", "Barbell Curl", "Row", "Bench Press"]) {
      const key = exerciseHistoryKey(v);
      for (const n of exerciseHistoryNames(v)) {
        expect(exerciseHistoryKey(n)).toBe(key);
      }
    }
  });

  it("keeps a plain catalog lift and a custom lift to just their own name", () => {
    // Deadlift is a plain (non-variant-group) catalog lift — no equipment variants.
    expect(exerciseHistoryNames("Deadlift")).toEqual(["deadlift"]);
    // A non-catalog custom lift is its own single lowercased/trimmed name.
    expect(exerciseHistoryNames("  Sled Drag ")).toEqual(["sled drag"]);
  });
});

describe("bodyweight KIND merges variants like the aggregation (#331)", () => {
  // The shared classifier keys by exerciseHistoryKey too, so a variant and its
  // base classify as ONE lift and the OR of external-weight sightings spans them
  // — the detail panel and editor chip can't split a renamed lift's KIND.
  it("ORs external-weight across a variant and its base", () => {
    const rows: BodyweightClassifyRow[] = [
      { exercise: "Curl", hasExternalWeight: false }, // logged bodyweight-only
      { exercise: "Barbell Curl", hasExternalWeight: true }, // ever loaded
    ];
    const map = classifyBodyweightByExercise(rows);
    expect(map.size).toBe(1);
    expect(map.get("curl")).toBe(false); // one loaded variant → weighted overall
  });
});

describe("isSeedFresh — the >1yr-old-seed decision (#331)", () => {
  const today = "2026-07-11";

  it("is fresh for a session inside the recent window", () => {
    expect(isSeedFresh(shiftDateStr(today, -10), today)).toBe(true);
    expect(isSeedFresh(today, today)).toBe(true);
  });

  it("is fresh exactly at the window boundary (inclusive), stale one day past", () => {
    // Same inclusive boundary as recentWindowStart (date >= today − windowDays),
    // so the seed a builder withholds is exactly the session the editor drops.
    expect(isSeedFresh(shiftDateStr(today, -RECENT_WINDOW_DAYS), today)).toBe(
      true
    );
    expect(
      isSeedFresh(shiftDateStr(today, -(RECENT_WINDOW_DAYS + 1)), today)
    ).toBe(false);
  });

  it("is stale for a session more than a year old", () => {
    expect(isSeedFresh(shiftDateStr(today, -420), today)).toBe(false);
  });

  it("returns false for an unparseable date rather than throwing", () => {
    expect(isSeedFresh("not-a-date", today)).toBe(false);
  });
});
