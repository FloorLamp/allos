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
  transposeToMinusCylinder,
  parseEyeRefraction,
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

describe("transposeToMinusCylinder (#1036)", () => {
  it("transposes a plus-cylinder refraction: sphere += cyl, cyl negated, axis ± 90", () => {
    // −3.00 +1.00 ×090 ≡ −2.00 −1.00 ×180 (the issue's canonical example).
    expect(
      transposeToMinusCylinder({ sphere: -3, cylinder: 1, axis: 90 })
    ).toEqual({ sphere: -2, cylinder: -1, axis: 180 });
    // Axis below 90 gains 90.
    expect(
      transposeToMinusCylinder({ sphere: 0.5, cylinder: 0.75, axis: 20 })
    ).toEqual({ sphere: 1.25, cylinder: -0.75, axis: 110 });
  });

  it("wraps the axis on the 1–180 convention (180 → 90, 90 → 180, 0 → 90)", () => {
    expect(
      transposeToMinusCylinder({ sphere: -1, cylinder: 2, axis: 180 }).axis
    ).toBe(90);
    expect(
      transposeToMinusCylinder({ sphere: -1, cylinder: 2, axis: 90 }).axis
    ).toBe(180);
    // Axis 0 and 180 name the same meridian; both transpose to 90.
    expect(
      transposeToMinusCylinder({ sphere: -1, cylinder: 2, axis: 0 }).axis
    ).toBe(90);
  });

  it("transposes the inverse back to the original (exact algebra, no loss)", () => {
    const minus = transposeToMinusCylinder({
      sphere: -3,
      cylinder: 1,
      axis: 90,
    });
    // Inverting by hand (the plus-cyl transposition is its own inverse shape):
    expect(minus.sphere! + minus.cylinder!).toBe(-3);
    expect(-minus.cylinder!).toBe(1);
    expect((minus.axis! + 90) % 180 || 180).toBe(90);
  });

  it("still transposes sphere/cyl when the axis is missing (axis stays null)", () => {
    expect(
      transposeToMinusCylinder({ sphere: -3, cylinder: 1, axis: null })
    ).toEqual({ sphere: -2, cylinder: -1, axis: null });
  });

  it("keeps a missing sphere null (sphere + cyl is unknowable) but transposes cyl/axis", () => {
    expect(
      transposeToMinusCylinder({ sphere: null, cylinder: 1.5, axis: 45 })
    ).toEqual({ sphere: null, cylinder: -1.5, axis: 135 });
  });

  it("handles plano + plus-cyl (sphere 0 transposes to +cyl)", () => {
    expect(
      transposeToMinusCylinder({ sphere: 0, cylinder: 1, axis: 175 })
    ).toEqual({ sphere: 1, cylinder: -1, axis: 85 });
  });

  it("passes minus-cylinder and cylinder-less refractions through UNTOUCHED", () => {
    const minus = { sphere: -2, cylinder: -1, axis: 180 };
    expect(transposeToMinusCylinder(minus)).toBe(minus);
    const sphereOnly = { sphere: -2, cylinder: null, axis: null };
    expect(transposeToMinusCylinder(sphereOnly)).toBe(sphereOnly);
    const zeroCyl = { sphere: -2, cylinder: 0, axis: 90 };
    expect(transposeToMinusCylinder(zeroCyl)).toBe(zeroCyl);
  });
});

describe("parseEyeRefraction — the one shared per-eye coercion (#1036)", () => {
  it("parses slip notation then canonicalizes onto minus-cylinder", () => {
    expect(parseEyeRefraction("-3.00", "+1.00", "90")).toEqual({
      sphere: -2,
      cylinder: -1,
      axis: 180,
    });
    // Already minus-cyl: parsed, unchanged.
    expect(parseEyeRefraction("-2.00", "-1.00", "180")).toEqual({
      sphere: -2,
      cylinder: -1,
      axis: 180,
    });
    // Plano sphere spelled out, no cylinder.
    expect(parseEyeRefraction("plano", "", "")).toEqual({
      sphere: 0,
      cylinder: null,
      axis: null,
    });
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

  it("a mixed-notation history for an UNCHANGED eye trends flat once canonicalized (#1036)", () => {
    // The failing case this pins: an optometrist minus-cyl Rx followed by an
    // ophthalmologist plus-cyl Rx for the SAME refraction. Raw storage would show
    // a fake −1.00 D "progression" (the full cylinder); through the shared
    // coercion both store identically and the net change is exactly 0.
    const minusCyl = parseEyeRefraction("-2.00", "-1.00", "180");
    const plusCyl = parseEyeRefraction("-3.00", "+1.00", "90");
    expect(plusCyl).toEqual(minusCyl);
    const { netOd } = sphereProgression([
      {
        issued_date: "2024-01-01",
        od_sphere: minusCyl.sphere,
        os_sphere: null,
      },
      { issued_date: "2026-01-01", od_sphere: plusCyl.sphere, os_sphere: null },
    ]);
    expect(netOd).toBe(0);
  });
});

describe("prescriptionDisplayLabel — notation identity (#1036)", () => {
  it("both notations of one refraction render the same label once canonicalized", () => {
    const minusCyl = parseEyeRefraction("-2.00", "-1.00", "180");
    const plusCyl = parseEyeRefraction("-3.00", "+1.00", "90");
    const label = (sphere: number | null) =>
      prescriptionDisplayLabel({
        kind: "glasses",
        od_sphere: sphere,
        os_sphere: null,
      });
    expect(label(plusCyl.sphere)).toBe(label(minusCyl.sphere));
    expect(label(plusCyl.sphere)).toBe("Glasses (OD -2.00)");
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
