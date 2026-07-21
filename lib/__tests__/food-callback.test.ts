// PURE TIER — the food-logging Telegram callback parsers + answer text (issue #682).
// The DB-driven handler half (handleFoodLog / handleFoodOptIn writing rows + flipping
// the flag) is covered in lib/__db_tests__/telegram-food.test.ts.

import { describe, it, expect } from "vitest";
import {
  parseFoodLogCallback,
  parseFoodOptInCallback,
  parseFoodProteinCallback,
  parseFoodMoreCallback,
  foodLogAnswerText,
  foodProteinAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
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

describe("parseFoodProteinCallback (#1073)", () => {
  it("parses a well-formed token", () => {
    expect(
      parseFoodProteinCallback("foodprotein:5:Evening:2026-07-13:30")
    ).toEqual({
      profileId: 5,
      window: "Evening",
      date: "2026-07-13",
      grams: 30,
    });
  });
  it("rejects a bad window, non-numeric/zero grams, or a food-log token", () => {
    expect(
      parseFoodProteinCallback("foodprotein:5:Bedtime:2026-07-13:30")
    ).toBeNull();
    expect(
      parseFoodProteinCallback("foodprotein:5:Evening:2026-07-13:0")
    ).toBeNull();
    expect(
      parseFoodProteinCallback("foodprotein:5:Evening:2026-07-13:x")
    ).toBeNull();
    expect(
      parseFoodProteinCallback("food:5:Evening:2026-07-13:leafy_greens")
    ).toBeNull();
  });
});

describe("parseFoodMoreCallback (#1075)", () => {
  it("parses a well-formed token", () => {
    expect(parseFoodMoreCallback("foodmore:5:Morning:2026-07-13")).toEqual({
      profileId: 5,
      window: "Morning",
      date: "2026-07-13",
    });
  });
  it("rejects a bad window or a food-log token", () => {
    expect(parseFoodMoreCallback("foodmore:5:Bedtime:2026-07-13")).toBeNull();
    expect(
      parseFoodMoreCallback("food:5:Morning:2026-07-13:leafy_greens")
    ).toBeNull();
    expect(parseFoodMoreCallback("foodmore:0:Morning:2026-07-13")).toBeNull();
  });
});

describe("foodProteinAnswerText (#1073)", () => {
  it("names the grams added and the day's running total on a logged add", () => {
    expect(foodProteinAnswerText({ kind: "logged", grams: 90 }, 30)).toBe(
      "Logged ✅ ＋30 g protein — 90 g today"
    );
  });
  it("answers honestly for an invalid amount — never a false confirm", () => {
    const t = foodProteinAnswerText({ kind: "invalid" }, 30);
    expect(t).not.toContain("Logged ✅");
    expect(t).toContain("out of date");
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

describe("foodTapDateGuard (cross-date guard, #947)", () => {
  it("current-day when the token date equals today", () => {
    expect(foodTapDateGuard("2026-07-18", "2026-07-18")).toEqual({
      kind: "current-day",
    });
  });

  it("stale-date when the token date is yesterday", () => {
    expect(foodTapDateGuard("2026-07-17", "2026-07-18")).toEqual({
      kind: "stale-date",
    });
  });

  it("stale-date when the token date is a future day (clock skew / forged)", () => {
    expect(foodTapDateGuard("2026-07-19", "2026-07-18").kind).toBe(
      "stale-date"
    );
  });

  it("pins the tz-midnight boundary: 23:59 vs 00:01 around the profile's midnight", () => {
    // A 23:59 tap on the previous day's nudge resolves 'today' still = the old day,
    // so a same-day tap keeps logging; one minute later 'today' has rolled over and
    // the same stale nudge is refused. The pure guard sees only the two date strings
    // the handler already resolved from the profile's tz — that's the whole seam.
    expect(foodTapDateGuard("2026-07-17", "2026-07-17").kind).toBe(
      "current-day"
    );
    expect(foodTapDateGuard("2026-07-17", "2026-07-18").kind).toBe(
      "stale-date"
    );
  });

  it("stale answer names the date and never falsely confirms", () => {
    const t = foodStaleDateAnswerText("2026-07-17");
    expect(t).toContain("2026-07-17");
    expect(t).not.toContain("Logged ✅");
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
