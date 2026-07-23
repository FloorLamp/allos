import { describe, expect, it } from "vitest";
import {
  parseProtocolPractice,
  parseScopedPractice,
  practiceSelectValue,
} from "../protocol-practice";

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

describe("parseScopedPractice (#580 — activity OR food group)", () => {
  it("parses a bare activity type as a 'type' scope", () => {
    expect(parseScopedPractice("cardio", "4")).toEqual({
      scopeKind: "type",
      scopeValue: "cardio",
      perWeek: 4,
      perWeekMax: null,
    });
  });

  it("parses a food_group:<slug> value as a 'food_group' scope", () => {
    expect(parseScopedPractice("food_group:fatty_fish", "2")).toEqual({
      scopeKind: "food_group",
      scopeValue: "fatty_fish",
      perWeek: 2,
      perWeekMax: null,
    });
  });

  it("rejects an unknown food group slug", () => {
    expect(parseScopedPractice("food_group:not_a_group", "2")).toBeNull();
  });

  it("rejects blank / unknown value or non-positive per-week", () => {
    expect(parseScopedPractice("", "2")).toBeNull();
    expect(parseScopedPractice("nonsense", "2")).toBeNull();
    expect(parseScopedPractice("food_group:fatty_fish", "0")).toBeNull();
  });

  it("round-trips through practiceSelectValue", () => {
    expect(practiceSelectValue("type", "cardio")).toBe("cardio");
    expect(practiceSelectValue("food_group", "fatty_fish")).toBe(
      "food_group:fatty_fish"
    );
    const v = practiceSelectValue("food_group", "legumes");
    expect(parseScopedPractice(v, "3")).toEqual({
      scopeKind: "food_group",
      scopeValue: "legumes",
      perWeek: 3,
      perWeekMax: null,
    });
  });
});
