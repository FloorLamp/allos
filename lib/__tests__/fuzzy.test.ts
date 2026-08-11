import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter, fuzzyFilterWithTerms } from "@/lib/fuzzy";

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
    expect(fuzzyFilter(opts, "", { limit: 2 })).toEqual([
      "Bench Press",
      "Incline Bench Press",
    ]);
  });

  it("respects the limit", () => {
    expect(fuzzyFilter(opts, "e", { limit: 2 })).toHaveLength(2);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(fuzzyFilter(opts, "  press  ")).toEqual([
      "Leg Press",
      "Bench Press",
      "Incline Bench Press",
    ]);
    // An all-whitespace query is treated as empty (original order).
    expect(fuzzyFilter(opts, "   ", { limit: 2 })).toEqual([
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

describe("fuzzyFilterWithTerms", () => {
  it("matches a hidden alias while returning the visible option", () => {
    const options = ["Hemoglobin A1c", "Glucose"];
    expect(
      fuzzyFilterWithTerms(
        options,
        "HbA1c",
        (option) => (option === "Hemoglobin A1c" ? ["HbA1c", "A1c"] : []),
        { limit: 8 }
      )
    ).toEqual(["Hemoglobin A1c"]);
  });
});

// The usage signal (#2384). One keystroke used to discard the activity picker's
// four rankers: the sort keeps the caller's order only as an exact-score tiebreak,
// and the fractional length term means exact ties essentially never occur.
describe("fuzzyFilter with a usage signal", () => {
  // The issue's own case. Base order is the picker's — lifts before cardio before
  // sports — so every squat already sits ahead of Squash before a key is pressed.
  const activities = [
    "Back Squat",
    "Front Squat",
    "Goblet Squat",
    "Hack Squat",
    "Bulgarian Split Squat",
    "Squash",
  ];
  const squats = new Set([
    "back squat",
    "front squat",
    "goblet squat",
    "hack squat",
    "bulgarian split squat",
  ]);
  const onlySquats = (ranked: string[]) =>
    ranked.filter((name) => name !== "Squash");

  it("puts logged squats above a never-logged Squash for 'sqa'", () => {
    const ranked = fuzzyFilter(activities, "sqa", { used: squats });
    expect(ranked[0]).toBe("Back Squat");
    // De-rank, not hide (#345): the sport this profile has never played is still
    // offered, so a first squash session stays one tap away.
    expect(ranked).toContain("Squash");
  });

  it("is a family, not one unlucky string", () => {
    for (const query of ["sq", "sqa", "squa"]) {
      expect(fuzzyFilter(activities, query, { used: squats })[0]).toBe(
        "Back Squat"
      );
    }
    // Once the query genuinely narrows, textual relevance decides alone again.
    expect(fuzzyFilter(activities, "squas", { used: squats })).toEqual([
      "Squash",
    ]);
  });

  it("cannot overturn a word-boundary or contiguity advantage", () => {
    // Bounded below +2 on purpose: a genuinely better textual match still wins,
    // even when the worse one is the option the profile actually uses.
    expect(
      fuzzyFilter(["Overhead Press", "Other Hip Push"], "ohp", {
        used: new Set(["other hip push"]),
      })[0]
    ).toBe("Overhead Press");
  });

  it("does not reorder two used options against each other", () => {
    // Bucketed presence, not raw frequency (#1490): usage separates used from
    // unused, and textual score still separates the used ones.
    expect(
      onlySquats(fuzzyFilter(activities, "sqa", { used: squats }))
    ).toEqual(onlySquats(fuzzyFilter(activities, "sqa")));
  });

  it("reproduces today's order exactly when `used` is omitted", () => {
    // The default is byte-for-byte the pre-#2384 behavior — which is also the
    // defect, so it is worth pinning: a picker earns the bonus by declaring
    // evidence, never by having an order.
    expect(fuzzyFilter(activities, "sqa")[0]).toBe("Squash");
    expect(fuzzyFilter(activities, "sqa", { used: new Set() })[0]).toBe(
      "Squash"
    );
  });

  it("leaves the empty query as the caller's own source order", () => {
    // Nothing typed means the caller's ranking IS the relevance view, so a usage
    // bonus must not reshuffle it; the limit still applies.
    expect(fuzzyFilter(activities, "", { used: new Set(["squash"]) })).toEqual(
      activities
    );
    expect(
      fuzzyFilter(activities, "", { limit: 2, used: new Set(["squash"]) })
    ).toEqual(["Back Squat", "Front Squat"]);
  });

  it("keys the bonus on the option, never on the term that matched", () => {
    // An alias is a spelling, not evidence of use.
    const options = ["Hemoglobin A1c", "Glucose"];
    const terms = (option: string) =>
      option === "Hemoglobin A1c" ? ["A1c"] : [];
    expect(
      fuzzyFilterWithTerms(options, "a1c", terms, { used: new Set(["a1c"]) })
    ).toEqual(fuzzyFilterWithTerms(options, "a1c", terms));
  });

  it("applies the same bonus through the alias-aware filter", () => {
    expect(
      fuzzyFilterWithTerms(["Squash", "Back Squat"], "sqa", () => [], {
        used: new Set(["back squat"]),
      })[0]
    ).toBe("Back Squat");
  });
});
