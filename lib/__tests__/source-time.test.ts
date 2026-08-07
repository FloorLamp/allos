import { describe, expect, it } from "vitest";
import {
  fhirSourceTime,
  hl7SourceTime,
  sourceDay,
  sourceInstant,
  type SourceTime,
} from "../source-time";
import { effTime, hl7Period, hl7Time } from "../cda/normalize";
import { fhirTime } from "../fhir/common";

// The ingest boundary for time (#2243 / #2205 phase 0). These pin the three arms, the
// day/instant disagreement that decision 2 protects, and decision 3's refusal to turn
// a zoneless clinical clock into an instant.

describe("hl7SourceTime — HL7 v3 TS at its own grain", () => {
  it("a time AND an offset is a real instant", () => {
    expect(hl7SourceTime("20260807143000-0500")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T19:30:00Z",
    });
  });

  it("a time with NO offset is a local wall clock", () => {
    expect(hl7SourceTime("20260807143000")).toEqual({
      grain: "local",
      date: "2026-08-07",
      hhmm: "14:30",
    });
  });

  it("a bare day is a day", () => {
    expect(hl7SourceTime("20260807")).toEqual({
      grain: "day",
      date: "2026-08-07",
    });
  });

  it("accepts the shorter precisions the grammar permits", () => {
    // Minutes only, with an offset.
    expect(hl7SourceTime("202608071430+0000")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T14:30:00Z",
    });
    // Hours only.
    expect(hl7SourceTime("2026080714+0100")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T13:00:00Z",
    });
    // Fractional seconds are precision the app does not store, not a different grain.
    expect(hl7SourceTime("20260807143000.250+0000")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T14:30:00Z",
    });
  });

  it("an offset with no time states no moment — it stays a day", () => {
    expect(hl7SourceTime("20260807-0500")).toEqual({
      grain: "day",
      date: "2026-08-07",
    });
  });

  it("drops a partial or unreal date, as every call site always has", () => {
    expect(hl7SourceTime("2026")).toBeNull();
    expect(hl7SourceTime("202608")).toBeNull();
    expect(hl7SourceTime("20260231")).toBeNull(); // February 31st
    expect(hl7SourceTime("")).toBeNull();
    expect(hl7SourceTime(null)).toBeNull();
    expect(hl7SourceTime(undefined)).toBeNull();
    expect(hl7SourceTime("nullFlavor")).toBeNull();
  });

  it("degrades an out-of-range clock to the day the source also stated", () => {
    // Never repair a stated time into a different moment: 99 is not an hour.
    expect(hl7SourceTime("2026080799")).toEqual({
      grain: "day",
      date: "2026-08-07",
    });
  });

  it("an unusable offset makes the value LOCAL, never UTC", () => {
    // A bogus zone must not silently become +0000 — that would invent an instant.
    expect(hl7SourceTime("20260807143000+9900")).toEqual({
      grain: "local",
      date: "2026-08-07",
      hhmm: "14:30",
    });
  });
});

describe("fhirSourceTime — FHIR date / dateTime / instant at its own grain", () => {
  it("a time AND an offset is a real instant", () => {
    expect(fhirSourceTime("2026-08-07T14:30:00-05:00")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T19:30:00Z",
    });
    expect(fhirSourceTime("2026-08-07T14:30:00Z")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T14:30:00Z",
    });
    expect(fhirSourceTime("2026-08-07T14:30:00.123Z")).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T14:30:00Z",
    });
  });

  it("a time with NO offset is a local wall clock", () => {
    expect(fhirSourceTime("2026-08-07T14:30:00")).toEqual({
      grain: "local",
      date: "2026-08-07",
      hhmm: "14:30",
    });
  });

  it("a bare day is a day", () => {
    expect(fhirSourceTime("2026-08-07")).toEqual({
      grain: "day",
      date: "2026-08-07",
    });
  });

  it("drops a FHIR partial, as every call site always has", () => {
    expect(fhirSourceTime("2021")).toBeNull();
    expect(fhirSourceTime("2021-01")).toBeNull();
    expect(fhirSourceTime("2021-02-30")).toBeNull();
    expect(fhirSourceTime(42)).toBeNull();
    expect(fhirSourceTime(undefined)).toBeNull();
  });
});

// ── The day-attribution pin (#2243 decision 2, #94, #2205 constraint 4) ──────
//
// This is the test that fails if a later contributor "unifies" the day and the instant
// by deriving one from the other. They legitimately disagree, and each destination
// takes the one it declares.
describe("the stated day and the instant disagree, and both are right", () => {
  const t = hl7SourceTime("20260101003000+0900");

  it("the day is the one the DOCUMENT stated, never the UTC day", () => {
    expect(t).toEqual({
      grain: "instant",
      date: "2026-01-01",
      instant: "2025-12-31T15:30:00Z",
    });
    // Spelled out: the instant's own UTC day is the PREVIOUS one. A day-grained
    // destination must not take it.
    expect(t!.grain === "instant" && t!.instant.slice(0, 10)).toBe(
      "2025-12-31"
    );
  });

  it("a day destination takes sourceDay; an instant destination takes sourceInstant", () => {
    expect(sourceDay(t)).toBe("2026-01-01");
    expect(sourceInstant(t)).toBe("2025-12-31T15:30:00Z");
  });

  it("holds identically on the FHIR spelling", () => {
    const f = fhirSourceTime("2026-01-01T00:30:00+09:00");
    expect(sourceDay(f)).toBe("2026-01-01");
    expect(sourceInstant(f)).toBe("2025-12-31T15:30:00Z");
  });

  it("holds in the other direction too (a late local evening west of UTC)", () => {
    const w = hl7SourceTime("20251231233000-0500");
    expect(sourceDay(w)).toBe("2025-12-31");
    expect(sourceInstant(w)).toBe("2026-01-01T04:30:00Z");
  });
});

// ── Decision 3: a `local` source leaves an instant destination NULL ──────────
describe("a zoneless clinical clock never becomes an instant", () => {
  const cases: (SourceTime | null)[] = [
    hl7SourceTime("20260807143000"),
    fhirSourceTime("2026-08-07T14:30:00"),
  ];

  it("keeps the day and refuses the instant", () => {
    for (const t of cases) {
      expect(t?.grain).toBe("local");
      expect(sourceDay(t)).toBe("2026-08-07");
      // The profile's timezone is NOT consulted — there is nothing here to consult it
      // with, and that is the point.
      expect(sourceInstant(t)).toBeNull();
    }
  });

  it("a day-only source has no instant either", () => {
    expect(sourceInstant(hl7SourceTime("20260807"))).toBeNull();
    expect(sourceInstant(fhirSourceTime("2026-08-07"))).toBeNull();
  });

  it("the readers are null-safe at the boundary", () => {
    expect(sourceDay(null)).toBeNull();
    expect(sourceInstant(null)).toBeNull();
    expect(sourceDay(undefined)).toBeNull();
    expect(sourceInstant(undefined)).toBeNull();
  });
});

// ── The parser entry points the extractors actually call ────────────────────
describe("the CDA and FHIR entry points carry the grain through", () => {
  it("effTime reads an interval's low and a bare @_value alike", () => {
    expect(effTime({ "@_value": "20260807143000-0500" })).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T19:30:00Z",
    });
    expect(effTime({ low: { "@_value": "20260807143000-0500" } })).toEqual({
      grain: "instant",
      date: "2026-08-07",
      instant: "2026-08-07T19:30:00Z",
    });
    // The medications shape: an IVL_TS period plus a PIVL_TS frequency element.
    expect(
      effTime([{ period: { "@_value": "12" } }, { "@_value": "20260807" }])
    ).toEqual({ grain: "day", date: "2026-08-07" });
    expect(effTime(undefined)).toBeNull();
  });

  it("hl7Time and hl7Period preserve both ends", () => {
    expect(hl7Time("20260807143000-0500")?.grain).toBe("instant");
    const p = hl7Period({
      low: { "@_value": "20260801080000-0500" },
      high: { "@_value": "20260807" },
    });
    expect(sourceInstant(p.start)).toBe("2026-08-01T13:00:00Z");
    expect(sourceDay(p.start)).toBe("2026-08-01");
    expect(p.end).toEqual({ grain: "day", date: "2026-08-07" });
  });

  it("fhirTime preserves the offset the FHIR `instant` type guarantees", () => {
    expect(sourceInstant(fhirTime("2026-08-01T14:30:00-05:00"))).toBe(
      "2026-08-01T19:30:00Z"
    );
    expect(sourceDay(fhirTime("2026-08-01T14:30:00-05:00"))).toBe("2026-08-01");
  });
});
