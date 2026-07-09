import { describe, expect, it } from "vitest";
import {
  coursesFromImportedMedication,
  normalizeCcdaMedStatus,
  normalizeFhirMedStatus,
  type ImportMedPeriod,
} from "@/lib/medication-course-import";

describe("normalizeCcdaMedStatus", () => {
  it("maps the C-CDA statusCode vocabulary", () => {
    expect(normalizeCcdaMedStatus("active")).toBe("active");
    expect(normalizeCcdaMedStatus("new")).toBe("active");
    expect(normalizeCcdaMedStatus("completed")).toBe("completed");
    expect(normalizeCcdaMedStatus("aborted")).toBe("stopped");
    expect(normalizeCcdaMedStatus("cancelled")).toBe("stopped");
    expect(normalizeCcdaMedStatus("suspended")).toBe("on-hold");
    expect(normalizeCcdaMedStatus("held")).toBe("on-hold");
    expect(normalizeCcdaMedStatus("nullified")).toBe("entered-in-error");
    expect(normalizeCcdaMedStatus("Active")).toBe("active"); // case-insensitive
    expect(normalizeCcdaMedStatus(undefined)).toBe("unknown");
    expect(normalizeCcdaMedStatus("garbage")).toBe("unknown");
  });
});

describe("normalizeFhirMedStatus", () => {
  it("maps the FHIR MedicationRequest/Statement status vocabulary", () => {
    expect(normalizeFhirMedStatus("active")).toBe("active");
    expect(normalizeFhirMedStatus("completed")).toBe("completed");
    expect(normalizeFhirMedStatus("stopped")).toBe("stopped");
    expect(normalizeFhirMedStatus("cancelled")).toBe("stopped");
    expect(normalizeFhirMedStatus("not-taken")).toBe("stopped");
    expect(normalizeFhirMedStatus("on-hold")).toBe("on-hold");
    expect(normalizeFhirMedStatus("entered-in-error")).toBe("entered-in-error");
    expect(normalizeFhirMedStatus("draft")).toBe("unknown");
    expect(normalizeFhirMedStatus("intended")).toBe("unknown");
    expect(normalizeFhirMedStatus(null)).toBe("unknown");
  });
});

describe("coursesFromImportedMedication", () => {
  const period = (
    low: string | null,
    high: string | null
  ): ImportMedPeriod => ({
    low,
    high,
  });

  it("entered-in-error → null (drop the whole medication)", () => {
    expect(
      coursesFromImportedMedication(
        [period("2024-01-01", null)],
        "entered-in-error"
      )
    ).toBeNull();
  });

  it("no usable period → [] (caller falls back to the single open course)", () => {
    expect(coursesFromImportedMedication([], "active")).toEqual([]);
    expect(
      coursesFromImportedMedication([period(null, null)], "active")
    ).toEqual([]);
  });

  it("active med with an open-ended period → one OPEN course", () => {
    expect(
      coursesFromImportedMedication([period("2025-12-04", null)], "active")
    ).toEqual([
      {
        started_on: "2025-12-04",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("unknown status behaves like active (open, no forced stop)", () => {
    expect(
      coursesFromImportedMedication([period("2025-12-04", null)], "unknown")
    ).toEqual([
      {
        started_on: "2025-12-04",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("completed status → CLOSED course with completed_course", () => {
    expect(
      coursesFromImportedMedication(
        [period("2024-01-01", "2024-01-14")],
        "completed"
      )
    ).toEqual([
      {
        started_on: "2024-01-01",
        stopped_on: "2024-01-14",
        stop_reason: "completed_course",
        notes: null,
      },
    ]);
  });

  it("stopped status (real Epic 'aborted') → CLOSED with provider_discontinued", () => {
    expect(
      coursesFromImportedMedication(
        [period("2026-05-08", "2026-06-08")],
        "stopped",
        { note: "Adverse reaction" }
      )
    ).toEqual([
      {
        started_on: "2026-05-08",
        stopped_on: "2026-06-08",
        stop_reason: "provider_discontinued",
        notes: "Adverse reaction",
      },
    ]);
  });

  it("on-hold status → CLOSED with 'other' and an 'On hold' note", () => {
    expect(
      coursesFromImportedMedication([period("2024-03-01", null)], "on-hold", {
        fallbackStopDate: "2024-06-01",
      })
    ).toEqual([
      {
        started_on: "2024-03-01",
        stopped_on: "2024-06-01", // no high → fallbackStopDate
        stop_reason: "other",
        notes: "On hold",
      },
    ]);
  });

  it("closed-by-status but no high and no fallback → closes at its own start", () => {
    expect(
      coursesFromImportedMedication([period("2024-03-01", null)], "completed")
    ).toEqual([
      {
        started_on: "2024-03-01",
        stopped_on: "2024-03-01",
        stop_reason: "completed_course",
        notes: null,
      },
    ]);
  });

  it("active status but the period carries an explicit end → the bound wins (closed)", () => {
    expect(
      coursesFromImportedMedication(
        [period("2024-01-01", "2024-02-01")],
        "active"
      )
    ).toEqual([
      {
        started_on: "2024-01-01",
        stopped_on: "2024-02-01",
        stop_reason: "completed_course",
        notes: null,
      },
    ]);
  });

  it("multiple periods → multiple courses; earlier closed, latest reflects status", () => {
    const courses = coursesFromImportedMedication(
      [period("2020-01-01", "2020-03-01"), period("2023-06-01", null)],
      "active"
    );
    expect(courses).toEqual([
      {
        started_on: "2020-01-01",
        stopped_on: "2020-03-01",
        stop_reason: null,
        notes: null,
      },
      {
        started_on: "2023-06-01",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("multi-period with a completed status closes the LAST course too", () => {
    const courses = coursesFromImportedMedication(
      [period("2020-01-01", null), period("2023-06-01", "2023-07-01")],
      "completed"
    );
    // earlier open-ended episode closes at the next episode's start; the last
    // episode is closed by its own high + the status reason.
    expect(courses).toEqual([
      {
        started_on: "2020-01-01",
        stopped_on: "2023-06-01",
        stop_reason: null,
        notes: null,
      },
      {
        started_on: "2023-06-01",
        stopped_on: "2023-07-01",
        stop_reason: "completed_course",
        notes: null,
      },
    ]);
  });

  it("dedups periods sharing a start (matches the persist (item_id, started_on) key)", () => {
    const courses = coursesFromImportedMedication(
      [period("2024-01-01", null), period("2024-01-01", "2024-02-01")],
      "active"
    );
    // one course; the entry carrying an end is preferred.
    expect(courses).toHaveLength(1);
    expect(courses![0]).toMatchObject({
      started_on: "2024-01-01",
      stopped_on: "2024-02-01",
    });
  });

  it("sorts periods chronologically regardless of input order", () => {
    const courses = coursesFromImportedMedication(
      [period("2023-06-01", null), period("2020-01-01", "2020-03-01")],
      "active"
    );
    expect(courses!.map((c) => c.started_on)).toEqual([
      "2020-01-01",
      "2023-06-01",
    ]);
  });
});
