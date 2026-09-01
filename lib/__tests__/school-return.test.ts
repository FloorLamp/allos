import { describe, expect, it } from "vitest";
import {
  computeSchoolReturn,
  formatSchoolReturnLine,
  schoolReturnCompactClause,
} from "@/lib/school-return";

// Pure tests for the school-return "fever-free 24h without meds" countdown (issue #859
// item 2). Boundary cases: a fresh fever reading resets the clock; an antipyretic within
// the window governs (resets) the clock and annotates. No DB, no network.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // fixed "now"

describe("computeSchoolReturn", () => {
  it("counts fever-free hours from the last fever reading when no antipyretic", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 18 * HOUR,
      lastFeverDegF: 99.1,
      lastAntipyreticAtMs: null,
      lastAntipyreticName: null,
      lastAntipyreticClockLabel: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.feverFreeHours).toBe(18);
    expect(s.hoursSinceAntipyretic).toBeNull();
    expect(s.clearedForHours).toBe(18);
    expect(s.met).toBe(false);
  });

  it("meets the threshold once the cleared clock reaches it", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 25 * HOUR,
      lastFeverDegF: 100.9,
      lastAntipyreticAtMs: null,
      lastAntipyreticName: null,
      lastAntipyreticClockLabel: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.clearedForHours).toBe(25);
    expect(s.met).toBe(true);
  });

  it("a more-recent antipyretic RESETS the cleared clock (masks fever)", () => {
    // Fever 30h ago, but ibuprofen only 6h ago — the cleared clock runs from the med.
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 30 * HOUR,
      lastFeverDegF: 102.2,
      lastAntipyreticAtMs: NOW - 6 * HOUR,
      lastAntipyreticName: "Ibuprofen",
      lastAntipyreticClockLabel: "6:00am",
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.feverFreeHours).toBe(30);
    expect(s.hoursSinceAntipyretic).toBe(6);
    expect(s.clearedForHours).toBe(6); // governed by the later event
    expect(s.met).toBe(false);
  });

  it("an OLD antipyretic doesn't shorten a longer fever-free clock", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 26 * HOUR,
      lastFeverDegF: 101,
      lastAntipyreticAtMs: NOW - 40 * HOUR,
      lastAntipyreticName: "Acetaminophen",
      lastAntipyreticClockLabel: "8:00pm",
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.clearedForHours).toBe(26); // fever reading is the later event
    expect(s.met).toBe(true);
  });

  it("never goes negative on a clock-skewed future reading", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW + 3 * HOUR,
      lastFeverDegF: 100.4,
      lastAntipyreticAtMs: null,
      lastAntipyreticName: null,
      lastAntipyreticClockLabel: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.feverFreeHours).toBe(0);
    expect(s.clearedForHours).toBe(0);
  });
});

describe("formatSchoolReturnLine / schoolReturnCompactClause", () => {
  const status = computeSchoolReturn({
    lastFeverAtMs: NOW - 18 * HOUR,
    lastFeverDegF: 99.1,
    lastAntipyreticAtMs: NOW - 20 * HOUR,
    lastAntipyreticName: "Ibuprofen",
    lastAntipyreticClockLabel: "6:00pm",
    nowMs: NOW,
    thresholdHours: 24,
  });

  it("renders the fever-free line with the reading and the last reducer, cited", () => {
    const line = formatSchoolReturnLine(status, "F");
    expect(line).toContain("Fever-free 18h");
    expect(line).toContain("last reading 99.1");
    expect(line).toContain("last ibuprofen 6:00pm");
    expect(line).toContain("24h");
    expect(line).not.toMatch(/not medical advice/i);
  });

  it("renders the temperature in the viewer's unit", () => {
    const c = formatSchoolReturnLine(status, "C");
    expect(c).toContain("°C");
  });

  it("compact clause uses the cleared clock over the threshold", () => {
    expect(schoolReturnCompactClause(status)).toBe("fever-free 18h/24h");
  });
});

// ── The clock requires EVIDENCE (#4685) ───────────────────────────────────────
//
// Owner-reported: "LAST TEMPERATURE 103.4 °F Yesterday, 7:10 PM" directly above
// "FEVER STATUS: Fever-free 13h/24h", with nothing logged since. Elapsed wall time is
// not a measurement, so a clock that counts it cannot tell "measured normal for 13h"
// apart from "nobody measured for 13h" — and at the threshold it declared the
// return-to-school convention met on silence.
describe("no fever-free claim without a normal reading after the fever (#4685)", () => {
  const silent = (hoursSinceFever: number, antipyreticHoursAgo?: number) =>
    computeSchoolReturn({
      lastFeverAtMs: NOW - hoursSinceFever * HOUR,
      lastFeverDegF: 103.4,
      firstNormalAfterFeverAtMs: null,
      lastAntipyreticAtMs:
        antipyreticHoursAgo != null ? NOW - antipyreticHoursAgo * HOUR : null,
      lastAntipyreticName: antipyreticHoursAgo != null ? "Ibuprofen" : null,
      lastAntipyreticClockLabel: antipyreticHoursAgo != null ? "7:10pm" : null,
      nowMs: NOW,
      thresholdHours: 24,
    });

  it("renders the honest state instead of a countdown, and cannot meet the threshold", () => {
    const s = silent(14);
    expect(s.evidence).toBe("none");
    expect(s.hoursSinceFever).toBe(14);
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toBe("no reading since 103.4 °F (14h ago)");
    expect(formatSchoolReturnLine(s, "F")).toContain(
      "No reading since 103.4 °F (14h ago)"
    );
    expect(formatSchoolReturnLine(s, "F")).not.toContain("Fever-free");
  });

  it("silence past the threshold still cannot flip met", () => {
    // The pre-#4685 clock read 30h ≥ 24h and reported the convention satisfied.
    const s = silent(30);
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).not.toContain("fever-free");
  });

  it("a normal reading after the fever starts the clock; the antipyretic still governs", () => {
    // Fever 30h ago, a normal reading 26h ago, ibuprofen 6h ago — the reducer is
    // still the later event, exactly as before.
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 30 * HOUR,
      lastFeverDegF: 102.2,
      firstNormalAfterFeverAtMs: NOW - 26 * HOUR,
      lastAntipyreticAtMs: NOW - 6 * HOUR,
      lastAntipyreticName: "Ibuprofen",
      lastAntipyreticClockLabel: "6:00am",
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.evidence).toBe("measured");
    expect(s.clearedForHours).toBe(6);
    expect(s.met).toBe(false);
  });

  it("the clock counts from the normal reading, not from the fever it followed", () => {
    // 30h since the fever but the first normal reading is only 20h old: the
    // pre-#4685 clock said 30h and met; the measured one says 20h and not yet.
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 30 * HOUR,
      lastFeverDegF: 101,
      firstNormalAfterFeverAtMs: NOW - 20 * HOUR,
      lastAntipyreticAtMs: null,
      lastAntipyreticName: null,
      lastAntipyreticClockLabel: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.clearedForHours).toBe(20);
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toBe("fever-free 20h/24h");
  });
});
