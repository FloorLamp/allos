import { describe, expect, it } from "vitest";
import { rankByFrequency } from "../rank-by-frequency";

describe("rankByFrequency", () => {
  it("keeps curated order when nothing has been logged", () => {
    expect(rankByFrequency(["Squat", "Bench", "Deadlift"], [])).toEqual([
      "Squat",
      "Bench",
      "Deadlift",
    ]);
  });

  it("ranks curated entries by usage count, descending", () => {
    const ranked = rankByFrequency(
      ["Squat", "Bench", "Deadlift"],
      [
        { name: "Deadlift", c: 10 },
        { name: "Squat", c: 3 },
      ]
    );
    expect(ranked).toEqual(["Deadlift", "Squat", "Bench"]);
  });

  it("matches counts to curated names case-insensitively", () => {
    const ranked = rankByFrequency(
      ["Squat", "Bench"],
      [{ name: "bench", c: 5 }]
    );
    expect(ranked).toEqual(["Bench", "Squat"]);
  });

  it("appends previously-used custom names, ranked by their own count", () => {
    const ranked = rankByFrequency(
      ["Squat"],
      [
        { name: "Zercher Squat", c: 2 },
        { name: "Jefferson Curl", c: 4 },
      ]
    );
    // Custom names come after curated on ties, but their counts still order them.
    expect(ranked).toEqual(["Jefferson Curl", "Zercher Squat", "Squat"]);
  });

  it("drops blank custom names", () => {
    const ranked = rankByFrequency(["Squat"], [{ name: "   ", c: 9 }]);
    expect(ranked).toEqual(["Squat"]);
  });

  it("preserves curated order on ties", () => {
    const ranked = rankByFrequency(
      ["A", "B", "C"],
      [
        { name: "A", c: 1 },
        { name: "C", c: 1 },
        { name: "B", c: 1 },
      ]
    );
    expect(ranked).toEqual(["A", "B", "C"]);
  });
});
