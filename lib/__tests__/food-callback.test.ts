// PURE TIER — the food-logging Telegram callback parsers + answer text (issue #682).
// The DB-driven handler half (handleFoodLog / handleFoodOptIn writing rows + flipping
// the flag) is covered in lib/__db_tests__/telegram-food.test.ts.

import { describe, it, expect } from "vitest";
import {
  parseFoodLogCallback,
  parseFoodOptInCallback,
  parseFoodProteinCallback,
  parseFoodExpandCallback,
  foodLogAnswerText,
  foodProteinAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
} from "@/lib/notifications/callback-data";
import {
  foodLessCallbackData,
  foodMoreCallbackData,
} from "@/lib/notifications/food-format";
import { isDoseDateAccepted } from "@/lib/dose-log-window";
import { shiftDateStr } from "@/lib/date";

describe("parseFoodLogCallback", () => {
  it("parses a well-formed token, reading an UNMARKED one as the nudge", () => {
    // The origin marker (#3087) is an optional segment of its own. A token without
    // one is a keyboard minted before it shipped, and the proactive nudge is what
    // almost all of those are — see lib/notifications/chat-origin.ts.
    expect(
      parseFoodLogCallback("food:5:Midday:2026-07-13:leafy_greens")
    ).toEqual({
      profileId: 5,
      window: "Midday",
      date: "2026-07-13",
      group: "leafy_greens",
      origin: "telegram-nudge",
    });
  });

  it("carries the MINT SITE's origin through the round trip (#3087)", () => {
    // `/food` re-renders the nudge's own builder, so this marker is the only thing
    // that distinguishes a slash-command tap from a proactive one at the handler.
    expect(
      parseFoodLogCallback("food:c:5:Midday:2026-07-13:leafy_greens")?.origin
    ).toBe("telegram-command");
    expect(
      parseFoodLogCallback("food:n:5:Midday:2026-07-13:leafy_greens")?.origin
    ).toBe("telegram-nudge");
    // The slug is still the greedy tail, marker or not.
    expect(
      parseFoodLogCallback("food:c:5:Midday:2026-07-13:leafy_greens")?.group
    ).toBe("leafy_greens");
    // An unknown marker letter is not a token this app ever minted.
    expect(parseFoodLogCallback("food:z:5:Midday:2026-07-13:x")).toBeNull();
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
  it("parses a well-formed token, with the same optional origin marker", () => {
    expect(
      parseFoodProteinCallback("foodprotein:5:Evening:2026-07-13:30")
    ).toEqual({
      profileId: 5,
      window: "Evening",
      date: "2026-07-13",
      grams: 30,
      origin: "telegram-nudge",
    });
    expect(
      parseFoodProteinCallback("foodprotein:c:5:Evening:2026-07-13:30")?.origin
    ).toBe("telegram-command");
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

describe("parseFoodExpandCallback (#1075 more / #1807 less)", () => {
  it("parses both directions off one token shape", () => {
    expect(parseFoodExpandCallback("foodmore:5:Morning:2026-07-13")).toEqual({
      profileId: 5,
      window: "Morning",
      date: "2026-07-13",
      action: "more",
    });
    expect(parseFoodExpandCallback("foodless:5:Morning:2026-07-13")).toEqual({
      profileId: 5,
      window: "Morning",
      date: "2026-07-13",
      action: "less",
    });
  });
  it("round-trips the builders' own tokens", () => {
    expect(
      parseFoodExpandCallback(foodMoreCallbackData(9, "Evening", "2026-07-13"))
    ).toEqual({
      profileId: 9,
      window: "Evening",
      date: "2026-07-13",
      action: "more",
    });
    expect(
      parseFoodExpandCallback(foodLessCallbackData(9, "Evening", "2026-07-13"))
    ).toEqual({
      profileId: 9,
      window: "Evening",
      date: "2026-07-13",
      action: "less",
    });
  });
  it("rejects a bad window, a food-log token, or a neighbouring prefix", () => {
    expect(parseFoodExpandCallback("foodmore:5:Bedtime:2026-07-13")).toBeNull();
    expect(parseFoodExpandCallback("foodless:5:Bedtime:2026-07-13")).toBeNull();
    expect(
      parseFoodExpandCallback("food:5:Morning:2026-07-13:leafy_greens")
    ).toBeNull();
    expect(parseFoodExpandCallback("foodmore:0:Morning:2026-07-13")).toBeNull();
    expect(parseFoodExpandCallback("foodless:0:Morning:2026-07-13")).toBeNull();
    // A prefix that merely starts the same way is not an expansion tap.
    expect(
      parseFoodExpandCallback("foodprotein:5:Morning:2026-07-13:30")
    ).toBeNull();
    expect(parseFoodExpandCallback("foodoptin:5:yes")).toBeNull();
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
      foodLogAnswerText(
        { kind: "logged", eventId: 1, servings: 1 },
        "fatty_fish"
      )
    ).toBe("Logged ✅ Fatty fish");
    expect(
      foodLogAnswerText(
        { kind: "logged", eventId: 1, servings: 3 },
        "fatty_fish"
      )
    ).toBe("Logged ✅ Fatty fish ×3 today");
  });
  it("answers honestly for an unknown/stale group — never a false confirm", () => {
    const t = foodLogAnswerText({ kind: "unknown-group" }, "gone");
    expect(t).not.toContain("Logged ✅");
    expect(t).toContain("out of date");
  });
});

describe("foodTapDateGuard (cross-date guard, #947, windowed by #4118)", () => {
  // THE WHOLE WINDOW, INCLUDING BOTH SIDES OF EVERY EDGE. #4118 replaced #947's
  // same-day rule with the message-date window the dose buttons on the same message
  // already use, so the guard now answers three things and the two boundaries between
  // them are the assertion: one day either side of `DOSE_LOG_DATE_WINDOW_DAYS`.
  //
  // `recent-day` is not a softer `stale-date`. It is the state that makes the owner's
  // report ("I can only update the morning supplement times, not food") false: the
  // serving LANDS, on the message's own day, and the handler withholds the eating
  // instant because "I'm eating now" is untrue about a day that has ended.
  it.each([
    ["same day", "2026-07-18", "current-day"],
    ["one day late — inside the window", "2026-07-17", "recent-day"],
    ["two days late — the last day inside", "2026-07-16", "recent-day"],
    ["three days late — the first day outside", "2026-07-15", "stale-date"],
    ["a week late", "2026-07-11", "stale-date"],
    ["tomorrow (clock skew / forged)", "2026-07-19", "recent-day"],
    ["three days ahead — outside", "2026-07-21", "stale-date"],
    ["not a date at all", "not-a-date", "stale-date"],
  ] as const)("%s → %s", (_why, tokenDate, kind) => {
    expect(foodTapDateGuard(tokenDate, "2026-07-18").kind).toBe(kind);
  });

  it("keeps the tz-midnight seam, now as the current-day/recent-day edge", () => {
    // A 23:59 tap on the previous day's nudge resolves 'today' still = the old day, so
    // the tap is CURRENT and its instant is a real eating time; one minute later 'today'
    // has rolled over and the same tap is a RECENT-day backfill onto the message's own
    // day instead. The pure guard sees only the two date strings the handler already
    // resolved from the profile's tz — that is the whole seam, and what changed at
    // #4118 is what happens on the far side of it, never where it falls.
    expect(foodTapDateGuard("2026-07-17", "2026-07-17").kind).toBe(
      "current-day"
    );
    expect(foodTapDateGuard("2026-07-17", "2026-07-18").kind).toBe(
      "recent-day"
    );
  });

  it("reads the SAME window the dose buttons beside it gate on", () => {
    // Derived, never re-spelled: the food half of a message must not be able to drift
    // from its dose half again. Asserted over the window's own constant so widening
    // `DOSE_LOG_DATE_WINDOW_DAYS` moves both together or fails here.
    const todayStr = "2026-07-18";
    for (let d = -4; d <= 4; d++) {
      const day = shiftDateStr(todayStr, d);
      expect(
        foodTapDateGuard(day, todayStr).kind !== "stale-date",
        `${day} vs ${todayStr}`
      ).toBe(isDoseDateAccepted(todayStr, day));
    }
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
