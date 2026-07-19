import { describe, expect, it } from "vitest";
import {
  INSTRUMENTS,
  instrumentDef,
  severityBand,
  isSevereTotal,
  selfHarmPositive,
  crisisDecision,
  instrumentForCanonicalName,
  isInstrument,
  mentalHealthCrisisKey,
  MENTAL_HEALTH_PREFIX,
} from "@/lib/mental-health";

// Pure tests for the mental-health instrument core (#716). Band EDGES are the load-bearing
// property — a one-off boundary error mislabels severity — so every band boundary of both
// instruments is pinned.

describe("severityBand — PHQ-9 band edges", () => {
  const cases: [number, string][] = [
    [0, "Minimal"],
    [4, "Minimal"],
    [5, "Mild"],
    [9, "Mild"],
    [10, "Moderate"],
    [14, "Moderate"],
    [15, "Moderately severe"],
    [19, "Moderately severe"],
    [20, "Severe"],
    [27, "Severe"],
  ];
  for (const [total, label] of cases) {
    it(`PHQ-9 total ${total} → ${label}`, () => {
      expect(severityBand("PHQ-9", total).label).toBe(label);
    });
  }
});

describe("severityBand — GAD-7 band edges", () => {
  const cases: [number, string][] = [
    [0, "Minimal"],
    [4, "Minimal"],
    [5, "Mild"],
    [9, "Mild"],
    [10, "Moderate"],
    [14, "Moderate"],
    [15, "Severe"],
    [21, "Severe"],
  ];
  for (const [total, label] of cases) {
    it(`GAD-7 total ${total} → ${label}`, () => {
      expect(severityBand("GAD-7", total).label).toBe(label);
    });
  }
});

describe("severityBand — clamps out-of-range totals (never throws)", () => {
  it("clamps a negative to the lowest band", () => {
    expect(severityBand("PHQ-9", -3).label).toBe("Minimal");
  });
  it("clamps above the max to the highest band", () => {
    expect(severityBand("PHQ-9", 99).label).toBe("Severe");
    expect(severityBand("GAD-7", 99).label).toBe("Severe");
  });
  it("rounds a fractional total", () => {
    expect(severityBand("PHQ-9", 4.6).label).toBe("Mild");
  });
});

describe("isSevereTotal", () => {
  it("PHQ-9: only 20+ is severe", () => {
    expect(isSevereTotal("PHQ-9", 19)).toBe(false);
    expect(isSevereTotal("PHQ-9", 20)).toBe(true);
  });
  it("GAD-7: only 15+ is severe", () => {
    expect(isSevereTotal("GAD-7", 14)).toBe(false);
    expect(isSevereTotal("GAD-7", 15)).toBe(true);
  });
});

describe("selfHarmPositive — PHQ-9 item 9", () => {
  it("true when item 9 (index 8) answered above 0", () => {
    expect(selfHarmPositive("PHQ-9", { 8: 1 })).toBe(true);
    expect(selfHarmPositive("PHQ-9", { 8: 3 })).toBe(true);
  });
  it("false when item 9 is 0 or absent (degrades to total-only)", () => {
    expect(selfHarmPositive("PHQ-9", { 8: 0 })).toBe(false);
    expect(selfHarmPositive("PHQ-9", {})).toBe(false);
  });
  it("GAD-7 has no self-harm item — always false", () => {
    expect(selfHarmPositive("GAD-7", { 0: 3, 6: 3 })).toBe(false);
  });
  it("accepts a Map as well as a record", () => {
    expect(selfHarmPositive("PHQ-9", new Map([[8, 2]]))).toBe(true);
  });
});

describe("crisisDecision", () => {
  it("escalates on a severe total even without item answers", () => {
    const d = crisisDecision("PHQ-9", 22, {});
    expect(d.escalate).toBe(true);
    expect(d.severe).toBe(true);
    expect(d.selfHarm).toBe(false);
  });
  it("escalates on a positive item 9 even when the total is not severe", () => {
    const d = crisisDecision("PHQ-9", 8, { 8: 2 });
    expect(d.escalate).toBe(true);
    expect(d.severe).toBe(false);
    expect(d.selfHarm).toBe(true);
  });
  it("does not escalate on a low total with a clean item 9", () => {
    const d = crisisDecision("PHQ-9", 6, { 8: 0 });
    expect(d.escalate).toBe(false);
  });
  it("GAD-7 escalates only on a severe total", () => {
    expect(crisisDecision("GAD-7", 15).escalate).toBe(true);
    expect(crisisDecision("GAD-7", 14).escalate).toBe(false);
  });
});

describe("instrument identity + helpers", () => {
  it("instrumentForCanonicalName resolves both instruments case-insensitively", () => {
    expect(instrumentForCanonicalName("PHQ-9")).toBe("PHQ-9");
    expect(instrumentForCanonicalName("gad-7")).toBe("GAD-7");
    expect(instrumentForCanonicalName("HDL Cholesterol")).toBeNull();
    expect(instrumentForCanonicalName(null)).toBeNull();
  });
  it("isInstrument guards the union", () => {
    expect(isInstrument("PHQ-9")).toBe(true);
    expect(isInstrument("nope")).toBe(false);
  });
  it("every instrument's bands cover 0..maxTotal contiguously", () => {
    for (const key of INSTRUMENTS) {
      const def = instrumentDef(key);
      expect(def.bands[0].min).toBe(0);
      expect(def.maxTotal).toBe(def.items.length * 3);
      for (let i = 1; i < def.bands.length; i++) {
        // Each band starts exactly one past the previous band's max (contiguous).
        expect(def.bands[i].min).toBe((def.bands[i - 1].max ?? 0) + 1);
      }
      expect(def.bands[def.bands.length - 1].max).toBeNull();
    }
  });
  it("mentalHealthCrisisKey is prefixed + re-keyed by date", () => {
    const k = mentalHealthCrisisKey("PHQ-9", "2026-07-19");
    expect(k.startsWith(MENTAL_HEALTH_PREFIX)).toBe(true);
    expect(k).toContain("2026-07-19");
    expect(k).not.toBe(mentalHealthCrisisKey("PHQ-9", "2026-08-19"));
  });
});
