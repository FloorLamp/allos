import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "@/lib/fuzzy";

describe("fuzzyScore", () => {
  it("matches a non-adjacent subsequence", () => {
    expect(fuzzyScore("Bench Press", "bpr")).not.toBeNull();
    expect(fuzzyScore("Overhead Press", "ohp")).not.toBeNull();
  });

  it("returns null when the query isn't a subsequence", () => {
    expect(fuzzyScore("Bench Press", "xyz")).toBeNull();
    // Right characters, wrong order.
    expect(fuzzyScore("Bench Press", "rpb")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("Bench Press", "BENCH")).not.toBeNull();
  });

  it("scores a contiguous substring above a scattered match", () => {
    const contiguous = fuzzyScore("Bench Press", "press")!;
    const scattered = fuzzyScore("Preacher Curl less", "press")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("rewards word-boundary matches", () => {
    // "bp" hitting the start of both words beats a mid-word subsequence.
    const boundary = fuzzyScore("Bench Press", "bp")!;
    const midWord = fuzzyScore("Abpress", "bp")!;
    expect(boundary).toBeGreaterThan(midWord);
  });

  it("scores an empty query as 0", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });
});

describe("fuzzyFilter", () => {
  const opts = ["Bench Press", "Incline Bench Press", "Leg Press", "Deadlift"];

  it("keeps only subsequence matches", () => {
    expect(fuzzyFilter(opts, "press")).toEqual([
      "Leg Press",
      "Bench Press",
      "Incline Bench Press",
    ]);
  });

  it("ranks the closest match first", () => {
    // Exact-ish short contiguous match outranks the longer one.
    expect(fuzzyFilter(opts, "bench")[0]).toBe("Bench Press");
  });

  it("returns the original order (capped) for an empty query", () => {
    expect(fuzzyFilter(opts, "", 2)).toEqual([
      "Bench Press",
      "Incline Bench Press",
    ]);
  });

  it("respects the limit", () => {
    expect(fuzzyFilter(opts, "e", 2)).toHaveLength(2);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(fuzzyFilter(opts, "  press  ")).toEqual([
      "Leg Press",
      "Bench Press",
      "Incline Bench Press",
    ]);
    // An all-whitespace query is treated as empty (original order).
    expect(fuzzyFilter(opts, "   ", 2)).toEqual([
      "Bench Press",
      "Incline Bench Press",
    ]);
  });

  it("breaks score ties toward the earlier option", () => {
    // Same length and same "De" start → identical scores, so input order wins.
    expect(fuzzyFilter(["Decline", "Destroy"], "de")).toEqual([
      "Decline",
      "Destroy",
    ]);
  });
});
