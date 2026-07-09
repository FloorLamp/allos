import { describe, it, expect } from "vitest";
import { sourceLabel, formatRecordDate, titleCase } from "@/lib/record-format";
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

describe("titleCase", () => {
  it("capitalizes the first character only", () => {
    expect(titleCase("active")).toBe("Active");
    expect(titleCase("in progress")).toBe("In progress");
  });

  it("is a no-op on an empty string", () => {
    expect(titleCase("")).toBe("");
  });
});
