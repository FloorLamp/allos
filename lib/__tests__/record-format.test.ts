import { describe, it, expect } from "vitest";
import {
  sourceLabel,
  formatRecordDate,
  formatRecordDateTime,
  titleCase,
  statusTone,
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
  it("formats a stored 'YYYY-MM-DD HH:MM' as a date + time, UTC-safe, default 24h", () => {
    // Default prefs are the dominant clock (24h) — the stored wall-clock digits
    // survive exactly, never the raw ISO string.
    expect(formatRecordDateTime("2026-07-13 14:30")).toBe(
      "Jul 13, 2026, 14:30"
    );
    // Accepts the "T" separator too.
    expect(formatRecordDateTime("2026-07-13T14:30")).toBe(
      formatRecordDateTime("2026-07-13 14:30")
    );
  });

  it("renders the time in the login's chosen clock", () => {
    expect(
      formatRecordDateTime("2026-07-13 14:30", "—", {
        timeFormat: "12h",
        dateFormat: "mdy",
      })
    ).toBe("Jul 13, 2026, 2:30 PM");
    expect(
      formatRecordDateTime("2026-07-13 14:30", "—", {
        timeFormat: "24h",
        dateFormat: "iso",
      })
    ).toBe("2026-07-13, 14:30");
  });

  it("falls back to a plain-date format when there is no time component", () => {
    expect(formatRecordDateTime("2024-01-05")).toBe("Jan 5, 2024");
  });

  it("returns the fallback for a null/empty value", () => {
    expect(formatRecordDateTime(null)).toBe("—");
    expect(formatRecordDateTime("")).toBe("—");
    expect(formatRecordDateTime(null, "")).toBe("");
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
