import { describe, expect, it } from "vitest";
import {
  computeSchoolReturn,
  formatSchoolReturnLine,
  schoolReturnCompactClause,
  schoolReturnCompactLabel,
} from "@/lib/school-return";

// Pure tests for the school-return "fever-free 24h without meds" countdown (issue #859
// item 2). Boundary cases: a fresh fever reading resets the clock; an antipyretic within
// the window governs (resets) the clock and annotates. No DB, no network.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // fixed "now"

describe("computeSchoolReturn", () => {
  it("counts fever-free hours from the measured normal reading when no antipyretic", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 18 * HOUR,
      lastFeverDegF: 99.1,
      firstNormalAfterFeverAtMs: NOW - 18 * HOUR,
      lastAntipyretic: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.hoursSinceFever).toBe(18);
    expect(s.hoursSinceAntipyretic).toBeNull();
    expect(s.clearedForHours).toBe(18);
    expect(s.met).toBe(false);
  });

  it("meets the threshold once the cleared clock reaches it", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 25 * HOUR,
      lastFeverDegF: 100.9,
      firstNormalAfterFeverAtMs: NOW - 25 * HOUR,
      lastAntipyretic: null,
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
      firstNormalAfterFeverAtMs: NOW - 30 * HOUR,
      lastAntipyretic: {
        timeStated: true,
        atMs: NOW - 6 * HOUR,
        name: "Ibuprofen",
        clockLabel: "6:00am",
      },
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.hoursSinceFever).toBe(30);
    expect(s.hoursSinceAntipyretic).toBe(6);
    expect(s.clearedForHours).toBe(6); // governed by the later event
    expect(s.met).toBe(false);
  });

  it("an OLD antipyretic doesn't shorten a longer fever-free clock", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW - 26 * HOUR,
      lastFeverDegF: 101,
      firstNormalAfterFeverAtMs: NOW - 26 * HOUR,
      lastAntipyretic: {
        timeStated: true,
        atMs: NOW - 40 * HOUR,
        name: "Acetaminophen",
        clockLabel: "8:00pm",
      },
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.clearedForHours).toBe(26); // the normal reading is the later event
    expect(s.met).toBe(true);
  });

  it("never goes negative on a clock-skewed future reading", () => {
    const s = computeSchoolReturn({
      lastFeverAtMs: NOW + 3 * HOUR,
      lastFeverDegF: 100.4,
      firstNormalAfterFeverAtMs: NOW + 4 * HOUR,
      lastAntipyretic: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.hoursSinceFever).toBe(0);
    expect(s.clearedForHours).toBe(0);
  });
});

describe("formatSchoolReturnLine / schoolReturnCompactClause", () => {
  const status = computeSchoolReturn({
    lastFeverAtMs: NOW - 18 * HOUR,
    lastFeverDegF: 99.1,
    firstNormalAfterFeverAtMs: NOW - 18 * HOUR,
    lastAntipyretic: {
      timeStated: true,
      atMs: NOW - 20 * HOUR,
      name: "Ibuprofen",
      clockLabel: "6:00pm",
    },
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
    expect(schoolReturnCompactClause(status)).toBe("fever-free 18h of 24");
  });

  // ONE SPELLING, BOTH SURFACES (#5487 fix 4). The household line reads the clause and
  // the cockpit ring and episode hero read the label, so the board's "18h of 24" is
  // asserted at the seam between them rather than once per surface.
  it("labels the same clause for the cockpit and the episode hero", () => {
    expect(schoolReturnCompactLabel(status)).toBe("Fever-free 18h of 24");
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
      lastAntipyretic:
        antipyreticHoursAgo != null
          ? {
              timeStated: true,
              atMs: NOW - antipyreticHoursAgo * HOUR,
              name: "Ibuprofen",
              clockLabel: "7:10pm",
            }
          : null,
      nowMs: NOW,
      thresholdHours: 24,
    });

  it("renders the honest state instead of a countdown, and cannot meet the threshold", () => {
    const s = silent(14);
    expect(s.evidence).toBe("none");
    expect(s.hoursSinceFever).toBe(14);
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toBe(
      "no reading since 103.4 °F (14h ago)"
    );
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
      lastAntipyretic: {
        timeStated: true,
        atMs: NOW - 6 * HOUR,
        name: "Ibuprofen",
        clockLabel: "6:00am",
      },
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
      lastAntipyretic: null,
      nowMs: NOW,
      thresholdHours: 24,
    });
    expect(s.clearedForHours).toBe(20);
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toBe("fever-free 20h of 24");
  });
});

// ── The clock needs a STATED administration time (#5688) ─────────────────────
//
// The countdown used to run from whatever instant the dose row could produce, which for
// a dose that states no administration time is its FILING stamp. A past-day
// skipped→taken flip keeps the skip's stamp, which predates the dose, so the clock
// started early and could clear a child for school while a reducer was still masking a
// fever. The owner's ruling: hold the countdown until a time is stated, show the
// "add it in Dose history" door, and invent no hour.
describe("an unstated fever-reducer time HOLDS the countdown (#5688)", () => {
  const base = {
    lastFeverAtMs: NOW - 30 * HOUR,
    lastFeverDegF: 102.2,
    firstNormalAfterFeverAtMs: NOW - 26 * HOUR,
    nowMs: NOW,
    thresholdHours: 24,
  };
  const held = computeSchoolReturn({
    ...base,
    lastAntipyretic: {
      timeStated: false,
      name: "Ibuprofen",
      clockLabel: "recorded 6:00am",
    },
  });

  it("renders a held clock with the door, and no fever-free number to clear on", () => {
    expect(held.evidence).toBe("held");
    expect(held.clearedForHours).toBeNull();
    expect(held.met).toBe(false);
    // No hours can be counted from a filing stamp…
    expect(held.hoursSinceAntipyretic).toBeNull();
    // …but the dose is still on the note, with its provenance intact.
    expect(held.lastAntipyreticName).toBe("Ibuprofen");
    expect(held.lastAntipyreticClockLabel).toBe("recorded 6:00am");
    expect(schoolReturnCompactClause(held)).toBe(
      "fever-free clock held — add the ibuprofen time in Dose history"
    );
    expect(schoolReturnCompactLabel(held)).toBe(
      "Fever-free clock held — add the ibuprofen time in Dose history"
    );
    expect(formatSchoolReturnLine(held, "F")).toContain("(recorded 6:00am)");
    expect(formatSchoolReturnLine(held, "F")).not.toContain("Fever-free 26h");
  });

  // THE DISCRIMINATION THIS WHOLE CHANGE RESTS ON. "The dose states no time" and
  // "no fever reducer was taken" are different facts, and the second is the PERMISSIVE
  // one — it hands the clock to the normal reading and clears the child. Dropping the
  // unstated dose would have re-created the defect under a new name, so the two inputs
  // must not render the same document.
  it("is not the same state as no fever reducer at all", () => {
    const none = computeSchoolReturn({ ...base, lastAntipyretic: null });
    expect(none.evidence).toBe("measured");
    expect(none.clearedForHours).toBe(26);
    expect(none.met).toBe(true); // 26h ≥ 24h — a clearance
    expect(held.evidence).not.toBe(none.evidence);
    expect(held.met).not.toBe(none.met);
    expect(schoolReturnCompactClause(held)).not.toBe(
      schoolReturnCompactClause(none)
    );
  });

  // A held clock does not run down. Waiting is what released the old permissive
  // version; here only a stated time does.
  it("cannot be cleared by waiting", () => {
    const later = computeSchoolReturn({
      ...base,
      nowMs: NOW + 72 * HOUR,
      lastAntipyretic: {
        timeStated: false,
        name: "Ibuprofen",
        clockLabel: "recorded 6:00am",
      },
    });
    expect(later.evidence).toBe("held");
    expect(later.met).toBe(false);
    expect(schoolReturnCompactClause(later)).not.toContain("fever-free 9");
  });

  // …and stating the time releases it, to the number the stated instant supports.
  it("a stated time releases it and computes from that instant", () => {
    const released = computeSchoolReturn({
      ...base,
      lastAntipyretic: {
        timeStated: true,
        atMs: NOW - 6 * HOUR,
        name: "Ibuprofen",
        clockLabel: "6:00am",
      },
    });
    expect(released.evidence).toBe("measured");
    expect(released.hoursSinceAntipyretic).toBe(6);
    expect(released.clearedForHours).toBe(6);
    expect(released.met).toBe(false);
  });

  // Nothing measured since the fever stays the answer it has always been: that gap is
  // #4685's, not this one's, and naming the reducer instead would change a case this
  // ruling never touched.
  it("does not displace the no-reading-since arm", () => {
    const silent = computeSchoolReturn({
      ...base,
      firstNormalAfterFeverAtMs: null,
      lastAntipyretic: {
        timeStated: false,
        name: "Ibuprofen",
        clockLabel: "recorded 6:00am",
      },
    });
    expect(silent.evidence).toBe("none");
    expect(silent.met).toBe(false);
  });
});
