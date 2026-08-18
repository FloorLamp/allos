import { describe, it, expect } from "vitest";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import { TIME_BUCKETS, FOOD_TIMINGS } from "@/lib/intake-schedule";

// Structural pins for the hand-maintained catalog, so an added entry can't
// silently shadow an existing one or carry a vocabulary the form won't accept.
describe("SUPPLEMENT_CATALOG", () => {
  it("has case-insensitively unique names", () => {
    const names = SUPPLEMENT_CATALOG.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry carries a non-empty name and at least one dosage", () => {
    for (const c of SUPPLEMENT_CATALOG) {
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(c.dosages.length).toBeGreaterThan(0);
      for (const d of c.dosages) expect(d.trim().length).toBeGreaterThan(0);
    }
  });

  it("defaults stay inside the shared vocabularies", () => {
    for (const c of SUPPLEMENT_CATALOG) {
      if (c.defaultTimeOfDay) {
        expect(TIME_BUCKETS).toContain(c.defaultTimeOfDay);
      }
      if (c.defaultFoodTiming) {
        expect(FOOD_TIMINGS).toContain(c.defaultFoodTiming);
      }
    }
  });
});
