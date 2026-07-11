import { describe, expect, it } from "vitest";

import { pickSeedSessions } from "../exercise-window";

// #393: since #331 a base's equipment variants merge under one canonical
// exerciseHistoryKey, so a lift's merged history (newest-first) can interleave
// implements. Seeding a next-set suggestion blindly off the newest session then
// mixes implements — a per-hand Dumbbell Curl load and a Barbell Curl total are
// materially different progressions. pickSeedSessions is the ONE decision both
// the editor chip and getStrengthByExercise's lastSessionBest/lastSessionSets
// consume: prefer the newest session logged under the EXACT target name, else the
// newest session overall (mirroring the editor's lastEquipmentId).

// Newest-first, as both surfaces build their session lists.
const sessions = [
  { date: "2026-07-10", exercise: "Dumbbell Curl", tag: "dbNew" },
  { date: "2026-07-01", exercise: "Barbell Curl", tag: "bbOld" },
  { date: "2026-06-20", exercise: "Barbell Curl", tag: "bbOlder" },
];

describe("pickSeedSessions — exact-variant-first seed (#393)", () => {
  it("prefers the newest session logged under the exact target name", () => {
    // Entering "Barbell Curl" seeds off the newest Barbell Curl session, NOT the
    // newer Dumbbell Curl session that shares the merged history.
    const seed = pickSeedSessions(sessions, "Barbell Curl");
    expect(seed.map((s) => s.tag)).toEqual(["bbOld"]);
  });

  it("is case- and whitespace-insensitive on the target name", () => {
    expect(
      pickSeedSessions(sessions, "  barbell CURL ").map((s) => s.tag)
    ).toEqual(["bbOld"]);
  });

  it("falls back to the newest session overall when the exact name was never logged", () => {
    // A bare base "Curl" was never logged as such — fall back to the newest
    // session of any implement, exactly as before the exact-match preference.
    expect(pickSeedSessions(sessions, "Curl").map((s) => s.tag)).toEqual([
      "dbNew",
    ]);
  });

  it("combines two same-day activities of the exact variant into one session", () => {
    const sameDay = [
      { date: "2026-07-10", exercise: "Barbell Curl", tag: "a" },
      { date: "2026-07-10", exercise: "Barbell Curl", tag: "b" },
      { date: "2026-07-10", exercise: "Dumbbell Curl", tag: "c" },
      { date: "2026-07-01", exercise: "Barbell Curl", tag: "old" },
    ];
    // The exact-match branch keeps only the matching implement on the chosen date,
    // so a same-day sibling variant ("Dumbbell Curl") is dropped from the seed.
    expect(pickSeedSessions(sameDay, "Barbell Curl").map((s) => s.tag)).toEqual(
      ["a", "b"]
    );
  });

  it("keeps every same-day activity in the newest-overall fallback", () => {
    const sameDay = [
      { date: "2026-07-10", exercise: "Dumbbell Curl", tag: "a" },
      { date: "2026-07-10", exercise: "Cable Curl", tag: "b" },
      { date: "2026-07-01", exercise: "Barbell Curl", tag: "old" },
    ];
    // No exact "Curl" session → fall back to the newest date, any implement.
    expect(pickSeedSessions(sameDay, "Curl").map((s) => s.tag)).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns [] for an empty history", () => {
    expect(pickSeedSessions([], "Barbell Curl")).toEqual([]);
  });

  it("gives the same pick on both surfaces' shapes (parity)", () => {
    // The editor passes RecentSession-shaped objects (date/exercise/sets/baseKg);
    // getStrengthByExercise passes raw set rows (date/exercise/weight_kg/…). Given
    // the same dates+names+target, ONE function yields the same selection on both,
    // so the seed can't diverge across surfaces.
    const editorShaped = sessions.map((s) => ({
      date: s.date,
      exercise: s.exercise,
      baseKg: 0,
      sets: [{ weight_kg: 40, reps: 8 }],
    }));
    const rowShaped = sessions.map((s) => ({
      date: s.date,
      exercise: s.exercise,
      weight_kg: 40,
      reps: 8,
    }));
    const target = "Barbell Curl";
    expect(pickSeedSessions(editorShaped, target).map((s) => s.date)).toEqual(
      pickSeedSessions(rowShaped, target).map((s) => s.date)
    );
    expect(pickSeedSessions(editorShaped, target).map((s) => s.date)).toEqual([
      "2026-07-01",
    ]);
  });
});
