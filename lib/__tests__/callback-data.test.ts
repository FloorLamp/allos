import { describe, it, expect } from "vitest";
import {
  OUTDATED_MESSAGE_TEXT,
  parseAllCallback,
  parseTakeCallback,
  removeButton,
  resolveTapProfile,
  takeMatchesProfile,
  tapAnswerText,
  tapLogged,
  type InlineKeyboard,
} from "../notifications/callback-data";

describe("parseTakeCallback", () => {
  it("parses a full take token", () => {
    expect(parseTakeCallback("take:2:12:34:2026-07-03")).toEqual({
      profileId: 2,
      doseId: 12,
      suppId: 34,
      date: "2026-07-03",
    });
  });

  it("maps a missing/zero supplement id to null", () => {
    expect(parseTakeCallback("take:1:12:0:2026-07-03")).toEqual({
      profileId: 1,
      doseId: 12,
      suppId: null,
      date: "2026-07-03",
    });
    expect(parseTakeCallback("take:1:12::2026-07-03")).toEqual({
      profileId: 1,
      doseId: 12,
      suppId: null,
      date: "2026-07-03",
    });
  });

  it("rejects unknown prefixes and malformed tokens", () => {
    expect(parseTakeCallback("snooze:1:12:34:2026-07-03")).toBeNull();
    expect(parseTakeCallback("take:1:abc:34:2026-07-03")).toBeNull();
    expect(parseTakeCallback("take:1:0:34:2026-07-03")).toBeNull(); // zero dose
    expect(parseTakeCallback("take:0:12:34:2026-07-03")).toBeNull(); // zero profile
    expect(parseTakeCallback("take:1:12:34")).toBeNull(); // no date
    expect(parseTakeCallback("take:12:34:2026-07-03")).toBeNull(); // legacy (no profile)
    expect(parseTakeCallback(undefined)).toBeNull();
    expect(parseTakeCallback(42)).toBeNull();
  });
});

describe("parseAllCallback", () => {
  it("parses an all-taken token", () => {
    expect(parseAllCallback("all:2:Morning:2026-07-03")).toEqual({
      profileId: 2,
      window: "Morning",
      date: "2026-07-03",
    });
    expect(parseAllCallback("all:1:Bedtime:2026-07-03")?.window).toBe(
      "Bedtime"
    );
  });

  it("rejects unknown prefixes, bad windows, and malformed tokens", () => {
    expect(parseAllCallback("take:1:12:34:2026-07-03")).toBeNull(); // per-dose token
    expect(parseAllCallback("all:1:Lunchtime:2026-07-03")).toBeNull(); // not a window
    expect(parseAllCallback("all:1:morning:2026-07-03")).toBeNull(); // wrong case
    expect(parseAllCallback("all:0:Morning:2026-07-03")).toBeNull(); // zero profile
    expect(parseAllCallback("all:1:Morning")).toBeNull(); // no date
    expect(parseAllCallback(undefined)).toBeNull();
  });

  it("its profile id resolves against a shared chat like a per-dose tap", () => {
    // resolveTapProfile accepts any token carrying a profileId.
    expect(resolveTapProfile({ profileId: 2 }, [1, 2, 3])).toBe(2);
    expect(resolveTapProfile({ profileId: 9 }, [1, 2, 3])).toBeNull();
  });
});

describe("takeMatchesProfile", () => {
  const take = { profileId: 2, doseId: 12, suppId: 34, date: "2026-07-03" };
  it("is true only when the payload profile equals the resolved profile", () => {
    expect(takeMatchesProfile(take, 2)).toBe(true);
    expect(takeMatchesProfile(take, 1)).toBe(false);
  });
});

describe("resolveTapProfile", () => {
  const take = { profileId: 2, doseId: 12, suppId: 34, date: "2026-07-03" };

  it("returns the token's profile when it shares the chat", () => {
    expect(resolveTapProfile(take, [2])).toBe(2);
  });

  it("disambiguates a family chat by the token's profile id", () => {
    // Two profiles share one chat; a tap for profile 2 resolves to 2, not the
    // other profile (the old bare-.get() could pick either).
    expect(resolveTapProfile(take, [1, 2])).toBe(2);
    expect(resolveTapProfile({ ...take, profileId: 1 }, [1, 2])).toBe(1);
  });

  it("refuses a token for a profile not in the chat", () => {
    expect(resolveTapProfile(take, [1, 3])).toBeNull();
    expect(resolveTapProfile(take, [])).toBeNull();
  });
});

// A reminder message is a frozen snapshot: the tapped dose may have been
// deleted/retired or its item paused since it was sent. The answer must state
// what actually happened — "Logged ✅" is only honest for a real (or idempotent
// repeat) confirmation.
describe("tap outcome → answer", () => {
  it("acknowledges only real confirmations as logged", () => {
    expect(tapLogged("logged")).toBe(true);
    expect(tapLogged("already-logged")).toBe(true);
    expect(tapLogged("stale-dose")).toBe(false);
    expect(tapLogged("inactive")).toBe(false);
  });

  it("answers 'Logged ✅' for confirmations and idempotent repeats", () => {
    expect(tapAnswerText("logged")).toBe("Logged ✅");
    expect(tapAnswerText("already-logged")).toBe("Logged ✅");
  });

  it("says 'Not logged' for a stale or paused tap (never claims success)", () => {
    expect(tapAnswerText("stale-dose")).toMatch(/^Not logged/);
    expect(tapAnswerText("inactive")).toMatch(/^Not logged/);
    expect(tapAnswerText("stale-dose")).not.toContain("Logged ✅");
    expect(tapAnswerText("inactive")).not.toContain("Logged ✅");
  });

  it("has a stale replacement body distinct from the success closer", () => {
    expect(OUTDATED_MESSAGE_TEXT).toMatch(/out of date/);
    expect(OUTDATED_MESSAGE_TEXT).not.toContain("All done");
  });
});

describe("removeButton", () => {
  const kb: InlineKeyboard = [
    [{ text: "✅ A", callback_data: "take:1:1:1:2026-07-03" }],
    [{ text: "✅ B", callback_data: "take:1:2:2:2026-07-03" }],
  ];

  it("drops the tapped button and its emptied row", () => {
    expect(removeButton(kb, "take:1:1:1:2026-07-03")).toEqual([
      [{ text: "✅ B", callback_data: "take:1:2:2:2026-07-03" }],
    ]);
  });

  it("returns empty when the last button is tapped", () => {
    const one: InlineKeyboard = [
      [{ text: "✅ A", callback_data: "take:1:1:1:2026-07-03" }],
    ];
    expect(removeButton(one, "take:1:1:1:2026-07-03")).toEqual([]);
  });

  it("leaves the keyboard alone for an unknown token", () => {
    expect(removeButton(kb, "take:1:9:9:2026-07-03")).toEqual(kb);
  });
});
