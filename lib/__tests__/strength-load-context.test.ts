import { describe, expect, it } from "vitest";

import {
  equipmentLoadLane,
  exerciseHistoryKey,
  movementLoadKey,
  strengthLoadKey,
} from "../lifts";
import { loadContextSessions, pickSeedSessions } from "../exercise-window";

// #1610: `exercise_sets.equipment_id` is the per-set implement link, but the
// strength read/identity layer dropped it, so two registry machines that both
// serialize as the exact same logged name ("Machine Chest Press") shared one seed,
// one PR track and one plateau series. Load comparability is a SECOND identity
// beside `exerciseHistoryKey`'s movement identity; these tests pin its semantics and
// the no-cross-context rule the seed must obey.

describe("equipmentLoadLane", () => {
  it("gives a null equipment id its own explicit lane, never a wildcard", () => {
    expect(equipmentLoadLane(null)).toBe("none");
    expect(equipmentLoadLane(undefined)).toBe("none");
    // The unassigned lane must not collide with any real registry id.
    expect(equipmentLoadLane(7)).not.toBe(equipmentLoadLane(null));
  });

  it("separates two registry ids", () => {
    expect(equipmentLoadLane(7)).not.toBe(equipmentLoadLane(8));
  });
});

describe("strengthLoadKey — exact variant + implement (the seed identity)", () => {
  it("separates two machines logged under one exact exercise name", () => {
    // The reproduction: a home chest press and a hotel chest press whose stack
    // geometry makes 50 kg the right load, both logged as "Machine Chest Press".
    expect(strengthLoadKey("Machine Chest Press", 7)).not.toBe(
      strengthLoadKey("Machine Chest Press", 8)
    );
  });

  it("keeps #393's built-in variant separation with no custom equipment", () => {
    expect(strengthLoadKey("Dumbbell Curl", null)).not.toBe(
      strengthLoadKey("Barbell Curl", null)
    );
  });

  it("is case- and whitespace-insensitive on the name", () => {
    expect(strengthLoadKey("  barbell CURL ", 3)).toBe(
      strengthLoadKey("Barbell Curl", 3)
    );
  });

  it("does NOT collapse variants onto their base — that is the movement key's job", () => {
    expect(strengthLoadKey("Barbell Curl", null)).not.toBe(
      strengthLoadKey("Curl", null)
    );
  });
});

describe("movementLoadKey — movement + implement (the series identity)", () => {
  it("collapses variant spellings onto one key, preserving the #432 merge", () => {
    // "Barbell Curl" and "Curl" are ONE plateau series and ONE dismissal (#1399).
    expect(movementLoadKey("Barbell Curl", null)).toBe(
      movementLoadKey("Curl", null)
    );
    expect(movementLoadKey("Dumbbell Curl", null)).toBe(
      movementLoadKey("Curl", null)
    );
  });

  it("still separates two implements of the SAME movement", () => {
    expect(movementLoadKey("Machine Chest Press", 7)).not.toBe(
      movementLoadKey("Machine Chest Press", 8)
    );
    expect(movementLoadKey("Curl", 7)).not.toBe(movementLoadKey("Curl", null));
  });

  it("carries the canonical movement key as its name axis", () => {
    expect(movementLoadKey("Barbell Curl", 7)).toBe(
      `${exerciseHistoryKey("Barbell Curl")}@7`
    );
  });
});

// ---- The no-cross-context seed rule -----------------------------------------

// Newest-first, as every surface builds its session list.
const twoMachines = [
  { date: "2026-07-10", exercise: "Machine Chest Press", equipmentId: 7, tag: "home" },
  { date: "2026-07-03", exercise: "Machine Chest Press", equipmentId: 7, tag: "homeOld" },
];

describe("loadContextSessions / pickSeedSessions — never cross a load context", () => {
  it("returns nothing for a machine with no history — no ghost from another machine", () => {
    // The traveller selects the freshly registered hotel machine (id 8). The home
    // machine's 80 kg must NOT seed it, and no "Use" suggestion may appear.
    expect(loadContextSessions(twoMachines, "Machine Chest Press", 8)).toEqual(
      []
    );
    expect(pickSeedSessions(twoMachines, "Machine Chest Press", 8)).toEqual([]);
  });

  it("seeds from the selected machine once it has history", () => {
    const both = [
      { date: "2026-07-12", exercise: "Machine Chest Press", equipmentId: 8, tag: "hotel" },
      ...twoMachines,
    ];
    expect(
      pickSeedSessions(both, "Machine Chest Press", 8).map((s) => s.tag)
    ).toEqual(["hotel"]);
    // …and switching back to the home machine switches the seed back, skipping the
    // newer hotel session entirely.
    expect(
      pickSeedSessions(both, "Machine Chest Press", 7).map((s) => s.tag)
    ).toEqual(["home"]);
  });

  it("does not let the unassigned lane inherit a machine's numbers", () => {
    // Historical rows with equipment_id IS NULL stay in their own lane; we never
    // guess which machine produced non-comparable history.
    expect(pickSeedSessions(twoMachines, "Machine Chest Press", null)).toEqual(
      []
    );
  });

  it("does not let a machine inherit the unassigned lane's numbers", () => {
    const untagged = [
      { date: "2026-07-10", exercise: "Machine Chest Press", equipmentId: null, tag: "legacy" },
    ];
    expect(pickSeedSessions(untagged, "Machine Chest Press", 8)).toEqual([]);
  });

  it("keeps two same-day activities on the same machine as ONE session", () => {
    const sameDay = [
      { date: "2026-07-10", exercise: "Machine Chest Press", equipmentId: 7, tag: "a" },
      { date: "2026-07-10", exercise: "Machine Chest Press", equipmentId: 7, tag: "b" },
      { date: "2026-07-10", exercise: "Machine Chest Press", equipmentId: 8, tag: "other" },
      { date: "2026-07-01", exercise: "Machine Chest Press", equipmentId: 7, tag: "old" },
    ];
    expect(
      pickSeedSessions(sameDay, "Machine Chest Press", 7).map((s) => s.tag)
    ).toEqual(["a", "b"]);
  });
});

describe("pickSeedSessions — the equipment-free path is byte-for-byte pre-#1610", () => {
  // Exactly the #393 fixture: no profile equipment at all, so every session sits in
  // the unassigned lane and the old exact-name-then-newest rule must still hold.
  const sessions = [
    { date: "2026-07-10", exercise: "Dumbbell Curl", tag: "dbNew" },
    { date: "2026-07-01", exercise: "Barbell Curl", tag: "bbOld" },
    { date: "2026-06-20", exercise: "Barbell Curl", tag: "bbOlder" },
  ];

  it("still prefers the exact variant over a newer sibling", () => {
    expect(pickSeedSessions(sessions, "Barbell Curl").map((s) => s.tag)).toEqual(
      ["bbOld"]
    );
  });

  it("still falls back to the newest session for an ambiguous bare base", () => {
    expect(pickSeedSessions(sessions, "Curl").map((s) => s.tag)).toEqual([
      "dbNew",
    ]);
  });

  it("treats an omitted equipmentId as the unassigned lane", () => {
    // Raw set rows that never selected the column must behave as all-unassigned.
    expect(
      pickSeedSessions(sessions, "Barbell Curl", null).map((s) => s.tag)
    ).toEqual(["bbOld"]);
  });

  it("suppresses the ambiguous-base fallback once ANY implement is on file", () => {
    // With a real machine in the history, "which implement produced this?" is no
    // longer answerable — so a bare base seeds nothing rather than a machine's load.
    const mixed = [
      { date: "2026-07-10", exercise: "Dumbbell Curl", equipmentId: 9, tag: "db" },
      { date: "2026-07-01", exercise: "Barbell Curl", equipmentId: null, tag: "bb" },
    ];
    expect(pickSeedSessions(mixed, "Curl", null)).toEqual([]);
    // …while an exact context still resolves normally.
    expect(pickSeedSessions(mixed, "Barbell Curl", null).map((s) => s.tag)).toEqual(
      ["bb"]
    );
  });
});
