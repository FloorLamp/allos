import { describe, expect, it } from "vitest";
import {
  DURATION_CANONICAL_UNIT,
  isColonDurationUnit,
  normalizeDurationValue,
  parseColonDuration,
} from "@/lib/duration-value";

// The colon-formatted-duration door (#2322). The application at each ingest door —
// CDA, FHIR, and the AI extraction adapter — is covered in cda.test.ts,
// fhir-resources.test.ts and import-shape.test.ts; the end-to-end store in the DB tier.

describe("isColonDurationUnit", () => {
  it("recognizes the unit spellings documents ship a clock-formatted duration under", () => {
    for (const u of [
      "min:sec",
      "MIN:SEC",
      "min: sec",
      "minutes:seconds",
      "mm:ss",
      "hh:mm:ss",
    ]) {
      expect(isColonDurationUnit(u), u).toBe(true);
    }
  });

  it("keys on the UNIT alone — a colon-ish value in another unit is untouched", () => {
    for (const u of [null, undefined, "", "mmHg", "s", "min", "bpm", "dB HL"]) {
      expect(isColonDurationUnit(u), String(u)).toBe(false);
    }
  });
});

describe("parseColonDuration", () => {
  it("reads M:SS and H:MM:SS by field count, in whole seconds", () => {
    expect(parseColonDuration("10:30")).toBe(630);
    expect(parseColonDuration("0:45")).toBe(45);
    expect(parseColonDuration("90:00")).toBe(5400); // a leading field may exceed 59
    expect(parseColonDuration("1:02:03")).toBe(3723);
    expect(parseColonDuration("630")).toBe(630);
  });

  it("rounds a fractional second rather than inventing milliseconds", () => {
    expect(parseColonDuration("10:30.4")).toBe(630);
    expect(parseColonDuration("10:30.6")).toBe(631);
  });

  it("refuses text that does not state a duration", () => {
    for (const raw of [
      "",
      "  ",
      "abc",
      "10:30:00:01",
      "120/80",
      "10:75",
      "-5",
    ]) {
      expect(parseColonDuration(raw), raw).toBeNull();
    }
  });
});

describe("normalizeDurationValue", () => {
  it("says nothing about a reading whose unit declares no duration", () => {
    expect(normalizeDurationValue("120", 120, "mmHg")).toEqual({
      kind: "not-a-duration",
    });
    // Even a colon-shaped value: only the unit can say it is a duration.
    expect(normalizeDurationValue("10:30", null, null)).toEqual({
      kind: "not-a-duration",
    });
  });

  it("narrows a min:sec reading to whole seconds", () => {
    expect(normalizeDurationValue("10:30", null, "min:sec")).toEqual({
      kind: "normalized",
      value: "630",
      value_num: 630,
      unit: DURATION_CANONICAL_UNIT,
    });
  });

  it("keeps the source exact — the digits round-trip, which minutes would not", () => {
    // 10:20 is 620 s exactly; as minutes it would be the repeating 10.3333….
    const out = normalizeDurationValue("10:20", null, "min:sec");
    expect(out).toMatchObject({ kind: "normalized", value_num: 620 });
    expect(620 % 60).toBe(20);
  });

  it("prefers the colon TEXT over a resolved number that disagrees with it", () => {
    // The AI door is the one place the two fields can disagree: a model reading a page
    // that prints "10:30" puts 10 in the numeric field and "10:30" in the text.
    // Trusting the number stores 600 s for a 630 s test — silently wrong, and
    // valid-looking afterwards. More grain wins.
    expect(normalizeDurationValue("10:30", 10, "min:sec")).toMatchObject({
      kind: "normalized",
      value_num: 630,
    });
    // …and a colon text the parse can't read is refused, never demoted to the
    // coarser number.
    expect(normalizeDurationValue("10:75", 10, "min:sec").kind).toBe(
      "unparsable"
    );
  });

  it("reads a colon-less value at the unit's LEADING field grain", () => {
    expect(normalizeDurationValue("10", null, "min:sec")).toMatchObject({
      value_num: 600,
    });
    expect(normalizeDurationValue(null, 10.5, "min:sec")).toMatchObject({
      value_num: 630,
    });
    expect(normalizeDurationValue("2", null, "hh:mm:ss")).toMatchObject({
      value_num: 7200,
    });
  });

  it("DROPS with a reason rather than storing a string that looks like a reading", () => {
    for (const raw of ["not recorded", "10:75", "--", ""]) {
      const out = normalizeDurationValue(raw, null, "min:sec");
      expect(out.kind, raw).toBe("unparsable");
      if (out.kind === "unparsable") expect(out.reason).toBeTruthy();
    }
    expect(normalizeDurationValue(null, null, "min:sec").kind).toBe(
      "unparsable"
    );
    expect(normalizeDurationValue(null, -3, "min:sec").kind).toBe("unparsable");
  });
});
