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
    expect(line).toMatch(/not medical advice/i);
  });

  it("renders the temperature in the viewer's unit", () => {
    const c = formatSchoolReturnLine(status, "C");
    expect(c).toContain("°C");
  });

  it("compact clause uses the cleared clock over the threshold", () => {
    expect(schoolReturnCompactClause(status)).toBe("fever-free 18h/24h");
  });
});
