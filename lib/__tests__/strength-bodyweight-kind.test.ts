import { describe, expect, it } from "vitest";

import {
  classifyBodyweightByExercise,
  isBodyweight,
  resolveBodyweightKind,
  type BodyweightClassifyRow,
} from "../lifts";

// The suggestion KIND (bodyweight vs weighted) is `isBodyweight(name) ||
// !sawExternalWeight`. Both strength builders — getStrengthByExercise (detail
// panel / coaching / Telegram) and getRecentExerciseHistory (the editor chip) —
// now resolve it through this ONE helper over the SAME all-history window, so a
// lift last loaded externally >12 months ago can't produce two different kinds on
// two surfaces (#331).

describe("resolveBodyweightKind", () => {
  it("is always bodyweight for a catalog bodyweight lift, even when loaded", () => {
    // Weighted dips are still a bodyweight lift — the body is the base load.
    expect(resolveBodyweightKind("Dip", true)).toBe(true);
    expect(resolveBodyweightKind("Pull Up", true)).toBe(true);
  });

  it("folds bodyweight into the Push Up KIND exactly like Dip / Pull Up (#835)", () => {
    // Push Up joined the catalog as a `bodyweight: true` lift, so its own body is
    // the base load: it classifies as bodyweight on every strength surface — folded
    // into volume/e1RM like the Dip and Pull Up — even when a vest/plate is logged
    // (a loaded row's external weight is ADDED to bodyweight, not a separate KIND).
    expect(isBodyweight("Push Up")).toBe(true);
    expect(resolveBodyweightKind("Push Up", false)).toBe(true);
    expect(resolveBodyweightKind("Push Up", true)).toBe(true);
    // And it agrees with the other catalog bodyweight pushes over the same inputs.
    expect(resolveBodyweightKind("Push Up", true)).toBe(
      resolveBodyweightKind("Dip", true)
    );
  });

  it("is bodyweight for a non-catalog lift never loaded externally", () => {
    expect(resolveBodyweightKind("Sled Drag", false)).toBe(true);
  });

  it("is weighted for a non-catalog lift ever loaded externally", () => {
    expect(resolveBodyweightKind("Sled Drag", true)).toBe(false);
  });
});

describe("classifyBodyweightByExercise", () => {
  it("keys by trimmed/lowercased name and ORs external-weight across rows", () => {
    const rows: BodyweightClassifyRow[] = [
      { exercise: "  Farmer Carry ", hasExternalWeight: false },
      { exercise: "farmer carry", hasExternalWeight: true }, // one loaded row wins
    ];
    const map = classifyBodyweightByExercise(rows);
    expect(map.get("farmer carry")).toBe(false); // saw external weight → weighted
    expect(map.size).toBe(1);
  });

  it("classifies a never-loaded custom lift as bodyweight", () => {
    const map = classifyBodyweightByExercise([
      { exercise: "Zercher Carry", hasExternalWeight: false },
    ]);
    expect(map.get("zercher carry")).toBe(true);
  });
});

describe("fixture parity: detail panel and editor chip agree on KIND (#331)", () => {
  // A non-catalog lift last loaded with external weight >365 days ago and done
  // bodyweight-only since — the exact case the two builders disagreed on: the
  // detail panel (all history) saw the old load → "add weight"; the editor chip
  // (365-day window) saw only bodyweight sets → "BW × N+1".
  const ALL_HISTORY: {
    exercise: string;
    hasExternalWeight: boolean;
    ageDays: number;
  }[] = [
    { exercise: "Sled Drag", hasExternalWeight: true, ageDays: 420 }, // stale load
    { exercise: "Sled Drag", hasExternalWeight: false, ageDays: 40 },
    { exercise: "Sled Drag", hasExternalWeight: false, ageDays: 12 },
  ];

  const strip = (r: (typeof ALL_HISTORY)[number]): BodyweightClassifyRow => ({
    exercise: r.exercise,
    hasExternalWeight: r.hasExternalWeight,
  });

  it("both builders classify the same over all history", () => {
    // getStrengthByExercise resolves over all rep-bearing history.
    const detailPanel = classifyBodyweightByExercise(ALL_HISTORY.map(strip));
    // getRecentExerciseHistory now reads the same all-history map (not a window).
    const editorChip = classifyBodyweightByExercise(ALL_HISTORY.map(strip));
    expect(editorChip).toEqual(detailPanel);
    expect(detailPanel.get("sled drag")).toBe(false); // weighted on both surfaces
  });

  it("the removed 365-day window is what made the two disagree", () => {
    // Pin the bug the fix eliminates: classifying over only the recent window
    // flips the kind to bodyweight, contradicting the all-history detail panel.
    const allHistory = classifyBodyweightByExercise(ALL_HISTORY.map(strip));
    const recentWindowOnly = classifyBodyweightByExercise(
      ALL_HISTORY.filter((r) => r.ageDays <= 365).map(strip)
    );
    expect(recentWindowOnly.get("sled drag")).toBe(true); // old, buggy answer
    expect(allHistory.get("sled drag")).toBe(false); // authoritative answer
    expect(recentWindowOnly).not.toEqual(allHistory);
  });
});
