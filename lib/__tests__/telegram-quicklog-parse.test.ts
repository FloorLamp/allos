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
  resolveTypedReply,
  typedReplyNumber,
  type OpenTypedPrompt,
  type TypedPromptRegistry,
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

// ---- The one typed-reply contract (issue #5650), POINTER-ONLY ----
//
// The marker grammar these tests used to pin is GONE (owner ruling, 2026-09-16), and the
// tests that pinned it went with it — there is no `parseTypedReplyMarker` to call and no
// string a prompt carries for it to read. A typed reply resolves against the bot's own
// record of the quoted message and nothing else, so what is pinned here is that the
// resolver takes NO TEXT from the quoted message at all: its input carries an id.

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
  const receipt: OpenTypedPrompt = {
    family: "refill",
    profileId: 7,
    operationId: 12,
    promptId: 500,
  };
  const tempPrompt: OpenTypedPrompt = {
    family: "temp",
    profileId: 7,
    operationId: null,
    promptId: 501,
  };

  // A registry that answers from a fixed set, and COUNTS its reads — both selectors are
  // DB work in production and ordinary chat must not pay for either.
  function registry(prompts: readonly OpenTypedPrompt[]) {
    const reads = { at: 0, open: 0 };
    const r: TypedPromptRegistry = {
      at: (id) => {
        reads.at++;
        return prompts.find((p) => p.promptId === id) ?? null;
      },
      open: () => {
        reads.open++;
        return prompts;
      },
    };
    return { registry: r, reads };
  }

  it("resolves an explicit reply from the RECORD at the quoted id, open prompts unread", () => {
    const { registry: r, reads } = registry([receipt]);
    expect(resolveTypedReply({ text: "120", replyToId: 500 }, r)).toEqual({
      kind: "reply",
      reply: { ...receipt, text: "120" },
    });
    // The uniqueness selector is for BARE numbers; a Reply names its own message.
    expect(reads.open).toBe(0);
  });

  it("takes the family and the attribution from the record, never from the reply", () => {
    // The same quoted id, the same typed text, two different records: everything about
    // WHICH prompt this answers comes from the store. There is no other input that could
    // carry it — which is the property pointer-only exists for.
    const { registry: asTemp } = registry([{ ...tempPrompt, promptId: 500 }]);
    expect(resolveTypedReply({ text: "38.5", replyToId: 500 }, asTemp)).toEqual(
      {
        kind: "reply",
        reply: { ...tempPrompt, promptId: 500, text: "38.5" },
      }
    );
    const { registry: asRefill } = registry([receipt]);
    expect(
      resolveTypedReply({ text: "38.5", replyToId: 500 }, asRefill)
    ).toEqual({ kind: "reply", reply: { ...receipt, text: "38.5" } });
  });

  it("refuses a number replied to a message the store has no prompt for", () => {
    // THE ACCEPTED COST OF POINTER-ONLY. A prompt sent before pointers were recorded, one
    // pruned at retention, one already answered, or a message that was never a prompt:
    // all four are the same thing here — no record — and none of them may be resolved by
    // guessing at the chat's other open prompts.
    const { registry: r, reads } = registry([receipt]);
    expect(resolveTypedReply({ text: "38.5", replyToId: 9 }, r)).toEqual({
      kind: "unrecorded",
    });
    expect(reads.open).toBe(0);
  });

  it("leaves a non-numeric reply to an unrecorded message as ordinary chat", () => {
    const { registry: r } = registry([receipt]);
    expect(resolveTypedReply({ text: "thanks!", replyToId: 9 }, r)).toEqual({
      kind: "none",
    });
  });

  it("resolves a bare number to the sender's single open prompt", () => {
    const { registry: r, reads } = registry([receipt]);
    expect(resolveTypedReply({ text: "120" }, r)).toEqual({
      kind: "reply",
      reply: { ...receipt, text: "120" },
    });
    // No quoted id, so the by-id selector is never asked.
    expect(reads.at).toBe(0);
  });

  it("refuses to choose, and leaves everything else to the rest of the chain", () => {
    const both = registry([receipt, tempPrompt]).registry;
    expect(resolveTypedReply({ text: "120" }, both)).toEqual({
      kind: "ambiguous",
    });
    // No open prompt, and not a number.
    expect(resolveTypedReply({ text: "120" }, registry([]).registry)).toEqual({
      kind: "none",
    });
    expect(
      resolveTypedReply({ text: "abc" }, registry([receipt]).registry)
    ).toEqual({ kind: "none" });
  });

  it("never reads the open set on a lookup path, and never guesses across them", () => {
    // A live temp prompt in the chat and a Reply to a DIFFERENT, unrecorded message:
    // resolving that to the temp prompt would be the guess this branch refuses, and is
    // how a reply aimed at yesterday's question would land on today's.
    const { registry: r } = registry([tempPrompt]);
    expect(resolveTypedReply({ text: "38.5", replyToId: 777 }, r)).toEqual({
      kind: "unrecorded",
    });
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
