import { describe, it, expect } from "vitest";
import {
  STOP_REASONS,
  isStopReason,
  normalizeStopReason,
  stopReasonLabel,
  SIDE_EFFECT_SEVERITIES,
  isSeverity,
  normalizeSeverity,
  isCourseOpen,
  sortCourses,
  currentCourse,
  isMedicationCurrent,
  courseDurationDays,
  partitionMedications,
  unresolvedCount,
  medicationCourseEvents,
  medicationMetaLine,
  type MedicationWithHistory,
} from "../medication-history";
import type {
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
} from "../types";

function course(
  p: Partial<MedicationCourse> & { id: number }
): MedicationCourse {
  return {
    item_id: 1,
    started_on: null,
    stopped_on: null,
    stop_reason: null,
    notes: null,
    created_at: "2025-01-01 00:00:00",
    ...p,
  };
}

function sideEffect(
  p: Partial<MedicationSideEffect> & { id: number }
): MedicationSideEffect {
  return {
    item_id: 1,
    course_id: null,
    effect: "Nausea",
    severity: null,
    noted_on: null,
    notes: null,
    resolved: 0,
    created_at: "2025-01-01 00:00:00",
    ...p,
  };
}

function med(id: number, name: string, active: 0 | 1 = 1): Supplement {
  return { id, name, active } as unknown as Supplement;
}

describe("stop_reason validation", () => {
  it("accepts every controlled reason and rejects others", () => {
    for (const r of STOP_REASONS) expect(isStopReason(r)).toBe(true);
    expect(isStopReason("nonsense")).toBe(false);
    expect(isStopReason(null)).toBe(false);
    expect(isStopReason(42)).toBe(false);
  });

  it("normalizes anything invalid to 'other', valid passes through", () => {
    expect(normalizeStopReason("side_effect")).toBe("side_effect");
    expect(normalizeStopReason("")).toBe("other");
    expect(normalizeStopReason("garbage")).toBe("other");
    expect(normalizeStopReason(undefined)).toBe("other");
  });

  it("labels a reason, falling back to 'Stopped' for null", () => {
    expect(stopReasonLabel("cost")).toBe("Cost");
    expect(stopReasonLabel(null)).toBe("Stopped");
  });
});

describe("severity validation", () => {
  it("accepts the three severities and rejects others", () => {
    for (const s of SIDE_EFFECT_SEVERITIES) expect(isSeverity(s)).toBe(true);
    expect(isSeverity("fatal")).toBe(false);
    expect(isSeverity("")).toBe(false);
  });

  it("normalizes an invalid/blank severity to null", () => {
    expect(normalizeSeverity("moderate")).toBe("moderate");
    expect(normalizeSeverity("")).toBeNull();
    expect(normalizeSeverity("severe-ish")).toBeNull();
    expect(normalizeSeverity(null)).toBeNull();
  });
});

describe("course-state derivation", () => {
  it("an open course has no stop date", () => {
    expect(isCourseOpen(course({ id: 1 }))).toBe(true);
    expect(isCourseOpen(course({ id: 1, stopped_on: "2025-02-01" }))).toBe(
      false
    );
  });

  it("sorts courses chronologically by start then id", () => {
    const sorted = sortCourses([
      course({ id: 2, started_on: "2025-03-01" }),
      course({ id: 1, started_on: "2025-01-01" }),
      course({ id: 3, started_on: "2025-01-01" }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual([1, 3, 2]);
  });

  it("currentCourse is the open one; the course-array overload reflects it", () => {
    const closed = [
      course({ id: 1, started_on: "2025-01-01", stopped_on: "2025-02-01" }),
    ];
    expect(currentCourse(closed)).toBeUndefined();
    expect(isMedicationCurrent(closed)).toBe(false);

    const withOpen = [...closed, course({ id: 2, started_on: "2025-03-01" })];
    expect(currentCourse(withOpen)?.id).toBe(2);
    expect(isMedicationCurrent(withOpen)).toBe(true);
  });

  it("the med overload of isMedicationCurrent keys off the active flag", () => {
    expect(isMedicationCurrent(med(1, "A", 1))).toBe(true);
    expect(isMedicationCurrent(med(1, "A", 0))).toBe(false);
  });

  it("computes inclusive duration in days; open runs to today", () => {
    expect(
      courseDurationDays(
        course({ id: 1, started_on: "2025-01-01", stopped_on: "2025-01-10" }),
        "2025-02-01"
      )
    ).toBe(10);
    expect(
      courseDurationDays(
        course({ id: 1, started_on: "2025-01-01" }),
        "2025-01-05"
      )
    ).toBe(5);
    expect(courseDurationDays(course({ id: 1 }), "2025-01-05")).toBeNull();
  });
});

describe("current-vs-past partition", () => {
  it("splits meds by the active flag and orders each group", () => {
    const items: MedicationWithHistory[] = [
      {
        med: med(1, "Zeta", 1), // active → current
        courses: [course({ id: 1, started_on: "2025-01-01" })],
        sideEffects: [],
      },
      {
        med: med(2, "Alpha", 1), // active → current
        courses: [course({ id: 2, started_on: "2025-01-01" })],
        sideEffects: [],
      },
      {
        med: med(3, "Beta", 0), // inactive → past
        courses: [
          course({ id: 3, started_on: "2024-01-01", stopped_on: "2024-06-01" }),
        ],
        sideEffects: [],
      },
      {
        med: med(4, "Gamma", 0), // inactive, more recent → past first
        courses: [
          course({ id: 4, started_on: "2025-05-01", stopped_on: "2025-05-20" }),
        ],
        sideEffects: [],
      },
    ];
    const { current, past } = partitionMedications(items);
    // Current name-sorted: Alpha, Zeta
    expect(current.map((c) => c.med.name)).toEqual(["Alpha", "Zeta"]);
    // Past most-recent-first: Gamma (2025-05-20) before Beta (2024-06-01)
    expect(past.map((c) => c.med.name)).toEqual(["Gamma", "Beta"]);
  });

  it("keys off active, not open-course presence (display can't contradict scheduling)", () => {
    // A desync: an active med whose course row is (wrongly) closed still reads
    // Current; an inactive med with an (wrongly) open course still reads Past.
    const items: MedicationWithHistory[] = [
      {
        med: med(1, "ActiveButClosed", 1),
        courses: [
          course({ id: 1, started_on: "2025-01-01", stopped_on: "2025-02-01" }),
        ],
        sideEffects: [],
      },
      {
        med: med(2, "InactiveButOpen", 0),
        courses: [course({ id: 2, started_on: "2025-01-01" })],
        sideEffects: [],
      },
    ];
    const { current, past } = partitionMedications(items);
    expect(current.map((c) => c.med.name)).toEqual(["ActiveButClosed"]);
    expect(past.map((c) => c.med.name)).toEqual(["InactiveButOpen"]);
  });
});

describe("unresolvedCount", () => {
  it("counts only unresolved side effects", () => {
    expect(
      unresolvedCount([
        sideEffect({ id: 1, resolved: 0 }),
        sideEffect({ id: 2, resolved: 1 }),
        sideEffect({ id: 3, resolved: 0 }),
      ])
    ).toBe(2);
  });
});

describe("timeline shaping", () => {
  it("emits a start event and, for a closed course, a stop event", () => {
    const events = medicationCourseEvents([
      {
        courseId: 7,
        medName: "Sertraline",
        startedOn: "2025-01-01",
        stoppedOn: "2025-02-01",
        stopReason: "side_effect",
        notes: "Nausea",
        sideEffectSummary: "Nausea",
      },
    ]);
    expect(events).toHaveLength(2);
    const start = events.find((e) => e.id === "med-course-start:7")!;
    const stop = events.find((e) => e.id === "med-course-stop:7")!;
    expect(start.date).toBe("2025-01-01");
    expect(start.title).toBe("Started Sertraline");
    expect(start.category).toBe("medication");
    expect(stop.date).toBe("2025-02-01");
    expect(stop.title).toBe("Stopped Sertraline");
    expect(stop.subtitle).toContain("Side effect");
    expect(stop.subtitle).toContain("Nausea");
    expect(stop.tone).toBe("warn"); // side_effect stops read as warn
  });

  it("emits only a start event for an open course, and skips missing dates", () => {
    const events = medicationCourseEvents([
      {
        courseId: 1,
        medName: "A",
        startedOn: "2025-01-01",
        stoppedOn: null,
        stopReason: null,
        notes: null,
      },
      {
        courseId: 2,
        medName: "B",
        startedOn: null,
        stoppedOn: null,
        stopReason: null,
        notes: null,
      },
    ]);
    expect(events.map((e) => e.id)).toEqual(["med-course-start:1"]);
  });

  it("a non-side-effect stop is neutral tone", () => {
    const [, stop] = medicationCourseEvents([
      {
        courseId: 3,
        medName: "C",
        startedOn: "2025-01-01",
        stoppedOn: "2025-02-01",
        stopReason: "completed_course",
        notes: null,
      },
    ]);
    expect(stop.tone).toBe("default");
  });
});

// Prescriber/pharmacy/Rx meta line, deduped from the two medicine surfaces (#313).
describe("medicationMetaLine", () => {
  const base = {
    prescriber: null,
    pharmacy: null,
    rx_number: null,
    provider_name: null,
  };

  it("builds the full middot-joined line in order", () => {
    expect(
      medicationMetaLine({
        prescriber: "Smith",
        pharmacy: "Central Pharmacy",
        rx_number: "12345",
        provider_name: "Test Clinic",
      })
    ).toBe("Dr. Smith · Central Pharmacy · Rx 12345 · Test Clinic");
  });

  it("strips a leading Dr./Rx the user may have typed in", () => {
    expect(
      medicationMetaLine({
        ...base,
        prescriber: "Dr. Smith",
        rx_number: "Rx 9",
      })
    ).toBe("Dr. Smith · Rx 9");
    // Case-insensitive, optional dot/space.
    expect(
      medicationMetaLine({ ...base, prescriber: "dr Jones", rx_number: "rx7" })
    ).toBe("Dr. Jones · Rx 7");
  });

  it("drops empty parts", () => {
    expect(medicationMetaLine({ ...base, pharmacy: "Corner Rx" })).toBe(
      "Corner Rx"
    );
  });

  it("returns an empty string when no metadata is present", () => {
    expect(medicationMetaLine(base)).toBe("");
  });
});
