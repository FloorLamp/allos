import { describe, expect, it } from "vitest";
import {
  foodTapDateGuard,
  householdStaleDateAnswerText,
  tapDateGuard,
} from "@/lib/notifications/callback-data";
import {
  householdRoundPointerFromMessage,
  isHouseholdRoundMessage,
  parseHouseholdRoundPointer,
  serializeHouseholdRoundPointer,
} from "@/lib/notifications/household-round-pointer";
import {
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
} from "@/lib/notifications/callback-data";
import { parseTempReply } from "@/lib/notifications/telegram-quick-log";
import {
  parseTypedReplyMarker,
  resolveTypedReply,
  typedReplyMarker,
  typedReplyNumber,
  type OpenTypedPrompt,
} from "@/lib/notifications/typed-reply";

// Pure tests for the Telegram symptom/temp quick-log parsers (issue #859 item 5). No DB.

describe("symptom callback parsers", () => {
  it("parses a symptom pick token (slug is the greedy tail)", () => {
    expect(parseSymptomPickCallback("symp:7:sore_throat")).toEqual({
      profileId: 7,
      slug: "sore_throat",
    });
  });
  it("rejects a malformed symptom pick token", () => {
    expect(parseSymptomPickCallback("symp:7")).toBeNull();
    expect(parseSymptomPickCallback("nope:7:cough")).toBeNull();
    expect(parseSymptomPickCallback(42)).toBeNull();
  });

  it("parses a symptom severity token", () => {
    expect(parseSymptomSeverityCallback("symsev:7:3:sore_throat")).toEqual({
      profileId: 7,
      severity: 3,
      slug: "sore_throat",
    });
  });
  it("rejects an out-of-range severity", () => {
    expect(parseSymptomSeverityCallback("symsev:7:5:cough")).toBeNull();
    expect(parseSymptomSeverityCallback("symsev:7:0:cough")).toBeNull();
  });
});

// ---- The one typed-reply contract (issue #5650) ----
//
// Three grammars became one, and the three that already shipped have prompts sitting in
// real chats: every delivered string is pinned here as written, beside the canonical form
// new prompts carry. A regex that stops accepting one of the three is a prompt somebody
// replies to and gets silence from.

describe("the typed-reply marker grammar", () => {
  it.each([
    ["(#temp:12)", "temp", 12, null],
    ["(#weight:12)", "weight", 12, null],
    ["(refill:7:12)", "refill", 7, 12],
  ] as const)(
    "reads the delivered %s exactly as shipped",
    (marker, family, profileId, operationId) => {
      expect(parseTypedReplyMarker(`How many arrived? ${marker}`)).toEqual({
        family,
        profileId,
        operationId,
      });
    }
  );

  it("round-trips its own canonical form, which differs only by the spelled #", () => {
    expect(typedReplyMarker("temp", 12)).toBe("(#temp:12)");
    expect(typedReplyMarker("weight", 12)).toBe("(#weight:12)");
    expect(typedReplyMarker("refill", 7, 12)).toBe("(#refill:7:12)");
    for (const [family, profileId, operationId] of [
      ["temp", 12, undefined],
      ["refill", 7, 12],
    ] as const)
      expect(
        parseTypedReplyMarker(
          `Reply to this. ${typedReplyMarker(family, profileId, operationId)}`
        )
      ).toEqual({ family, profileId, operationId: operationId ?? null });
  });

  it("returns null when no marker is present", () => {
    expect(parseTypedReplyMarker("just some text")).toBeNull();
    expect(parseTypedReplyMarker(null)).toBeNull();
    // Not a family this build ships, and a zero profile is not a profile.
    expect(parseTypedReplyMarker("(#mood:12)")).toBeNull();
    expect(parseTypedReplyMarker("(#temp:0)")).toBeNull();
  });
});

describe("the bare-number rule", () => {
  it.each(["", "0", "-1", "Infinity", "2 bottles", "1,000", "2e3", "1 2"])(
    "refuses the whole ambiguous or nonpositive input %s",
    (text) => {
      expect(typedReplyNumber(text)).toBeNull();
    }
  );
  it("accepts a plain positive amount", () => {
    expect(typedReplyNumber(" 30.5 ")).toBe(30.5);
  });
});

describe("resolving a message to one open prompt", () => {
  const open: OpenTypedPrompt[] = [
    { family: "refill", profileId: 7, operationId: 12, promptId: 500 },
  ];
  const second: OpenTypedPrompt = {
    family: "temp",
    profileId: 7,
    operationId: null,
    promptId: 501,
  };

  it("attributes an explicit reply from the quoted marker, open prompts unread", () => {
    let read = 0;
    expect(
      resolveTypedReply(
        { text: "120", replyToText: "(refill:7:12)", replyToId: 500 },
        () => {
          read++;
          return [];
        }
      )
    ).toEqual({
      kind: "reply",
      reply: {
        family: "refill",
        profileId: 7,
        operationId: 12,
        promptId: 500,
        text: "120",
      },
    });
    expect(read).toBe(0);
  });

  it("resolves a bare number to the sender's single open prompt", () => {
    expect(resolveTypedReply({ text: "120" }, () => open)).toEqual({
      kind: "reply",
      reply: { ...open[0], text: "120" },
    });
  });

  it("refuses to choose, and leaves everything else to the rest of the chain", () => {
    expect(resolveTypedReply({ text: "120" }, () => [...open, second])).toEqual(
      {
        kind: "ambiguous",
      }
    );
    // No open prompt, not a number, and a reply that quoted something ELSE.
    expect(resolveTypedReply({ text: "120" }, () => [])).toEqual({
      kind: "none",
    });
    expect(resolveTypedReply({ text: "abc" }, () => open)).toEqual({
      kind: "none",
    });
    expect(
      resolveTypedReply(
        { text: "120", replyToText: "some other message", replyToId: 9 },
        () => open
      )
    ).toEqual({ kind: "none" });
  });
});

describe("temperature reply value grammar", () => {
  it("auto-detects °C for a bare low number and °F for a bare high one", () => {
    expect(parseTempReply("38.5")).toEqual({ value: 38.5, unit: "C" });
    expect(parseTempReply("101")).toEqual({ value: 101, unit: "F" });
  });
  it("honors an explicit C/F suffix over the auto-detect", () => {
    expect(parseTempReply("101 C")).toEqual({ value: 101, unit: "C" });
    expect(parseTempReply("38.5F")).toEqual({ value: 38.5, unit: "F" });
    expect(parseTempReply("38,5°c")).toEqual({ value: 38.5, unit: "C" });
  });
  it("returns null when there's no number", () => {
    expect(parseTempReply("hello")).toBeNull();
    expect(parseTempReply("")).toBeNull();
  });
});

// ---- The household round's live-keyboard guard (issue #1719) ----
//
// The round's confirm tokens carry each member's SEND-TIME date, and every previous
// round's keyboard stays live in the chat. A next-morning tap on yesterday's surviving
// round would log a dose confirmation to YESTERDAY — for someone else's medication, in
// the surface built for caregivers. Two independent guards, both pinned here.
describe("household round staleness (#1719)", () => {
  it("the round's guard is EXACT-DAY, and no longer the food nudge's", () => {
    // The round stayed exact-day when #4118 widened the food nudge to its message's
    // date ±2, and that divergence is the point of this assertion rather than an
    // oversight in it. A household round is a today-shaped tap on SOMEBODY ELSE's
    // medication — the surface built for caregivers — and #4118 explicitly left the
    // check-off family out of the backfill story. So the two guards now DISAGREE about
    // yesterday, deliberately, and this pins that they do.
    expect(tapDateGuard("2026-07-28", "2026-07-28").kind).toBe("current-day");
    expect(tapDateGuard("2026-07-27", "2026-07-28").kind).toBe("stale-date");
    expect(foodTapDateGuard("2026-07-27", "2026-07-28").kind).toBe(
      "recent-day"
    );
    // …and they still agree on both ends: the same day logs, a far-off day refuses.
    expect(foodTapDateGuard("2026-07-28", "2026-07-28").kind).toBe(
      "current-day"
    );
    expect(foodTapDateGuard("2026-07-20", "2026-07-28").kind).toBe(
      "stale-date"
    );
  });

  it("the refusal names the stale date and promises the next round", () => {
    const text = householdStaleDateAnswerText("2026-07-27");
    expect(text).toContain("2026-07-27");
    expect(text).toContain("Not logged");
    expect(text.toLowerCase()).toContain("today's round");
  });

  it("a round is identified by its hh: tokens, never by kind", () => {
    // The round shares kind:"dose" with the ordinary slot reminder (#1459), so kind
    // alone would strip a plain dose reminder's keyboard too.
    const round = {
      title: "💊 Household doses",
      body: "x",
      kind: "dose" as const,
      actions: [{ label: "✅ Ada · D3", data: "hh:1:7:100:50:2026-07-28" }],
    };
    const plainDose = {
      title: "💊 Morning",
      body: "x",
      kind: "dose" as const,
      actions: [{ label: "✅ D3", data: "take:1:100:50:2026-07-28" }],
    };
    expect(isHouseholdRoundMessage(round)).toBe(true);
    expect(isHouseholdRoundMessage(plainDose)).toBe(false);
    expect(
      householdRoundPointerFromMessage(round, "555", 42, "2026-07-28")
    ).toEqual({ chatId: "555", messageId: 42, date: "2026-07-28" });
    expect(
      householdRoundPointerFromMessage(plainDose, "555", 42, "2026-07-28")
    ).toBeNull();
  });

  it("the stored pointer round-trips, and a corrupt blob degrades to null", () => {
    const p = { chatId: 555, messageId: 42, date: "2026-07-28" };
    expect(
      parseHouseholdRoundPointer(serializeHouseholdRoundPointer(p))
    ).toEqual(p);
    expect(parseHouseholdRoundPointer("not json")).toBeNull();
    expect(parseHouseholdRoundPointer('{"chatId":555}')).toBeNull();
    expect(parseHouseholdRoundPointer(undefined)).toBeNull();
  });
});
