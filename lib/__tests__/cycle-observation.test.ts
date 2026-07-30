import { describe, it, expect } from "vitest";
import {
  CYCLE_BLEEDING_PREFIX,
  CYCLE_OBSERVATION_WINDOW_DAYS,
  cycleBleedingSignalKey,
  decideProlongedBleeding,
  prolongedBleedingObservations,
} from "@/lib/cycle-observation";
import { PROLONGED_PERIOD_DAYS, type CyclePeriod } from "@/lib/cycle";
import { shiftDateStr } from "@/lib/date";

// Pure-tier: the prolonged-bleeding observation (#1682 fix b). The write path STORES a
// long period unrefused — the app must be able to record a genuine emergency — so this
// decides only whether to SAY something, calmly and once per period.

function period(
  id: number,
  start: string,
  end: string | null
): CyclePeriod {
  return { id, period_start: start, period_end: end, flow: null, note: null };
}

const TODAY = "2026-04-20";

describe("decideProlongedBleeding", () => {
  it("is silent for a typical period and fires at the threshold", () => {
    expect(PROLONGED_PERIOD_DAYS).toBe(8);
    // 7 inclusive days (04-10..04-16) — typical, silent.
    expect(
      decideProlongedBleeding(period(1, "2026-04-10", "2026-04-16"), TODAY)
    ).toBeNull();
    // 8 inclusive days — the first notable length.
    const obs = decideProlongedBleeding(
      period(1, "2026-04-09", "2026-04-16"),
      TODAY
    );
    expect(obs?.days).toBe(8);
    expect(obs?.title).toBe(
      "8 days of bleeding — worth discussing with a clinician"
    );
    expect(obs?.detail).toMatch(/not a diagnosis/);
  });

  it("says nothing about an OPEN period (it has no length yet)", () => {
    expect(
      decideProlongedBleeding(period(1, "2026-04-01", null), TODAY)
    ).toBeNull();
  });

  it("keys on the period start, so a dismissal is per-period", () => {
    const obs = decideProlongedBleeding(
      period(1, "2026-04-01", "2026-04-12"),
      TODAY
    );
    expect(obs?.dedupeKey).toBe(cycleBleedingSignalKey("2026-04-01"));
    expect(obs?.dedupeKey.startsWith(CYCLE_BLEEDING_PREFIX)).toBe(true);
  });

  it("stops observing once the period ages out of the window", () => {
    const insideEnd = shiftDateStr(TODAY, -CYCLE_OBSERVATION_WINDOW_DAYS);
    const inside = period(1, shiftDateStr(insideEnd, -9), insideEnd);
    expect(decideProlongedBleeding(inside, TODAY)).not.toBeNull();

    const outsideEnd = shiftDateStr(TODAY, -(CYCLE_OBSERVATION_WINDOW_DAYS + 1));
    const outside = period(2, shiftDateStr(outsideEnd, -9), outsideEnd);
    expect(decideProlongedBleeding(outside, TODAY)).toBeNull();
  });
});

describe("prolongedBleedingObservations", () => {
  it("returns one observation per qualifying period, newest first", () => {
    const rows = [
      period(1, "2026-02-01", "2026-02-05"), // 5 days — silent
      period(2, "2026-03-01", "2026-03-11"), // 11 days
      period(3, "2026-04-01", "2026-04-09"), // 9 days
    ];
    expect(
      prolongedBleedingObservations(rows, TODAY).map((o) => o.periodStart)
    ).toEqual(["2026-04-01", "2026-03-01"]);
  });
});
