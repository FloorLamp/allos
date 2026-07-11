import { describe, it, expect } from "vitest";
import { shiftDateStr } from "@/lib/date";
import type { AdherenceDot, AdherenceState } from "@/lib/supplement-adherence";
import {
  detectWeekdayMissPattern,
  detectWeekendAsymmetry,
  detectDoseAdherencePatterns,
  detectAdherencePatterns,
  weekdayIndex,
  weekdayMissSignalKey,
  weekendAsymmetrySignalKey,
  ADHERENCE_PREFIX,
  type DoseAdherenceInput,
} from "@/lib/adherence-patterns";

// A fixed anchor so weekday math is deterministic regardless of when the suite runs.
const ANCHOR = "2025-02-28";
const FRIDAY = 5;

// Build a `days`-long strip ending at ANCHOR (oldest-first), assigning each day's
// state from (date, weekday). A window of exactly 7·k days holds exactly k of each
// weekday, which is what the occurrence-gate tests rely on.
function strip(
  days: number,
  stateFor: (date: string, weekday: number) => AdherenceState
): AdherenceDot[] {
  const out: AdherenceDot[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateStr(ANCHOR, -i);
    out.push({ date, state: stateFor(date, weekdayIndex(date)) });
  }
  return out;
}

function input(
  strip: AdherenceDot[],
  over: Partial<DoseAdherenceInput> = {}
): DoseAdherenceInput {
  return {
    doseId: 42,
    supplementName: "Magnesium",
    bucket: "Evening",
    strip,
    ...over,
  };
}

describe("weekdayIndex", () => {
  it("is UTC and 0=Sunday..6=Saturday", () => {
    expect(weekdayIndex("2025-02-28")).toBe(FRIDAY); // a Friday
    expect(weekdayIndex("2025-03-02")).toBe(0); // a Sunday
    expect(weekdayIndex("not-a-date")).toBe(-1);
  });
});

describe("detectWeekdayMissPattern", () => {
  const fridaysMissed = (_d: string, wd: number): AdherenceState =>
    wd === FRIDAY ? "missed" : "taken";

  it("flags the standout weekday when it dominates the misses", () => {
    // 28 days = exactly 4 Fridays, all missed; every other day taken.
    const p = detectWeekdayMissPattern(input(strip(28, fridaysMissed)));
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("weekday");
    expect(p!.key).toBe(weekdayMissSignalKey(42, FRIDAY));
    expect(p!.detail).toContain("Friday");
    expect(p!.detail).toContain("4 of the last 4");
    // Evening slot → suggest moving it earlier.
    expect(p!.detail).toMatch(/morning/i);
  });

  it("suggests a reminder (not a move) for a morning slot", () => {
    const p = detectWeekdayMissPattern(
      input(strip(28, fridaysMissed), { bucket: "Morning" })
    );
    expect(p!.detail).toMatch(/reminder/i);
    expect(p!.detail).not.toMatch(/moving it earlier/i);
  });

  it("does not fire below the minimum applicable days", () => {
    // 13 applicable days < MIN_APPLICABLE_DAYS (14).
    expect(
      detectWeekdayMissPattern(input(strip(13, fridaysMissed)))
    ).toBeNull();
  });

  it("does not fire when the weekday recurs too few times", () => {
    // 21 days = exactly 3 Fridays (< MIN_WEEKDAY_OCCURRENCES 4), even though all
    // three are missed. 21 applicable days clears the min-applicable gate.
    expect(
      detectWeekdayMissPattern(input(strip(21, fridaysMissed)))
    ).toBeNull();
  });

  it("does not single out a day when every day misses about equally", () => {
    // ~80% missed spread evenly across the calendar (every 5th day taken) → no
    // weekday's rate is ≥2× the others, so the ratio gate rejects them all.
    let n = 0;
    const uniform = strip(28, () => (n++ % 5 === 0 ? "taken" : "missed"));
    expect(detectWeekdayMissPattern(input(uniform))).toBeNull();
  });

  it("treats skipped days as transparent (a skip is not a miss)", () => {
    // Fridays deliberately skipped, not missed → no weekday pattern.
    const skips = strip(28, (_d, wd) => (wd === FRIDAY ? "skipped" : "taken"));
    expect(detectWeekdayMissPattern(input(skips))).toBeNull();
  });
});

describe("detectWeekendAsymmetry", () => {
  it("flags a weekend-vs-weekday miss asymmetry", () => {
    // 28 days: weekends (Sat/Sun) missed, weekdays taken. weOcc=8, wdOcc=20.
    const s = strip(28, (_d, wd) =>
      wd === 0 || wd === 6 ? "missed" : "taken"
    );
    const p = detectWeekendAsymmetry(input(s));
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("weekend");
    expect(p!.key).toBe(weekendAsymmetrySignalKey(42));
    expect(p!.detail).toContain("100% of weekend days");
    expect(p!.detail).toContain("0% on weekdays");
  });

  it("does not fire when weekends and weekdays are comparable", () => {
    // ~33% missed spread evenly (every 3rd calendar day) → weekend rate stays below
    // the WEEKEND_MISS_RATE floor and near the weekday rate.
    let n = 0;
    const s = strip(28, () => (n++ % 3 === 0 ? "missed" : "taken"));
    expect(detectWeekendAsymmetry(input(s))).toBeNull();
  });

  it("needs enough of each side", () => {
    // Weekends not due (na) → weOcc=0 < WEEKEND_MIN_EACH.
    const s = strip(28, (_d, wd) => (wd === 0 || wd === 6 ? "na" : "taken"));
    expect(detectWeekendAsymmetry(input(s))).toBeNull();
  });
});

describe("detectDoseAdherencePatterns", () => {
  it("prefers the sharper weekday signal over the weekend one", () => {
    // Fridays missed → both a weekday standout AND (Fri is a weekday) — the weekday
    // detector wins and only one finding is returned.
    const s = strip(28, (_d, wd) => (wd === FRIDAY ? "missed" : "taken"));
    const out = detectDoseAdherencePatterns(input(s));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("weekday");
  });

  it("returns nothing for a well-adhered dose", () => {
    expect(
      detectDoseAdherencePatterns(input(strip(28, () => "taken")))
    ).toEqual([]);
  });
});

describe("detectAdherencePatterns", () => {
  it("collects and sorts across doses by name then dose id", () => {
    const fridays = (name: string, id: number, over = {}): DoseAdherenceInput =>
      input(
        strip(28, (_d, wd) => (wd === FRIDAY ? "missed" : "taken")),
        {
          supplementName: name,
          doseId: id,
          ...over,
        }
      );
    const out = detectAdherencePatterns([
      fridays("Zinc", 9),
      fridays("Iron", 3),
    ]);
    expect(out.map((p) => p.title[0])).toEqual(["I", "Z"]); // Iron before Zinc
    // Every key is in the adherence namespace (so the dismiss action can guard it).
    expect(out.every((p) => p.key.startsWith(ADHERENCE_PREFIX))).toBe(true);
  });
});
