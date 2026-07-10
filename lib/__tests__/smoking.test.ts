import { describe, expect, it } from "vitest";
import {
  everSmoked,
  lungScreeningGate,
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
  resolveSmoking,
  smokingStatusLabel,
  NO_SMOKING,
  type ResolvedSmoking,
  type SmokingHistory,
} from "@/lib/smoking";
import { smokingStatusToStructured } from "@/lib/social-history";

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------
describe("parseSmokingStatus", () => {
  it("accepts the three known statuses, rejects everything else", () => {
    expect(parseSmokingStatus("never")).toBe("never");
    expect(parseSmokingStatus("former")).toBe("former");
    expect(parseSmokingStatus("current")).toBe("current");
    expect(parseSmokingStatus("")).toBeNull();
    expect(parseSmokingStatus("smoker")).toBeNull();
    expect(parseSmokingStatus(undefined)).toBeNull();
    expect(parseSmokingStatus(null)).toBeNull();
  });
});

describe("parsePackYears", () => {
  it("keeps a non-negative number to one decimal, clamped to 200", () => {
    expect(parsePackYears("20")).toBe(20);
    expect(parsePackYears("22.5")).toBe(22.5);
    expect(parsePackYears(30)).toBe(30);
    expect(parsePackYears("999")).toBe(200);
  });
  it("rejects blank / negative / non-numeric", () => {
    expect(parsePackYears("")).toBeNull();
    expect(parsePackYears(null)).toBeNull();
    expect(parsePackYears("-5")).toBeNull();
    expect(parsePackYears("abc")).toBeNull();
  });
});

describe("parseQuitYear", () => {
  it("accepts a plausible 4-digit year", () => {
    expect(parseQuitYear("2015")).toBe(2015);
    expect(parseQuitYear(1999)).toBe(1999);
  });
  it("rejects out-of-range / fractional / blank", () => {
    expect(parseQuitYear("1800")).toBeNull();
    expect(parseQuitYear("2200")).toBeNull();
    expect(parseQuitYear("2015.5")).toBeNull();
    expect(parseQuitYear("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// smokingStatusToStructured — CCD kept-status → tri-state (former | current)
// ---------------------------------------------------------------------------
describe("smokingStatusToStructured", () => {
  it("maps the SNOMED ex-smoker code to former", () => {
    expect(
      smokingStatusToStructured({ code: "8517006", display: "Ex-smoker" })
    ).toBe("former");
  });
  it("maps a former/ex/quit display to former", () => {
    expect(
      smokingStatusToStructured({ code: null, display: "Former smoker" })
    ).toBe("former");
    expect(
      smokingStatusToStructured({ code: "x", display: "Stopped smoking" })
    ).toBe("former");
  });
  it("maps every other kept exposure status to current", () => {
    expect(
      smokingStatusToStructured({
        code: "449868002",
        display: "Current every day smoker",
      })
    ).toBe("current");
    expect(
      smokingStatusToStructured({ code: null, display: "Light tobacco smoker" })
    ).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// resolveSmoking — structured wins, else imported ever-smoker fallback
// ---------------------------------------------------------------------------
describe("resolveSmoking", () => {
  it("uses the structured record when it carries a status", () => {
    const structured: SmokingHistory = {
      status: "former",
      packYears: 25,
      quitYear: 2018,
    };
    const r = resolveSmoking(structured, false);
    expect(r.source).toBe("structured");
    expect(r.everSmoked).toBe(true);
    expect(r.packYears).toBe(25);
    expect(r.quitYear).toBe(2018);
  });

  it("structured 'never' authoritatively clears an imported ever-smoker", () => {
    const r = resolveSmoking(
      { status: "never", packYears: null, quitYear: null },
      true
    );
    expect(r.source).toBe("structured");
    expect(r.everSmoked).toBe(false);
  });

  it("falls back to the imported condition as an ever-smoker with unknown detail", () => {
    const r = resolveSmoking(
      { status: null, packYears: null, quitYear: null },
      true
    );
    expect(r.source).toBe("imported");
    expect(r.everSmoked).toBe(true);
    expect(r.status).toBeNull();
    expect(r.packYears).toBeNull();
  });

  it("is NO_SMOKING when nothing is on file", () => {
    expect(resolveSmoking(null, false)).toEqual(NO_SMOKING);
    expect(
      resolveSmoking({ status: null, packYears: null, quitYear: null }, false)
    ).toEqual(NO_SMOKING);
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
const YEAR = 2026;

function resolved(p: Partial<ResolvedSmoking>): ResolvedSmoking {
  return { ...NO_SMOKING, ...p };
}

describe("everSmoked (AAA gate)", () => {
  it("is true for a former/current or imported ever-smoker, false otherwise", () => {
    expect(everSmoked(resolved({ everSmoked: true }))).toBe(true);
    expect(everSmoked(NO_SMOKING)).toBe(false);
  });
});

describe("lungScreeningGate", () => {
  it("is ineligible for a never/unknown-no-history profile", () => {
    expect(lungScreeningGate(NO_SMOKING, YEAR)).toBe("ineligible");
  });

  it("needs_info for an ever-smoker with unknown pack-years", () => {
    expect(
      lungScreeningGate(
        resolved({ everSmoked: true, source: "imported" }),
        YEAR
      )
    ).toBe("needs_info");
  });

  it("is ineligible below 20 pack-years", () => {
    expect(
      lungScreeningGate(
        resolved({ everSmoked: true, status: "current", packYears: 10 }),
        YEAR
      )
    ).toBe("ineligible");
  });

  it("is eligible for a current smoker at/over the threshold", () => {
    expect(
      lungScreeningGate(
        resolved({ everSmoked: true, status: "current", packYears: 20 }),
        YEAR
      )
    ).toBe("eligible");
  });

  it("is eligible for a former smoker who quit within 15 years", () => {
    expect(
      lungScreeningGate(
        resolved({
          everSmoked: true,
          status: "former",
          packYears: 30,
          quitYear: 2015,
        }),
        YEAR
      )
    ).toBe("eligible");
  });

  it("is ineligible for a former smoker who quit more than 15 years ago", () => {
    expect(
      lungScreeningGate(
        resolved({
          everSmoked: true,
          status: "former",
          packYears: 30,
          quitYear: 2005,
        }),
        YEAR
      )
    ).toBe("ineligible");
  });

  it("needs_info for a qualifying-pack-year former smoker with unknown quit year", () => {
    expect(
      lungScreeningGate(
        resolved({
          everSmoked: true,
          status: "former",
          packYears: 30,
          quitYear: null,
        }),
        YEAR
      )
    ).toBe("needs_info");
  });
});

describe("smokingStatusLabel", () => {
  it("labels each status and the unknown case", () => {
    expect(smokingStatusLabel("never")).toBe("Never smoked");
    expect(smokingStatusLabel("former")).toBe("Former smoker");
    expect(smokingStatusLabel("current")).toBe("Current smoker");
    expect(smokingStatusLabel(null)).toBe("Not recorded");
  });
});
