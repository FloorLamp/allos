import { describe, expect, it } from "vitest";
import { bodyweightAsOf } from "../bodyweight";

const weights = [
  { date: "2024-01-01", weight_kg: 80 },
  { date: "2024-02-01", weight_kg: 78 },
  { date: "2024-03-01", weight_kg: 76 },
];

describe("bodyweightAsOf", () => {
  it("returns null when there are no weights", () => {
    expect(bodyweightAsOf([], "2024-02-15")).toBeNull();
  });

  it("returns the most recent weight on or before the date", () => {
    expect(bodyweightAsOf(weights, "2024-02-15")).toBe(78);
  });

  it("matches exactly on a weigh-in date", () => {
    expect(bodyweightAsOf(weights, "2024-03-01")).toBe(76);
  });

  it("falls back to the earliest weight for a date before any weigh-in", () => {
    expect(bodyweightAsOf(weights, "2023-12-01")).toBe(80);
  });

  it("returns the latest weight for a date after the last weigh-in", () => {
    expect(bodyweightAsOf(weights, "2024-12-31")).toBe(76);
  });
});
