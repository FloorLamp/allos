import { describe, it, expect } from "vitest";
import { bioColor, deCollideColor, BIO_COLORS } from "../trend-colors";

describe("bioColor", () => {
  it("is deterministic and stays within the palette", () => {
    const a = bioColor("LDL Cholesterol");
    expect(a).toBe(bioColor("LDL Cholesterol"));
    expect(BIO_COLORS).toContain(a);
  });
});

describe("deCollideColor", () => {
  it("returns the color unchanged when it differs from the one to avoid", () => {
    expect(deCollideColor("#2563eb", "#dc2626")).toBe("#2563eb");
  });

  it("picks a different palette entry when the two colors collide", () => {
    const out = deCollideColor("#2563eb", "#2563eb");
    expect(out).not.toBe("#2563eb");
    expect(BIO_COLORS).toContain(out);
  });

  it("de-collides two biomarkers that hash to the same color", () => {
    // Find a real colliding pair from the palette-hash so the fix is exercised
    // end to end, not just on synthetic hex.
    const names = [
      "LDL Cholesterol",
      "HDL Cholesterol",
      "Glucose",
      "TSH",
      "ALT",
    ];
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        if (bioColor(a) === bioColor(b)) {
          const colorB = deCollideColor(bioColor(b), bioColor(a));
          expect(colorB).not.toBe(bioColor(a));
        }
      }
    }
  });

  it("falls back to the original color for a single-color palette", () => {
    expect(deCollideColor("#111", "#111", ["#111"])).toBe("#111");
  });
});
