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
  isSubstanceLogged,
  substanceDef,
  substanceUnitWord,
  substanceCapStatus,
  capProgressLine,
  substanceTargetSignalKey,
  SUBSTANCE_USE_PREFIX,
  MAX_WEEKLY_CAP,
  MAX_SUBSTANCE_NAME_LENGTH,
  normalizeSubstanceName,
  resolveSubstanceKey,
  isCuratedSubstance,
  isCustomSubstanceKey,
  substanceLabel,
} from "../substance-use";

// Pure-tier pins for the substance-use domain (#998; #1078 nicotine/cannabis;
// #1085 DAST-10 in-app): instrument catalog shape + licensing discipline,
// severity-band boundaries (the uncopyrightable facts), the DAST-10 item encoding
// (incl. the reverse-scored item), the clinician-discussion threshold, the
// substance catalog + ledger split, cap-status math, the shared per-substance
// progress line, and the findings-bus key namespace. The DB/action tiers cover
// the write paths.

describe("substance instrument catalog", () => {
  it("carries exactly AUDIT-C, AUDIT, DAST-10", () => {
    expect([...SUBSTANCE_INSTRUMENTS]).toEqual(["AUDIT-C", "AUDIT", "DAST-10"]);
    expect(isSubstanceInstrument("AUDIT-C")).toBe(true);
    expect(isSubstanceInstrument("PHQ-9")).toBe(false);
    expect(isSubstanceInstrument(null)).toBe(false);
  });

  it("bakes item text for AUDIT-C and DAST-10; the AUDIT stays total-only (licensing)", () => {
    // AUDIT-C: in-app with 3 items, each carrying its own 0..4 options.
    const auditC = substanceInstrumentDef("AUDIT-C");
    expect(auditC.entry).toBe("in-app");
    expect(auditC.items).toHaveLength(3);
    for (const item of auditC.items) {
      expect(item.options.map((o) => o.value)).toEqual([0, 1, 2, 3, 4]);
    }
    expect(auditC.maxTotal).toBe(12);

    // DAST-10 (#1085 — the owner-reversed #998 determination): in-app with the
    // 10 yes/no items baked, each scored 0/1 via its own option values.
    const dast = substanceInstrumentDef("DAST-10");
    expect(dast.entry).toBe("in-app");
    expect(dast.items).toHaveLength(10);
    for (const item of dast.items) {
      expect([...item.options.map((o) => o.value)].sort()).toEqual([0, 1]);
      expect(item.options.map((o) => o.label).sort()).toEqual(["No", "Yes"]);
    }
    expect(dast.maxTotal).toBe(10);
    // The past-12-months framing travels with the items.
    expect(dast.instructions).toContain("past 12 months");

    // AUDIT: total-only, NO reproduced item text — the conservative path for the
    // WHO grant that's narrower than this repo's redistribution surface.
    const audit = substanceInstrumentDef("AUDIT");
    expect(audit.entry).toBe("total-only");
    expect(audit.items).toHaveLength(0);
    expect(audit.maxTotal).toBe(40);
  });

  it("DAST-10 scoring: all highest-risk answers = 10, all lowest-risk = 0 (pins the reverse-scored item)", () => {
    const dast = substanceInstrumentDef("DAST-10");
    // The scorer is a plain sum of chosen option values, so these two invariants
    // hold ONLY if the reverse-scored item's options are flipped — a naive
    // Yes=1/No=0 encoding on every item fails both directions at item 3.
    const highest = dast.items.reduce(
      (sum, item) => sum + Math.max(...item.options.map((o) => o.value)),
      0
    );
    const lowest = dast.items.reduce(
      (sum, item) => sum + Math.min(...item.options.map((o) => o.value)),
      0
    );
    expect(highest).toBe(10);
    expect(lowest).toBe(0);

    // Item 3 ("Are you always able to stop…") is THE reverse-scored item: "No"
    // earns the point. Every other item scores "Yes" = 1.
    const reverse = dast.items[2];
    expect(reverse.prompt).toContain("Are you always able to stop");
    expect(reverse.options.find((o) => o.label === "Yes")?.value).toBe(0);
    expect(reverse.options.find((o) => o.label === "No")?.value).toBe(1);
    dast.items.forEach((item, i) => {
      if (i === 2) return;
      expect(
        item.options.find((o) => o.label === "Yes")?.value,
        `item ${i + 1} Yes`
      ).toBe(1);
      expect(
        item.options.find((o) => o.label === "No")?.value,
        `item ${i + 1} No`
      ).toBe(0);
    });
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
  it("under the cap: quiet ceiling progress", () => {
    const s = substanceCapStatus(5, 7);
    expect(s).toEqual({
      count: 5,
      cap: 7,
      over: false,
      atCap: false,
      remaining: 2,
    });
    expect(capProgressLine(s)).toBe("5 of 7 this week.");
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

  it("speaks each substance's own unit words (#1078) — same computation, per-substance formatting", () => {
    // Nicotine: per-use counts, "use"-worded cap, nicotine-free week at cap 0.
    expect(capProgressLine(substanceCapStatus(5, 7), "nicotine")).toBe(
      "5 of 7 this week."
    );
    expect(capProgressLine(substanceCapStatus(9, 7), "nicotine")).toBe(
      "9 uses logged this week — 2 over your 7-use weekly cap."
    );
    expect(capProgressLine(substanceCapStatus(1, 0), "nicotine")).toBe(
      "1 use logged this week — your target is a nicotine-free week."
    );
    expect(capProgressLine(substanceCapStatus(0, 0), "nicotine")).toBe(
      "No uses logged this week — your target is a nicotine-free week."
    );
    // Cannabis mirrors nicotine's unit words with its own free-week phrase.
    expect(capProgressLine(substanceCapStatus(3, 2), "cannabis")).toBe(
      "3 uses logged this week — 1 over your 2-use weekly cap."
    );
    expect(capProgressLine(substanceCapStatus(0, 0), "cannabis")).toBe(
      "No uses logged this week — your target is a cannabis-free week."
    );
    // The default stays the #998 alcohol wording (back-compat).
    expect(capProgressLine(substanceCapStatus(9, 7), "alcohol")).toBe(
      capProgressLine(substanceCapStatus(9, 7))
    );
    expect(substanceUnitWord("alcohol", 1)).toBe("drink");
    expect(substanceUnitWord("nicotine", 2)).toBe("uses");
  });

  it("at the cap exactly is NOT over", () => {
    const s = substanceCapStatus(7, 7);
    expect(s.over).toBe(false);
    expect(s.atCap).toBe(true);
    expect(s.remaining).toBe(0);
    expect(capProgressLine(s)).toBe(
      "7 of 7 this week — at your 7-drink weekly cap."
    );
    expect(capProgressLine(s).toLowerCase()).not.toMatch(/met|on pace/);
  });

  it("no-gamification contract: the shared line never celebrates or streak-counts, for ANY substance", () => {
    for (const substance of SUBSTANCES) {
      for (const s of [
        substanceCapStatus(0, 7),
        substanceCapStatus(5, 7),
        substanceCapStatus(7, 7),
        substanceCapStatus(12, 7),
        substanceCapStatus(0, 0),
        substanceCapStatus(3, 0),
      ]) {
        const line = capProgressLine(s, substance).toLowerCase();
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
          "quit-day",
        ]) {
          expect(line, `${substance}: banned "${banned}"`).not.toContain(
            banned
          );
        }
      }
    }
  });

  it("sanitizes negative/fractional inputs", () => {
    expect(substanceCapStatus(-2, -5)).toEqual({
      count: 0,
      cap: 0,
      over: false,
      atCap: false,
      remaining: 0,
    });
    expect(substanceCapStatus(2.4, 7.6)).toEqual({
      count: 2,
      cap: 8,
      over: false,
      atCap: false,
      remaining: 6,
    });
  });
});

describe("substance catalog + findings-bus namespace", () => {
  it("substances + signal keys are stable and prefixed", () => {
    expect([...SUBSTANCES]).toEqual(["alcohol", "nicotine", "cannabis"]);
    expect(isSubstance("alcohol")).toBe(true);
    expect(isSubstance("nicotine")).toBe(true);
    expect(isSubstance("cannabis")).toBe(true);
    expect(isSubstance("caffeine")).toBe(false);
    for (const s of SUBSTANCES) {
      expect(substanceTargetSignalKey(s)).toBe(
        `substance-use:over-target:${s}`
      );
      expect(substanceTargetSignalKey(s).startsWith(SUBSTANCE_USE_PREFIX)).toBe(
        true
      );
    }
    expect(MAX_WEEKLY_CAP).toBeGreaterThan(0);
  });

  it("ledger split (#1078/#860): alcohol rides food_daily_totals; nicotine/cannabis ride substance_daily_totals", () => {
    expect(substanceDef("alcohol").ledger).toBe("food-log");
    expect(substanceDef("nicotine").ledger).toBe("substance-log");
    expect(substanceDef("cannabis").ledger).toBe("substance-log");
    // The write-core validator admits ONLY substance_daily_totals-ledger substances — an
    // alcohol (food-log) key or a forged key writes nothing there.
    expect(isSubstanceLogged("nicotine")).toBe(true);
    expect(isSubstanceLogged("cannabis")).toBe(true);
    expect(isSubstanceLogged("alcohol")).toBe(false);
    expect(isSubstanceLogged(null)).toBe(false);
    // #3279 MOVED THIS FIXTURE ACROSS ITS OWN BOUNDARY, DELIBERATELY. This line used to
    // read `isSubstanceLogged("caffeine") === false`, standing for "a forged key writes
    // nothing". The vocabulary is open now, so "caffeine" is a CUSTOM substance and the
    // counter ledger is exactly where it belongs — the old assertion would have gone on
    // passing only until someone typed it. What the validator still refuses is a key not
    // in canonical stored form (a caller that skipped resolveSubstanceKey and would
    // otherwise mint a near-miss neighbour of an existing row), so the refusal moves there.
    expect(isSubstanceLogged("caffeine")).toBe(true);
    expect(isSubstanceLogged(" caffeine ")).toBe(false);
    expect(isSubstanceLogged("Green  tea")).toBe(false);
    expect(isSubstanceLogged("")).toBe(false);
  });

  it("per-substance defs carry calm, non-gamified copy", () => {
    for (const s of SUBSTANCES) {
      const def = substanceDef(s);
      const text =
        `${def.label} ${def.logLabel} ${def.unitNote} ${def.freeWeekPhrase}`.toLowerCase();
      for (const banned of [
        "streak",
        "badge",
        "milestone",
        "congrat",
        "sober",
      ]) {
        expect(text, `${s}: banned "${banned}"`).not.toContain(banned);
      }
    }
  });
});

describe("substance vocabulary: curated + custom (#3279)", () => {
  it("normalizes a custom name the way symptoms do — trim, collapse, cap", () => {
    expect(normalizeSubstanceName("  Kratom ")).toBe("Kratom");
    expect(normalizeSubstanceName("Energy   drinks")).toBe("Energy drinks");
    expect(normalizeSubstanceName("x".repeat(200)).length).toBe(
      MAX_SUBSTANCE_NAME_LENGTH
    );
    // Case is the person's own — their capitalization IS their label.
    expect(normalizeSubstanceName("MDMA")).toBe("MDMA");
  });

  it("resolves a typed curated LABEL onto its curated key, so nothing shadows the catalog", () => {
    expect(resolveSubstanceKey("Alcohol")).toBe("alcohol");
    expect(resolveSubstanceKey("  NICOTINE ")).toBe("nicotine");
    expect(resolveSubstanceKey("cannabis")).toBe("cannabis");
    // Free text that is not a curated key or label becomes a custom key.
    expect(resolveSubstanceKey("  Kratom ")).toBe("Kratom");
    // Text that names nothing is not a key at all.
    expect(resolveSubstanceKey("")).toBeNull();
    expect(resolveSubstanceKey("   ")).toBeNull();
  });

  it("splits the key space cleanly: every key is curated XOR custom", () => {
    for (const s of SUBSTANCES) {
      expect(isCuratedSubstance(s)).toBe(true);
      expect(isCustomSubstanceKey(s)).toBe(false);
    }
    expect(isCuratedSubstance("Kratom")).toBe(false);
    expect(isCustomSubstanceKey("Kratom")).toBe(true);
    // Not in canonical stored form, so it is not a key on either side of the split.
    expect(isCustomSubstanceKey(" Kratom ")).toBe(false);
    expect(isCustomSubstanceKey("")).toBe(false);
  });

  it("substanceDef is TOTAL: an unknown key renders as itself instead of throwing", () => {
    const def = substanceDef("Kratom");
    expect(def.key).toBe("Kratom");
    expect(def.label).toBe("Kratom");
    expect(substanceLabel("Kratom")).toBe("Kratom");
    expect(substanceLabel("alcohol")).toBe("Alcohol");
    // Curated defs are untouched by the widening — byte-identical copy.
    expect(substanceDef("alcohol").logLabel).toBe("Log a standard drink");
  });

  it("a custom substance always rides the counter ledger with count semantics", () => {
    // The food-log ledger is a CURATED fact about alcohol (a standard drink IS one
    // serving of the curated `alcohol` food group). Nothing a person types can be shown
    // to be a food, so nothing typed may reach the nutrition ledger.
    for (const key of ["Kratom", "Energy drinks", "MDMA", "alcohol-free beer"]) {
      expect(substanceDef(key).ledger).toBe("substance-log");
      expect(substanceDef(key).unitPlural).toBe("uses");
      expect(substanceUnitWord(key, 1)).toBe("use");
      expect(substanceUnitWord(key, 2)).toBe("uses");
    }
  });

  it("derived custom copy stays calm and reads as English", () => {
    for (const key of ["Kratom", "Energy drinks", "MDMA"]) {
      const def = substanceDef(key);
      const text =
        `${def.label} ${def.logLabel} ${def.unitNote} ${def.freeWeekPhrase}`.toLowerCase();
      for (const banned of ["streak", "badge", "milestone", "congrat", "sober"]) {
        expect(text, `${key}: banned "${banned}"`).not.toContain(banned);
      }
    }
    // The article agrees with the name the person typed.
    expect(substanceDef("Kratom").freeWeekPhrase).toBe("a Kratom-free week");
    expect(substanceDef("Energy drinks").freeWeekPhrase).toBe(
      "an Energy drinks-free week"
    );
  });

  it("the cap line works for a custom substance — but ONLY reachable through a status", () => {
    // #3279 ruling 1: a SubstanceCapStatus exists only where a target row does
    // (lib/queries/substance.ts). This asserts the FORMATTING, not that anything
    // renders it uninvited.
    expect(capProgressLine(substanceCapStatus(3, 5), "Kratom")).toBe(
      "3 of 5 this week."
    );
    expect(capProgressLine(substanceCapStatus(6, 5), "Kratom")).toBe(
      "6 uses logged this week — 1 over your 5-use weekly cap."
    );
    // cap 0 is an OPTED-IN target (a substance-free week), never "no cap".
    expect(capProgressLine(substanceCapStatus(0, 0), "Kratom")).toBe(
      "No uses logged this week — your target is a Kratom-free week."
    );
  });

  it("the findings signal key follows a custom substance too", () => {
    expect(substanceTargetSignalKey("Kratom")).toBe(
      "substance-use:over-target:Kratom"
    );
  });
});
