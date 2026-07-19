import { describe, expect, it } from "vitest";
import {
  SUBSTANCE_INSTRUMENTS,
  isSubstanceInstrument,
  substanceInstrumentDef,
  allSubstanceInstrumentDefs,
  substanceInstrumentForCanonicalName,
  substanceSeverityBand,
  shouldSuggestClinicianDiscussion,
  SUBSTANCES,
  isSubstance,
  substanceCapStatus,
  capProgressLine,
  substanceTargetSignalKey,
  SUBSTANCE_USE_PREFIX,
  MAX_WEEKLY_CAP,
} from "../substance-use";

// Pure-tier pins for the substance-use domain (#998): instrument catalog shape +
// licensing discipline, severity-band boundaries (the uncopyrightable facts), the
// clinician-discussion threshold, cap-status math, the shared progress line, and
// the findings-bus key namespace. The DB/action tiers cover the write paths.

describe("substance instrument catalog", () => {
  it("carries exactly AUDIT-C, AUDIT, DAST-10", () => {
    expect([...SUBSTANCE_INSTRUMENTS]).toEqual(["AUDIT-C", "AUDIT", "DAST-10"]);
    expect(isSubstanceInstrument("AUDIT-C")).toBe(true);
    expect(isSubstanceInstrument("PHQ-9")).toBe(false);
    expect(isSubstanceInstrument(null)).toBe(false);
  });

  it("bakes item text ONLY for the public-domain AUDIT-C (the licensing determination)", () => {
    // AUDIT-C: in-app with 3 items, each carrying its own 0..4 options.
    const auditC = substanceInstrumentDef("AUDIT-C");
    expect(auditC.entry).toBe("in-app");
    expect(auditC.items).toHaveLength(3);
    for (const item of auditC.items) {
      expect(item.options.map((o) => o.value)).toEqual([0, 1, 2, 3, 4]);
    }
    expect(auditC.maxTotal).toBe(12);

    // AUDIT + DAST-10: total-only, NO reproduced item text — the conservative
    // fallback for instruments whose reproduction rights aren't clearly free.
    for (const key of ["AUDIT", "DAST-10"] as const) {
      const def = substanceInstrumentDef(key);
      expect(def.entry).toBe("total-only");
      expect(def.items).toHaveLength(0);
    }
    expect(substanceInstrumentDef("AUDIT").maxTotal).toBe(40);
    expect(substanceInstrumentDef("DAST-10").maxTotal).toBe(10);
  });

  it("bands are contiguous from 0 through maxTotal with monotonic levels", () => {
    for (const def of allSubstanceInstrumentDefs()) {
      expect(def.bands[0].min).toBe(0);
      expect(def.bands[def.bands.length - 1].max).toBeNull();
      for (let i = 0; i < def.bands.length; i++) {
        expect(def.bands[i].level).toBe(i);
        if (i > 0) {
          expect(def.bands[i].min).toBe((def.bands[i - 1].max ?? NaN) + 1);
        }
      }
      // Every band carries a source line for its thresholds.
      expect(def.citation).toBeTruthy();
    }
  });

  it("maps canonical names back to instruments (#482 identity)", () => {
    expect(substanceInstrumentForCanonicalName("AUDIT-C")).toBe("AUDIT-C");
    expect(substanceInstrumentForCanonicalName(" audit ")).toBe("AUDIT");
    expect(substanceInstrumentForCanonicalName("DAST-10")).toBe("DAST-10");
    expect(substanceInstrumentForCanonicalName("PHQ-9")).toBeNull();
    expect(substanceInstrumentForCanonicalName(null)).toBeNull();
  });
});

describe("substanceSeverityBand — the published thresholds (facts)", () => {
  it("AUDIT-C bands (PHE/NHS): 0–4, 5–7, 8–10, 11–12", () => {
    expect(substanceSeverityBand("AUDIT-C", 0).label).toBe("Lower risk");
    expect(substanceSeverityBand("AUDIT-C", 4).label).toBe("Lower risk");
    expect(substanceSeverityBand("AUDIT-C", 5).label).toBe("Increasing risk");
    expect(substanceSeverityBand("AUDIT-C", 7).label).toBe("Increasing risk");
    expect(substanceSeverityBand("AUDIT-C", 8).label).toBe("Higher risk");
    expect(substanceSeverityBand("AUDIT-C", 11).label).toBe(
      "Possible dependence"
    );
  });

  it("AUDIT bands (WHO zones): 0–7, 8–15, 16–19, 20–40", () => {
    expect(substanceSeverityBand("AUDIT", 7).label).toBe("Lower risk");
    expect(substanceSeverityBand("AUDIT", 8).label).toBe("Increasing risk");
    expect(substanceSeverityBand("AUDIT", 15).label).toBe("Increasing risk");
    expect(substanceSeverityBand("AUDIT", 16).label).toBe("Higher risk");
    expect(substanceSeverityBand("AUDIT", 19).label).toBe("Higher risk");
    expect(substanceSeverityBand("AUDIT", 20).label).toBe(
      "Possible dependence"
    );
  });

  it("DAST-10 bands: 0, 1–2, 3–5, 6–8, 9–10", () => {
    expect(substanceSeverityBand("DAST-10", 0).label).toBe("None reported");
    expect(substanceSeverityBand("DAST-10", 1).label).toBe("Low");
    expect(substanceSeverityBand("DAST-10", 3).label).toBe("Moderate");
    expect(substanceSeverityBand("DAST-10", 6).label).toBe("Substantial");
    expect(substanceSeverityBand("DAST-10", 9).label).toBe("Severe");
  });

  it("clamps out-of-range totals instead of throwing (bad-extraction tolerance)", () => {
    expect(substanceSeverityBand("AUDIT-C", -3).level).toBe(0);
    expect(substanceSeverityBand("AUDIT-C", 99).label).toBe(
      "Possible dependence"
    );
    expect(substanceSeverityBand("DAST-10", 99).label).toBe("Severe");
  });
});

describe("shouldSuggestClinicianDiscussion — calm note, never crisis", () => {
  it("fires from the declared discuss band upward", () => {
    expect(shouldSuggestClinicianDiscussion("AUDIT-C", 7)).toBe(false);
    expect(shouldSuggestClinicianDiscussion("AUDIT-C", 8)).toBe(true);
    expect(shouldSuggestClinicianDiscussion("AUDIT", 15)).toBe(false);
    expect(shouldSuggestClinicianDiscussion("AUDIT", 16)).toBe(true);
    expect(shouldSuggestClinicianDiscussion("DAST-10", 5)).toBe(false);
    expect(shouldSuggestClinicianDiscussion("DAST-10", 6)).toBe(true);
  });
});

describe("substanceCapStatus + capProgressLine — the one shared computation", () => {
  it("under the cap: the '5 of your 7-drink weekly cap used' line", () => {
    const s = substanceCapStatus(5, 7);
    expect(s).toEqual({ count: 5, cap: 7, over: false, remaining: 2 });
    expect(capProgressLine(s)).toBe("5 of your 7-drink weekly cap used.");
  });

  it("over the cap: a calm factual line, never judgmental", () => {
    const s = substanceCapStatus(9, 7);
    expect(s.over).toBe(true);
    expect(s.remaining).toBe(0);
    expect(capProgressLine(s)).toBe(
      "9 drinks logged this week — 2 over your 7-drink weekly cap."
    );
  });

  it("cap 0 (alcohol-free week / Dry January) has honest copy both ways", () => {
    expect(capProgressLine(substanceCapStatus(0, 0))).toBe(
      "No drinks logged this week — your target is an alcohol-free week."
    );
    expect(capProgressLine(substanceCapStatus(1, 0))).toBe(
      "1 drink logged this week — your target is an alcohol-free week."
    );
  });

  it("at the cap exactly is NOT over", () => {
    const s = substanceCapStatus(7, 7);
    expect(s.over).toBe(false);
    expect(s.remaining).toBe(0);
  });

  it("no-gamification contract: the shared line never celebrates or streak-counts", () => {
    for (const s of [
      substanceCapStatus(0, 7),
      substanceCapStatus(5, 7),
      substanceCapStatus(7, 7),
      substanceCapStatus(12, 7),
      substanceCapStatus(0, 0),
      substanceCapStatus(3, 0),
    ]) {
      const line = capProgressLine(s).toLowerCase();
      for (const banned of [
        "streak",
        "badge",
        "milestone",
        "congrat",
        "great job",
        "well done",
        "keep it up",
        "days sober",
        "day streak",
      ]) {
        expect(line).not.toContain(banned);
      }
    }
  });

  it("sanitizes negative/fractional inputs", () => {
    expect(substanceCapStatus(-2, -5)).toEqual({
      count: 0,
      cap: 0,
      over: false,
      remaining: 0,
    });
    expect(substanceCapStatus(2.4, 7.6)).toEqual({
      count: 2,
      cap: 8,
      over: false,
      remaining: 6,
    });
  });
});

describe("findings-bus namespace", () => {
  it("substances + signal keys are stable and prefixed", () => {
    expect([...SUBSTANCES]).toEqual(["alcohol"]);
    expect(isSubstance("alcohol")).toBe(true);
    expect(isSubstance("nicotine")).toBe(false);
    expect(substanceTargetSignalKey("alcohol")).toBe(
      "substance-use:over-target:alcohol"
    );
    expect(
      substanceTargetSignalKey("alcohol").startsWith(SUBSTANCE_USE_PREFIX)
    ).toBe(true);
    expect(MAX_WEEKLY_CAP).toBeGreaterThan(0);
  });
});
