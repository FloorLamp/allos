import { describe, it, expect } from "vitest";
import {
  sourceLabel,
  formatRecordDate,
  formatRecordDateTime,
  titleCase,
  statusTone,
  formatVisitLabel,
  sourceDocumentId,
} from "@/lib/record-format";
import { documentSource } from "@/lib/body-metric-extract";

describe("sourceLabel", () => {
  it("reads a null source as a manual entry", () => {
    expect(sourceLabel(null)).toBe("Manual");
    expect(sourceLabel("")).toBe("Manual");
  });

  it("reads a document-sourced row as 'Document'", () => {
    expect(sourceLabel(documentSource(42))).toBe("Document");
    expect(sourceLabel("document:7")).toBe("Document");
  });

  it("shows any other source verbatim", () => {
    expect(sourceLabel("health-connect")).toBe("health-connect");
  });
});

describe("sourceDocumentId", () => {
  it("prefers a valid explicit document id", () => {
    expect(sourceDocumentId(42, "document:7")).toBe(42);
  });

  it("falls back to document provenance encoded in source", () => {
    expect(sourceDocumentId(null, "document:7")).toBe(7);
    expect(sourceDocumentId(undefined, documentSource(12))).toBe(12);
  });

  it("rejects manual, integration, and malformed provenance", () => {
    expect(sourceDocumentId(null, null)).toBeNull();
    expect(sourceDocumentId(null, "health-connect")).toBeNull();
    expect(sourceDocumentId(null, "document:0")).toBeNull();
    expect(sourceDocumentId(null, "document:nope")).toBeNull();
  });
});

describe("formatRecordDate", () => {
  it("formats a plain ISO date UTC-safe (no timezone shift)", () => {
    expect(formatRecordDate("2024-01-05")).toBe("Jan 5, 2024");
    expect(formatRecordDate("2024-12-31")).toBe("Dec 31, 2024");
  });

  it("reorders the date to the login's chosen shape", () => {
    expect(
      formatRecordDate("2024-01-05", "—", {
        timeFormat: "24h",
        dateFormat: "dmy",
      })
    ).toBe("5 Jan 2024");
    expect(
      formatRecordDate("2024-01-05", "—", {
        timeFormat: "24h",
        dateFormat: "iso",
      })
    ).toBe("2024-01-05");
  });

  it("returns the fallback for a null/empty date", () => {
    expect(formatRecordDate(null)).toBe("—");
    expect(formatRecordDate("")).toBe("—");
    expect(formatRecordDate(null, "")).toBe("");
  });

  it("returns the raw string when it isn't a plain ISO date", () => {
    expect(formatRecordDate("sometime in 2024")).toBe("sometime in 2024");
    expect(formatRecordDate("2024-01")).toBe("2024-01");
  });
});

describe("formatRecordDateTime", () => {
  it("formats a day + HH:MM pair as a date + time, UTC-safe, default 24h", () => {
    // Default prefs are the dominant clock (24h) — the stored wall-clock digits
    // survive exactly, never the raw ISO string. The halves arrive as the two
    // columns an appointment stores (#2234); nothing is sniffed out of a string.
    expect(formatRecordDateTime("2026-07-13", "14:30")).toBe(
      "Jul 13, 2026, 14:30"
    );
  });

  it("renders the time in the login's chosen clock", () => {
    expect(
      formatRecordDateTime("2026-07-13", "14:30", "—", {
        timeFormat: "12h",
        dateFormat: "mdy",
      })
    ).toBe("Jul 13, 2026, 2:30 PM");
    expect(
      formatRecordDateTime("2026-07-13", "14:30", "—", {
        timeFormat: "24h",
        dateFormat: "iso",
      })
    ).toBe("2026-07-13, 14:30");
  });

  it("falls back to a plain-date format when there is no time component", () => {
    expect(formatRecordDateTime("2024-01-05", null)).toBe("Jan 5, 2024");
  });

  it("returns the fallback for a null/empty date", () => {
    expect(formatRecordDateTime(null, null)).toBe("—");
    expect(formatRecordDateTime("", null)).toBe("—");
    expect(formatRecordDateTime(null, "14:30", "")).toBe("");
  });
});

describe("formatVisitLabel (#1526 — one computation for 'which visit is this?')", () => {
  it("leads with the type, then the provider, then the date", () => {
    expect(
      formatVisitLabel({
        date: "2026-05-04",
        type: "Dermatology",
        providerName: "Dr. Okafor",
      })
    ).toBe("Dermatology · Dr. Okafor · May 4, 2026");
  });

  it("drops an absent provider rather than leaving a dangling separator", () => {
    expect(
      formatVisitLabel({
        date: "2026-05-04",
        type: "Allergy clinic",
        providerName: null,
      })
    ).toBe("Allergy clinic · May 4, 2026");
  });

  it("falls back to a generic 'Visit' so a picker option is never blank", () => {
    expect(
      formatVisitLabel({ date: "2026-05-04", type: null, providerName: null })
    ).toBe("Visit · May 4, 2026");
    // Whitespace-only source values are treated as absent, not as content.
    expect(
      formatVisitLabel({ date: "2026-05-04", type: "  ", providerName: "  " })
    ).toBe("Visit · May 4, 2026");
  });

  it("follows the login's date shape, so the picker and the row sub-line agree", () => {
    expect(
      formatVisitLabel(
        { date: "2026-05-04", type: "Dermatology", providerName: null },
        { dateFormat: "dmy", timeFormat: "24h" }
      )
    ).toBe("Dermatology · 4 May 2026");
  });
});

describe("titleCase", () => {
  it("capitalizes the first character only", () => {
    expect(titleCase("active")).toBe("Active");
    expect(titleCase("in progress")).toBe("In progress");
  });

  it("is a no-op on an empty string", () => {
    expect(titleCase("")).toBe("");
  });
});

describe("statusTone", () => {
  it("maps the shared active/resolved/inactive enum to one tone each", () => {
    // The same status resolves to the SAME classes regardless of surface (#643):
    // conditions and allergies used to disagree (amber vs rose for 'active').
    expect(statusTone("active")).toContain("amber");
    expect(statusTone("resolved")).toContain("emerald");
    expect(statusTone("inactive")).toContain("slate");
  });

  it("covers care-plan / care-goal free-text statuses", () => {
    expect(statusTone("achieved")).toBe(statusTone("resolved"));
    expect(statusTone("completed")).toBe(statusTone("resolved"));
    expect(statusTone("planned")).toContain("sky");
    expect(statusTone("proposed")).toContain("sky");
  });

  it("normalizes casing and whitespace before matching", () => {
    expect(statusTone("Active")).toBe(statusTone("active"));
    expect(statusTone("  Resolved ")).toBe(statusTone("resolved"));
  });

  it("falls back to a neutral slate tone for an unknown status", () => {
    expect(statusTone("something-else")).toContain("slate");
  });
});
