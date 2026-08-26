import { describe, expect, it } from "vitest";
import {
  CUSTOM_PRACTICE_VALUE,
  parseProtocolPractice,
  parseScopedPractice,
  practiceSelectValue,
  protocolPracticeNoun,
  scopeAcceptsPerWeekMax,
} from "../protocol-practice";

describe("protocolPracticeNoun", () => {
  it("counts a wellness practice in DAYS and everything else in its own unit", () => {
    // A practice is a per-day habit ("3 days this week"); a food group is counted in
    // servings and an activity type in sessions. ONE lookup, so the dashboard presentation
    // and the protocol detail page cannot count the same protocol in two units
    // (#2008).
    expect(protocolPracticeNoun("practice")).toBe("day");
    expect(protocolPracticeNoun("food_group")).toBe("serving");
    expect(protocolPracticeNoun("type")).toBe("session");
  });
});

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

// #3353 — the scope × Maximum-field matrix, as ONE property rather than one example.
//
// The editor offered a Maximum for every scope while the parse kept it for only one,
// so a sport protocol accepted a ceiling that silently did not exist.
// `scopeAcceptsPerWeekMax` is what the form now asks before rendering the field, and
// what it asks before letting the live cadence chip state a range — so the question
// that decides the FIELD has to be the same question that decides the VALUE. That is
// the assertion below: for every select value the picker can hold, the predicate and
// the parse agree, and neither is read off the other.
describe("scopeAcceptsPerWeekMax (#3353)", () => {
  it.each([
    { what: "an activity type", value: "sport", accepts: false },
    { what: "another activity type", value: "strength", accepts: false },
    { what: "a food group", value: "food_group:fatty_fish", accepts: false },
    { what: "a curated wellness practice", value: "practice:Sauna", accepts: true },
    { what: "the custom sentinel", value: CUSTOM_PRACTICE_VALUE, accepts: true },
  ])("$what: offers a Maximum = $accepts, and stores exactly that", ({ value, accepts }) => {
    expect(scopeAcceptsPerWeekMax(value)).toBe(accepts);
    // A max of 5 over a floor of 3 is storable in every other respect — > floor and
    // ≤ MAX_PER_WEEK — so what decides it here is the scope and nothing else.
    const parsed = parseScopedPractice(value, "3", "5", "Grounding walk");
    expect(parsed).not.toBeNull();
    expect(parsed?.perWeekMax != null).toBe(accepts);
  });

  it("says no to what the picker cannot hold", () => {
    // Blank and nonsense reach `parseScopedPractice` as "no practice at all"; the
    // editor asks this predicate BEFORE there is a practice, so it must answer.
    expect(scopeAcceptsPerWeekMax("")).toBe(false);
    expect(scopeAcceptsPerWeekMax(null)).toBe(false);
    expect(scopeAcceptsPerWeekMax("nonsense")).toBe(false);
  });
});
