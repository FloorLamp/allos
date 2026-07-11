import { describe, it, expect } from "vitest";
import {
  OUTDATED_MESSAGE_TEXT,
  escalationAckAnswerText,
  escalationAckCloseText,
  escalationTakeCloseText,
  parseAllCallback,
  parseEscalationCallback,
  parsePreventiveCallback,
  parseRefillCallback,
  parseSkipCallback,
  parseTakeCallback,
  preventiveAnswerText,
  refillAnswerText,
  removeButton,
  removeRowContaining,
  replacementWithTitle,
  resolveEscalationTap,
  resolveTapProfile,
  takeMatchesProfile,
  tapAnswerText,
  tapLogged,
  tapResolved,
  tapSkipAnswerText,
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
  it("acknowledges only real TAKEN confirmations as logged", () => {
    expect(tapLogged("logged")).toBe(true);
    expect(tapLogged("already-taken")).toBe(true);
    // Resolved, but NOT as taken (#280) — a ✅ tap on a skipped dose logged nothing.
    expect(tapLogged("already-skipped")).toBe(false);
    expect(tapLogged("stale-dose")).toBe(false);
    expect(tapLogged("inactive")).toBe(false);
  });

  it("answers 'Logged ✅' for confirmations and idempotent repeats", () => {
    expect(tapAnswerText("logged")).toBe("Logged ✅");
    expect(tapAnswerText("already-taken")).toBe("Logged ✅");
  });

  it("a ✅ tap on a dose meanwhile SKIPPED names the skip, not 'Logged' (#280)", () => {
    expect(tapAnswerText("already-skipped")).toMatch(/^Not logged/);
    expect(tapAnswerText("already-skipped")).toMatch(/skipped/i);
    expect(tapAnswerText("already-skipped")).not.toContain("Logged ✅");
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

// ⏭ Skip button (#232): same token shape as take, "skip" prefix.
describe("parseSkipCallback", () => {
  it("parses a well-formed skip token", () => {
    expect(parseSkipCallback("skip:2:12:34:2026-07-03")).toEqual({
      profileId: 2,
      doseId: 12,
      suppId: 34,
      date: "2026-07-03",
    });
  });

  it("nulls a zero suppId (unlinked dose) like take", () => {
    expect(parseSkipCallback("skip:1:12:0:2026-07-03")).toEqual({
      profileId: 1,
      doseId: 12,
      suppId: null,
      date: "2026-07-03",
    });
  });

  it("rejects a take token, malformed ids, or a missing date", () => {
    expect(parseSkipCallback("take:2:12:34:2026-07-03")).toBeNull();
    expect(parseSkipCallback("skip:1:abc:34:2026-07-03")).toBeNull();
    expect(parseSkipCallback("skip:1:0:34:2026-07-03")).toBeNull();
    expect(parseSkipCallback("skip:1:12:34")).toBeNull();
    expect(parseSkipCallback(undefined)).toBeNull();
  });
});

// A ⏭ Skip tap answers honestly per outcome. A skip never overwrites an already-
// resolved dose, and (#280) the acknowledgement must match the status that
// actually stands: "Skipped ⏭" only for a fresh skip or a repeat of one — a
// stale ⏭ tap on a dose already logged as TAKEN must never read as a skip.
describe("skip tap outcome → answer", () => {
  it("answers 'Skipped ⏭' for a fresh skip and an idempotent repeat", () => {
    expect(tapSkipAnswerText("skipped")).toBe("Skipped ⏭");
    expect(tapSkipAnswerText("already-skipped")).toBe("Skipped ⏭");
  });

  it("a ⏭ tap on a dose meanwhile TAKEN names the taken log, not 'Skipped' (#280)", () => {
    expect(tapSkipAnswerText("already-taken")).toMatch(/^Not skipped/);
    expect(tapSkipAnswerText("already-taken")).toMatch(/taken/i);
    expect(tapSkipAnswerText("already-taken")).not.toContain("Skipped ⏭");
  });

  it("says 'Not logged' for a stale or paused skip tap", () => {
    expect(tapSkipAnswerText("stale-dose")).toMatch(/^Not logged/);
    expect(tapSkipAnswerText("inactive")).toMatch(/^Not logged/);
    expect(tapSkipAnswerText("stale-dose")).not.toContain("Skipped");
  });

  it("tapResolved is true for any standing resolution (either status) only", () => {
    expect(tapResolved("logged")).toBe(true);
    expect(tapResolved("skipped")).toBe(true);
    expect(tapResolved("already-taken")).toBe(true);
    expect(tapResolved("already-skipped")).toBe(true);
    expect(tapResolved("stale-dose")).toBe(false);
    expect(tapResolved("inactive")).toBe(false);
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

// #233: a preventive item's ✅/🚫/⏰ trio (and a refill item's snooze + deep-link
// pair) share ONE row, so consuming any button resolves the whole item — its
// siblings, and any url button (no callback_data to match), drop with it.
describe("removeRowContaining", () => {
  const kb: InlineKeyboard = [
    [
      { text: "✅ Done", callback_data: "pvdone:1:colorectal_cancer" },
      { text: "🚫", callback_data: "pvna:1:colorectal_cancer" },
      { text: "⏰", callback_data: "pvlater:1:colorectal_cancer" },
    ],
    [
      { text: "📦 Ordered", callback_data: "rfsnooze:1:7" },
      { text: "Open form", url: "https://x/medicine" },
    ],
  ];

  it("drops the whole row the tapped button sits in (siblings + url button)", () => {
    expect(removeRowContaining(kb, "pvna:1:colorectal_cancer")).toEqual([
      kb[1],
    ]);
    expect(removeRowContaining(kb, "rfsnooze:1:7")).toEqual([kb[0]]);
  });

  it("returns empty when the last remaining row is consumed", () => {
    expect(removeRowContaining([kb[0]], "pvdone:1:colorectal_cancer")).toEqual(
      []
    );
  });

  it("leaves the keyboard alone for an unknown token", () => {
    expect(removeRowContaining(kb, "pvdone:1:other")).toEqual(kb);
  });
});

// ---- Phase 1: preventive-nudge buttons (#233) ----
describe("parsePreventiveCallback", () => {
  it("parses each action, carrying the profile id and stable rule key", () => {
    expect(parsePreventiveCallback("pvdone:2:colorectal_cancer")).toEqual({
      profileId: 2,
      ruleKey: "colorectal_cancer",
      action: "done",
    });
    expect(parsePreventiveCallback("pvna:1:blood_pressure")).toEqual({
      profileId: 1,
      ruleKey: "blood_pressure",
      action: "na",
    });
    expect(parsePreventiveCallback("pvlater:3:adult_physical")).toEqual({
      profileId: 3,
      ruleKey: "adult_physical",
      action: "later",
    });
  });

  it("rejects unknown prefixes, a zero profile, and malformed tokens", () => {
    expect(parsePreventiveCallback("take:1:12:34:2026-07-03")).toBeNull();
    expect(parsePreventiveCallback("pvdone:0:colorectal_cancer")).toBeNull();
    expect(parsePreventiveCallback("pvdone:1:")).toBeNull(); // no rule key
    expect(parsePreventiveCallback("pvmaybe:1:x")).toBeNull(); // not an action
    expect(parsePreventiveCallback(undefined)).toBeNull();
  });
});

describe("preventiveAnswerText", () => {
  it("confirms each action and never claims success for an unknown rule", () => {
    expect(preventiveAnswerText("done")).toMatch(/done/i);
    expect(preventiveAnswerText("not-applicable")).toMatch(/not applicable/i);
    expect(preventiveAnswerText("reminded")).toMatch(/later/i);
    expect(preventiveAnswerText("unknown-rule")).toMatch(/^Not recorded/);
    expect(preventiveAnswerText("unknown-rule")).not.toMatch(/✅/);
  });
});

// ---- Phase 3: refill-nudge snooze button (#233) ----
describe("parseRefillCallback", () => {
  it("parses a well-formed snooze token", () => {
    expect(parseRefillCallback("rfsnooze:2:7")).toEqual({
      profileId: 2,
      suppId: 7,
    });
  });

  it("rejects a zero id, wrong prefix, or missing field", () => {
    expect(parseRefillCallback("rfsnooze:0:7")).toBeNull();
    expect(parseRefillCallback("rfsnooze:2:0")).toBeNull();
    expect(parseRefillCallback("rfsnooze:2")).toBeNull();
    expect(parseRefillCallback("take:1:12:34:2026-07-03")).toBeNull();
    expect(parseRefillCallback(undefined)).toBeNull();
  });
});

describe("refillAnswerText", () => {
  it("acknowledges a snooze and never claims success for a stale item", () => {
    expect(refillAnswerText("snoozed")).toMatch(/3 days/);
    expect(refillAnswerText("stale-item")).toMatch(/^Not recorded/);
  });
});

// ---- Phase 2: escalation buttons (#233) ----
describe("parseEscalationCallback", () => {
  it("parses the confirm and ack tokens (dose-token shape)", () => {
    expect(parseEscalationCallback("esctake:3:7:10:2026-07-11")).toEqual({
      profileId: 3,
      doseId: 7,
      suppId: 10,
      date: "2026-07-11",
      action: "take",
    });
    expect(parseEscalationCallback("escack:3:7:10:2026-07-11")).toEqual({
      profileId: 3,
      doseId: 7,
      suppId: 10,
      date: "2026-07-11",
      action: "ack",
    });
  });

  it("nulls a zero supp id and rejects malformed/foreign tokens", () => {
    expect(
      parseEscalationCallback("escack:3:7:0:2026-07-11")?.suppId
    ).toBeNull();
    expect(parseEscalationCallback("esctake:3:0:10:2026-07-11")).toBeNull();
    expect(parseEscalationCallback("esctake:3:7:10")).toBeNull(); // no date
    expect(parseEscalationCallback("take:3:7:10:2026-07-11")).toBeNull();
    expect(parseEscalationCallback(undefined)).toBeNull();
  });
});

// AUTHORIZATION (#233): a tap is authorized when its chat is the profile's own
// delivery chat OR the supp's escalate_chat_id — anyone in that chat may act
// (household caregiving). A chat outside the authorized set is refused.
describe("resolveEscalationTap", () => {
  const token = { profileId: 3 };

  it("authorizes a tap from the profile's own chat", () => {
    expect(resolveEscalationTap(token, "111", ["111", null])).toBe(3);
  });

  it("authorizes a tap from the supplement's escalate (caregiver) chat", () => {
    expect(resolveEscalationTap(token, "999", ["111", "999"])).toBe(3);
  });

  it("refuses a tap from an unrelated chat, or when no chats are configured", () => {
    expect(resolveEscalationTap(token, "222", ["111", "999"])).toBeNull();
    expect(
      resolveEscalationTap(token, "111", [null, "", undefined])
    ).toBeNull();
    expect(resolveEscalationTap(token, "", ["111"])).toBeNull();
  });
});

describe("escalationAckAnswerText", () => {
  it("acknowledges without claiming taken, and answers stale/taken honestly", () => {
    expect(escalationAckAnswerText("acknowledged")).toMatch(
      /not marked taken/i
    );
    expect(escalationAckAnswerText("already-taken")).toMatch(/taken ✅/);
    expect(escalationAckAnswerText("inactive")).toMatch(/paused/i);
    expect(escalationAckAnswerText("stale-dose")).toMatch(/out of date/i);
    expect(escalationAckAnswerText("acknowledged")).not.toMatch(/✅/);
  });

  it("a dose meanwhile SKIPPED reads as resolved-by-skip, not a fresh ack (#280)", () => {
    expect(escalationAckAnswerText("already-skipped")).toMatch(/skipped/i);
    expect(escalationAckAnswerText("already-skipped")).not.toMatch(
      /hold off|taken ✅/i
    );
  });
});

// #280: the replacement message bodies come from the same outcome the toast
// does, so the two can never disagree — and neither may claim a resolution
// that isn't the one persisted.
describe("escalation close texts", () => {
  it("✅ Confirmed-taken close says taken only when a taken log stands", () => {
    expect(escalationTakeCloseText("logged")).toBe("Confirmed taken ✅");
    expect(escalationTakeCloseText("already-taken")).toBe("Confirmed taken ✅");
  });

  it("✅ close on a dose meanwhile SKIPPED names the skip, never 'Confirmed taken'", () => {
    expect(escalationTakeCloseText("already-skipped")).toMatch(/skipped/i);
    expect(escalationTakeCloseText("already-skipped")).not.toContain(
      "Confirmed taken"
    );
  });

  it("✅ close falls back to the outdated body for stale/paused taps", () => {
    expect(escalationTakeCloseText("stale-dose")).toBe(OUTDATED_MESSAGE_TEXT);
    expect(escalationTakeCloseText("inactive")).toBe(OUTDATED_MESSAGE_TEXT);
  });

  it("👍 ack close mirrors the ack outcome (hold off / taken / skipped / outdated)", () => {
    expect(escalationAckCloseText("acknowledged")).toMatch(/hold off/i);
    expect(escalationAckCloseText("already-taken")).toMatch(/taken ✅/);
    expect(escalationAckCloseText("already-skipped")).toMatch(/skipped/i);
    expect(escalationAckCloseText("already-skipped")).not.toMatch(
      /taken ✅|hold off/i
    );
    expect(escalationAckCloseText("stale-dose")).toBe(OUTDATED_MESSAGE_TEXT);
    expect(escalationAckCloseText("inactive")).toBe(OUTDATED_MESSAGE_TEXT);
  });
});

// A consumed escalation/preventive/refill (or collapsed dose) message must keep
// its original title line above the closing so shared-chat history stays
// attributable — a bare "Confirmed taken ✅" erases WHO/WHICH med the tap
// resolved (issue #377).
describe("replacementWithTitle", () => {
  it("keeps the original title line (incl. a [Name] prefix) above the closing", () => {
    expect(
      replacementWithTitle(
        "[Ada] ⚠️ Missed dose: Vitamin D\nTake it when you can.",
        "Confirmed taken ✅"
      )
    ).toBe("[Ada] ⚠️ Missed dose: Vitamin D\nConfirmed taken ✅");
  });

  it("uses only the first line of a multi-line original", () => {
    expect(
      replacementWithTitle(
        "[Ben] 💊 Morning supplements\nD3\nMagnesium",
        "done"
      )
    ).toBe("[Ben] 💊 Morning supplements\ndone");
  });

  it("trims surrounding whitespace on the title line", () => {
    expect(
      replacementWithTitle("  [Ada] Refill: Fish oil  \n…", "snoozed")
    ).toBe("[Ada] Refill: Fish oil\nsnoozed");
  });

  it("falls back to the bare closing when there is no original text", () => {
    expect(replacementWithTitle(undefined, "Confirmed taken ✅")).toBe(
      "Confirmed taken ✅"
    );
    expect(replacementWithTitle(null, "done")).toBe("done");
    expect(replacementWithTitle("", "done")).toBe("done");
    expect(replacementWithTitle("   \n…", "done")).toBe("done");
  });

  it("keeps two family members' consumed messages distinguishable", () => {
    const ada = replacementWithTitle(
      "[Ada] 💊 Morning supplements",
      "All done 💊✅"
    );
    const ben = replacementWithTitle(
      "[Ben] 💊 Morning supplements",
      "All done 💊✅"
    );
    expect(ada).not.toBe(ben);
    expect(ada).toContain("[Ada]");
    expect(ben).toContain("[Ben]");
  });
});
