import { describe, it, expect } from "vitest";
import {
  normalizeOpticalKind,
  parseDiopter,
  parseAxis,
  parseMillimeters,
  formatDiopter,
  prescriptionDisplayLabel,
  rxExpiryState,
  kindLabel,
  sphereProgression,
} from "@/lib/optical-prescription";

describe("normalizeOpticalKind", () => {
  it("recognizes contact-lens phrasings", () => {
    for (const s of ["contacts", "contact lens", "CL", "soft toric", "RGP"])
      expect(normalizeOpticalKind(s)).toBe("contacts");
  });
  it("defaults everything else to glasses", () => {
    for (const s of ["glasses", "eyeglasses", "spectacles", "", "??", null])
      expect(normalizeOpticalKind(s)).toBe("glasses");
  });
});

describe("parseDiopter", () => {
  it("parses signed dioptres including a leading +", () => {
    expect(parseDiopter("+1.25")).toBe(1.25);
    expect(parseDiopter("-2.00")).toBe(-2);
    expect(parseDiopter("-0.75 DS")).toBe(-0.75);
    expect(parseDiopter(-3.5)).toBe(-3.5);
  });
  it("treats plano / pl / 0 as zero power", () => {
    expect(parseDiopter("plano")).toBe(0);
    expect(parseDiopter("PL")).toBe(0);
    expect(parseDiopter("0")).toBe(0);
  });
  it("returns null for non-numeric / absent", () => {
    expect(parseDiopter("")).toBeNull();
    expect(parseDiopter("n/a")).toBeNull();
    expect(parseDiopter(null)).toBeNull();
    expect(parseDiopter(NaN)).toBeNull();
  });
});

describe("parseAxis", () => {
  it("keeps a whole degree in [0,180]", () => {
    expect(parseAxis("90")).toBe(90);
    expect(parseAxis("180")).toBe(180);
    expect(parseAxis(0)).toBe(0);
    expect(parseAxis("12.6")).toBe(13); // rounded
  });
  it("rejects out-of-range and non-numeric", () => {
    expect(parseAxis("181")).toBeNull();
    expect(parseAxis("")).toBeNull();
    expect(parseAxis(null)).toBeNull();
  });
});

describe("parseMillimeters", () => {
  it("parses a positive measurement", () => {
    expect(parseMillimeters("63")).toBe(63);
    expect(parseMillimeters("8.6")).toBe(8.6);
    expect(parseMillimeters(14.2)).toBe(14.2);
  });
  it("rejects non-positive / non-numeric", () => {
    expect(parseMillimeters("0")).toBeNull();
    expect(parseMillimeters("-5")).toBe(5); // digit match ignores sign; positive kept
    expect(parseMillimeters("")).toBeNull();
    expect(parseMillimeters(null)).toBeNull();
  });
});

describe("formatDiopter", () => {
  it("adds a + for positive powers and Plano for zero", () => {
    expect(formatDiopter(1.25)).toBe("+1.25");
    expect(formatDiopter(-2)).toBe("-2.00");
    expect(formatDiopter(0)).toBe("Plano");
    expect(formatDiopter(null)).toBe("—");
  });
});

describe("prescriptionDisplayLabel", () => {
  it("shows the kind and a compact per-eye sphere", () => {
    expect(
      prescriptionDisplayLabel({
        kind: "glasses",
        od_sphere: -2,
        os_sphere: -1.75,
      })
    ).toBe("Glasses (OD -2.00 / OS -1.75)");
    expect(
      prescriptionDisplayLabel({
        kind: "contacts",
        od_sphere: null,
        os_sphere: null,
      })
    ).toBe("Contacts");
  });
});

describe("kindLabel", () => {
  it("labels both kinds", () => {
    expect(kindLabel("glasses")).toBe("Glasses");
    expect(kindLabel("contacts")).toBe("Contacts");
  });
});

describe("sphereProgression", () => {
  it("orders points oldest-first and computes net change per eye", () => {
    const { points, netOd, netOs } = sphereProgression([
      { issued_date: "2024-01-01", od_sphere: -1.5, os_sphere: -1.25 },
      { issued_date: "2026-01-01", od_sphere: -2.5, os_sphere: -2 },
      { issued_date: "2025-01-01", od_sphere: -2, os_sphere: -1.75 },
    ]);
    expect(points.map((p) => p.date)).toEqual([
      "2024-01-01",
      "2025-01-01",
      "2026-01-01",
    ]);
    expect(netOd).toBeCloseTo(-1); // -1.5 → -2.5
    expect(netOs).toBeCloseTo(-0.75);
  });
  it("drops undated / sphere-less rows and needs 2 points for a net", () => {
    const { points, netOd, netOs } = sphereProgression([
      { issued_date: null, od_sphere: -1, os_sphere: -1 },
      { issued_date: "2025-01-01", od_sphere: -2, os_sphere: null },
    ]);
    expect(points).toHaveLength(1);
    expect(netOd).toBeNull(); // only one point
    expect(netOs).toBeNull();
  });
});

describe("rxExpiryState", () => {
  const today = "2026-07-19";
  it("flags an already-past expiry", () => {
    expect(rxExpiryState("2026-01-01", today)).toBe("expired");
  });
  it("flags an expiry within the soon window", () => {
    expect(rxExpiryState("2026-08-01", today)).toBe("expiring-soon");
  });
  it("treats a far-future expiry as current", () => {
    expect(rxExpiryState("2027-07-01", today)).toBe("current");
  });
  it("returns null with no expiry or a bad date", () => {
    expect(rxExpiryState(null, today)).toBeNull();
    expect(rxExpiryState("not-a-date", today)).toBeNull();
  });
});
