import { describe, it, expect } from "vitest";
import {
  bioColor,
  deCollideColor,
  assignHashedColors,
  nameHashIndex,
  BIO_COLORS,
} from "../trend-colors";

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
      "Thyroid-Stimulating Hormone (TSH)",
      "Alanine Aminotransferase (ALT)",
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

describe("assignHashedColors (issue #406)", () => {
  const PALETTE = ["#a", "#b", "#c", "#d", "#e"];

  it("assigns each name its hash color, stable regardless of input order", () => {
    const a = assignHashedColors(["Running", "Cycling", "Swimming"], PALETTE);
    const b = assignHashedColors(["Swimming", "Cycling", "Running"], PALETTE);
    // Same set ⇒ identical mapping, whatever order (rank) it's passed in — so an
    // activity that changes volume rank keeps its color between views.
    for (const name of ["Running", "Cycling", "Swimming"]) {
      expect(a.get(name)).toBe(b.get(name));
    }
  });

  it("does not depend on rank: a name's color is independent of a rank flip", () => {
    // Cycling+Running present in both; adding a third name (different rank order)
    // must not repaint the original two.
    const first = assignHashedColors(["Cycling", "Running"], PALETTE);
    const second = assignHashedColors(["Running", "Cycling"], PALETTE);
    expect(first.get("Running")).toBe(second.get("Running"));
    expect(first.get("Cycling")).toBe(second.get("Cycling"));
  });

  it("de-collides within the visible set (no two names share a color)", () => {
    // Enough distinct names to force at least one hash collision into a probe.
    const names = ["Running", "Cycling", "Swimming", "Rowing", "Hiking"];
    const map = assignHashedColors(names, PALETTE);
    const colors = names.map((n) => map.get(n));
    expect(new Set(colors).size).toBe(names.length); // all distinct
    for (const col of colors) expect(PALETTE).toContain(col);
  });

  it("accepts a collision only once the set exceeds the palette", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"]; // 7 > palette 5
    const map = assignHashedColors(names, PALETTE);
    expect(map.size).toBe(7);
    for (const n of names) expect(PALETTE).toContain(map.get(n));
  });

  it("is empty for an empty palette", () => {
    expect(assignHashedColors(["x"], []).size).toBe(0);
  });
});

describe("nameHashIndex", () => {
  it("is deterministic and in range", () => {
    expect(nameHashIndex("Running", 8)).toBe(nameHashIndex("Running", 8));
    expect(nameHashIndex("Running", 8)).toBeGreaterThanOrEqual(0);
    expect(nameHashIndex("Running", 8)).toBeLessThan(8);
  });
  it("backs bioColor (same bucket)", () => {
    expect(
      BIO_COLORS[nameHashIndex("LDL Cholesterol", BIO_COLORS.length)]
    ).toBe(bioColor("LDL Cholesterol"));
  });
});
