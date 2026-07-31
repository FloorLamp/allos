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
  parseTempReply,
  parseTempReplyMarker,
  tempReplyMarker,
} from "@/lib/notifications/callback-data";

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

describe("temperature reply flow parsers", () => {
  it("round-trips the profile marker through the prompt text", () => {
    const prompt = `Reply with the temperature. ${tempReplyMarker(12)}`;
    expect(parseTempReplyMarker(prompt)).toBe(12);
  });
  it("returns null when no marker is present", () => {
    expect(parseTempReplyMarker("just some text")).toBeNull();
    expect(parseTempReplyMarker(null)).toBeNull();
  });

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
  it("one date guard serves every live-keyboard surface", () => {
    // The food nudge (#947) and the round read the SAME pure decision, so they can't
    // drift on what "still today" means.
    expect(tapDateGuard("2026-07-28", "2026-07-28").kind).toBe("current-day");
    expect(tapDateGuard("2026-07-27", "2026-07-28").kind).toBe("stale-date");
    expect(foodTapDateGuard("2026-07-27", "2026-07-28")).toEqual(
      tapDateGuard("2026-07-27", "2026-07-28")
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
      actions: [{ label: "✓ Ada · D3", data: "hh:1:7:100:50:2026-07-28" }],
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
