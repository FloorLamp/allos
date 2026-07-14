// PURE TIER — the food-logging Telegram callback parsers + answer text (issue #682).
// The DB-driven handler half (handleFoodLog / handleFoodOptIn writing rows + flipping
// the flag) is covered in lib/__db_tests__/telegram-food.test.ts.

import { describe, it, expect } from "vitest";
import {
  parseFoodLogCallback,
  parseFoodOptInCallback,
  foodLogAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
} from "@/lib/notifications/callback-data";

describe("parseFoodLogCallback", () => {
  it("parses a well-formed token", () => {
    expect(
      parseFoodLogCallback("food:5:Midday:2026-07-13:leafy_greens")
    ).toEqual({
      profileId: 5,
      window: "Midday",
      date: "2026-07-13",
      group: "leafy_greens",
    });
  });

  it("rejects a bad window, missing fields, or the wrong prefix", () => {
    expect(parseFoodLogCallback("food:5:Bedtime:2026-07-13:x")).toBeNull();
    expect(parseFoodLogCallback("food:5:Midday:2026-07-13:")).toBeNull();
    expect(parseFoodLogCallback("food:0:Midday:2026-07-13:x")).toBeNull();
    expect(parseFoodLogCallback("take:5:1:2:2026-07-13")).toBeNull();
    expect(parseFoodLogCallback(42)).toBeNull();
  });
});

describe("parseFoodOptInCallback", () => {
  it("parses yes/no", () => {
    expect(parseFoodOptInCallback("foodoptin:9:yes")).toEqual({
      profileId: 9,
      enable: true,
    });
    expect(parseFoodOptInCallback("foodoptin:9:no")).toEqual({
      profileId: 9,
      enable: false,
    });
  });
  it("rejects malformed tokens", () => {
    expect(parseFoodOptInCallback("foodoptin:9:maybe")).toBeNull();
    expect(parseFoodOptInCallback("foodoptin:0:yes")).toBeNull();
    expect(parseFoodOptInCallback("foodoptin:yes")).toBeNull();
  });
});

describe("foodLogAnswerText", () => {
  it("names the group and running count on a logged serving", () => {
    expect(
      foodLogAnswerText({ kind: "logged", servings: 1 }, "fatty_fish")
    ).toBe("Logged ✅ Fatty fish");
    expect(
      foodLogAnswerText({ kind: "logged", servings: 3 }, "fatty_fish")
    ).toBe("Logged ✅ Fatty fish ×3 today");
  });
  it("answers honestly for an unknown/stale group — never a false confirm", () => {
    const t = foodLogAnswerText({ kind: "unknown-group" }, "gone");
    expect(t).not.toContain("Logged ✅");
    expect(t).toContain("out of date");
  });
});

describe("opt-in answer/close text", () => {
  it("differs by choice", () => {
    expect(foodOptInAnswerText(true)).toContain("on");
    expect(foodOptInAnswerText(false)).toContain("Settings");
    expect(foodOptInCloseText(true)).toContain("enabled");
    expect(foodOptInCloseText(false)).toContain("Settings");
  });
});
