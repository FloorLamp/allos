import { describe, expect, it } from "vitest";
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
