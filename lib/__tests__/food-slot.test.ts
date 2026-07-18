import { describe, it, expect } from "vitest";
import {
  foodSlotBoundaries,
  deriveFoodSlot,
  foodSlotForHhmm,
  DEFAULT_MIDDAY_BOUNDARY_MIN,
  DEFAULT_EVENING_BOUNDARY_MIN,
} from "@/lib/food-slot";
import { zonedDateParts } from "@/lib/date";

// Pure slot derivation for the food-log ledger (issue #950): a tap's local minute-of-
// day maps to Morning / Midday / Evening, with bucket boundaries anchored to the
// profile's configured notify slot hours (midpoints) and a fixed 11:00/15:00 fallback
// when unconfigured. Evening is terminal (runs to midnight — no bedtime cut).

describe("foodSlotBoundaries", () => {
  it("falls back to the fixed 11:00/15:00 splits when unconfigured (all null)", () => {
    const b = foodSlotBoundaries({ morning: null, midday: null, evening: null });
    expect(b).toEqual({
      midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
      evening: DEFAULT_EVENING_BOUNDARY_MIN,
    });
    // Those defaults reproduce currentTimeBucket's <11:00 / <15:00 splits.
    expect(b.midday).toBe(11 * 60);
    expect(b.evening).toBe(15 * 60);
  });

  it("falls back when only partially configured", () => {
    // Morning set but no midday/evening → can't midpoint, use the fixed defaults.
    expect(foodSlotBoundaries({ morning: 8, midday: null, evening: null })).toEqual({
      midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
      evening: DEFAULT_EVENING_BOUNDARY_MIN,
    });
  });

  it("anchors boundaries to the midpoints of a fully configured schedule", () => {
    // 8 / 13 / 20 → midpoints 10:30 and 16:30.
    const b = foodSlotBoundaries({ morning: 8, midday: 13, evening: 20 });
    expect(b).toEqual({ midday: 10 * 60 + 30, evening: 16 * 60 + 30 });
  });

  it("re-anchors a coherently SHIFTED schedule so a late morning stays morning", () => {
    // A night-owl schedule: morning 14, midday 18, evening 23 → midpoints 16:00, 20:30.
    const b = foodSlotBoundaries({ morning: 14, midday: 18, evening: 23 });
    expect(b).toEqual({ midday: 16 * 60, evening: 20 * 60 + 30 });
    // 14:00 (the configured morning hour) still reads Morning under the shifted buckets.
    expect(deriveFoodSlot(14 * 60, b)).toBe("Morning");
  });

  it("guards a degenerate (non-monotonic) schedule by falling back", () => {
    // midday earlier than morning would invert the buckets — refuse it.
    const b = foodSlotBoundaries({ morning: 18, midday: 8, evening: 20 });
    expect(b).toEqual({
      midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
      evening: DEFAULT_EVENING_BOUNDARY_MIN,
    });
  });
});

describe("deriveFoodSlot", () => {
  const b = { midday: 11 * 60, evening: 15 * 60 };
  it("maps minutes to the three windows, Evening terminal to midnight", () => {
    expect(deriveFoodSlot(0, b)).toBe("Morning"); // 00:00
    expect(deriveFoodSlot(10 * 60 + 59, b)).toBe("Morning"); // 10:59
    expect(deriveFoodSlot(11 * 60, b)).toBe("Midday"); // 11:00 exactly
    expect(deriveFoodSlot(14 * 60 + 59, b)).toBe("Midday"); // 14:59
    expect(deriveFoodSlot(15 * 60, b)).toBe("Evening"); // 15:00 exactly
    expect(deriveFoodSlot(21 * 60, b)).toBe("Evening"); // 21:00 — NOT a bedtime cut
    expect(deriveFoodSlot(23 * 60 + 59, b)).toBe("Evening"); // 23:59
  });
});

describe("timezone boundaries (23:59 / 00:01) via zonedDateParts", () => {
  const b = { midday: 11 * 60, evening: 15 * 60 };

  it("derives from the LOCAL wall clock, not UTC (a UTC-evening tap is local morning)", () => {
    // 2026-07-01T06:30:00Z is 02:30 in New York (EDT, UTC-4) → local Morning, even
    // though the UTC hour (06:30) would also be morning here; pick a case that differs:
    // 15:30Z is 11:30 in New York → Midday locally, but Evening if read as UTC.
    const nySlot = foodSlotForHhmmInZone("2026-07-01T15:30:00Z", "America/New_York", b);
    expect(nySlot).toBe("Midday");
    const utcSlot = foodSlotForHhmmInZone("2026-07-01T15:30:00Z", "UTC", b);
    expect(utcSlot).toBe("Evening");
  });

  it("a 23:59 local tap is Evening; a 00:01 local tap the next day is Morning", () => {
    // Tokyo (UTC+9). 2026-07-01T14:59:00Z = 23:59 JST → Evening.
    expect(foodSlotForHhmmInZone("2026-07-01T14:59:00Z", "Asia/Tokyo", b)).toBe("Evening");
    // 2026-07-01T15:01:00Z = 00:01 JST (next day) → Morning.
    expect(foodSlotForHhmmInZone("2026-07-01T15:01:00Z", "Asia/Tokyo", b)).toBe("Morning");
  });

  it("handles a DST transition (US spring-forward day) without shifting the bucket", () => {
    // 2026-03-08 is US DST start. 2026-03-08T16:00:00Z = 12:00 EDT (UTC-4) → Midday.
    expect(foodSlotForHhmmInZone("2026-03-08T16:00:00Z", "America/New_York", b)).toBe("Midday");
    // The day before (still EST, UTC-5): 2026-03-07T16:00:00Z = 11:00 EST → Midday too,
    // but 2026-03-07T15:30:00Z = 10:30 EST → Morning (proves the offset is applied).
    expect(foodSlotForHhmmInZone("2026-03-07T15:30:00Z", "America/New_York", b)).toBe("Morning");
  });
});

// Helper mirroring the query-layer read path: ISO instant → local hhmm → slot.
function foodSlotForHhmmInZone(
  iso: string,
  tz: string,
  b: { midday: number; evening: number }
) {
  const { hhmm } = zonedDateParts(tz, new Date(iso));
  return foodSlotForHhmm(hhmm, b);
}
