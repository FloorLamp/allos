import { describe, expect, it } from "vitest";
import { parseProtocolPractice } from "../protocol-practice";

describe("parseProtocolPractice", () => {
  it("parses a valid type + per-week", () => {
    expect(parseProtocolPractice("cardio", "4")).toEqual({
      practiceType: "cardio",
      perWeek: 4,
    });
    expect(parseProtocolPractice("strength", 3)).toEqual({
      practiceType: "strength",
      perWeek: 3,
    });
  });

  it("returns null when the type is blank or unknown", () => {
    expect(parseProtocolPractice("", "4")).toBeNull();
    expect(parseProtocolPractice(null, "4")).toBeNull();
    expect(parseProtocolPractice("recovery", "4")).toBeNull();
    expect(parseProtocolPractice("sauna", "4")).toBeNull();
  });

  it("returns null when per-week is missing / non-positive / NaN", () => {
    expect(parseProtocolPractice("cardio", "")).toBeNull();
    expect(parseProtocolPractice("cardio", "0")).toBeNull();
    expect(parseProtocolPractice("cardio", "-2")).toBeNull();
    expect(parseProtocolPractice("cardio", "abc")).toBeNull();
    expect(parseProtocolPractice("cardio", null)).toBeNull();
  });

  it("floors and clamps per-week to [1, 14]", () => {
    expect(parseProtocolPractice("sport", "3.9")?.perWeek).toBe(3);
    expect(parseProtocolPractice("sport", "70")?.perWeek).toBe(14);
    expect(parseProtocolPractice("sport", "1")?.perWeek).toBe(1);
  });
});
