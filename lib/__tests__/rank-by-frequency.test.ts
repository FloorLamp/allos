import { describe, expect, it } from "vitest";
import { rankByFrequency, rankByRecentFrequency } from "../rank-by-frequency";

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

describe("rankByRecentFrequency (#857 symptom/food picker order)", () => {
  const TODAY = "2026-07-16";

  it("keeps curated order when nothing has been logged", () => {
    expect(
      rankByRecentFrequency(["fever", "cough", "nausea"], [], TODAY)
    ).toEqual(["fever", "cough", "nausea"]);
  });

  it("ranks the profile's recurring symptoms ahead of the rest", () => {
    // Cough logged on three recent days, nausea once — cough leads, fever (never
    // logged) sinks to catalog order.
    const ranked = rankByRecentFrequency(
      ["fever", "cough", "nausea"],
      [
        { name: "cough", date: "2026-07-15" },
        { name: "cough", date: "2026-07-14" },
        { name: "cough", date: "2026-07-13" },
        { name: "nausea", date: "2026-07-15" },
      ],
      TODAY
    );
    expect(ranked).toEqual(["cough", "nausea", "fever"]);
  });

  it("weights recent occurrences above stale ones (recency decay)", () => {
    // Fever has more TOTAL logs but they're a year stale; cough's two are recent, so
    // the recency half-life floats cough above fever.
    const ranked = rankByRecentFrequency(
      ["fever", "cough"],
      [
        { name: "fever", date: "2025-07-16" },
        { name: "fever", date: "2025-07-16" },
        { name: "fever", date: "2025-07-16" },
        { name: "cough", date: "2026-07-15" },
        { name: "cough", date: "2026-07-14" },
      ],
      TODAY
    );
    expect(ranked).toEqual(["cough", "fever"]);
  });

  it("appends previously-used custom names, ranked by their own recent weight", () => {
    const ranked = rankByRecentFrequency(
      ["fever"],
      [
        { name: "ear ache", date: "2026-07-15" },
        { name: "ear ache", date: "2026-07-14" },
      ],
      TODAY
    );
    expect(ranked).toEqual(["ear ache", "fever"]);
  });

  it("honors an explicit per-occurrence weight (food servings)", () => {
    const ranked = rankByRecentFrequency(
      ["veg", "sweets"],
      [
        { name: "sweets", date: "2026-07-15", weight: 5 },
        { name: "veg", date: "2026-07-15", weight: 1 },
      ],
      TODAY
    );
    expect(ranked).toEqual(["sweets", "veg"]);
  });
});
