// DB INTEGRATION TIER — a document stating an age in MONTHS records an infant (#3020).
//
// WHY THIS TIER. `normalizeAge` used to read the number and discard the unit, so
// "6 months" was 6 and the extraction path stored SIX YEARS on an infant. A pure unit
// test of the parser can show the number is now 0; it cannot show that a newborn is
// TREATED as a newborn, and the band is what every gate downstream actually reads.
// So each case here drives the REAL chain a model response takes —
//
//   resultFromExtractionInput  (the model's tool input → ExtractionMeta)
//     → extractionToPersistInput  (the import adapter)
//       → applyImportFollowups → adoptProfileFromExtraction → setStoredAge
//         → getProfileAge → lifeStage / the gates
//
// — with no hand-written mapping in the middle, and asserts the LIFE STAGE and a real
// gate at the end. Every case is paired against the same document stated in YEARS, so
// the two answers differing is the point: on main they were identical.
//
// No AI calls — the input is a synthetic tool payload with no records in it.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resultFromExtractionInput } from "@/lib/medical-extract";
import { extractionToPersistInput } from "@/lib/import-shape";
import { applyImportFollowups } from "@/lib/import-persist";
import { getProfileAge, getStoredAge } from "@/lib/settings/profile-attrs";
import {
  isFoodLoggingRelevant,
  isMinor,
  lifeStage,
  type LifeStage,
} from "@/lib/life-stage";
import { adultOnlyRefusal } from "@/lib/instrument-records";
import { getRecordsSpecialtyRelevance } from "@/lib/queries/nav-relevance";
import { fastingAvailable } from "@/lib/fast-write";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A document that states an age and NO birthdate — the combination that makes the
// stored age load-bearing. With a birthdate the fallback is never consulted.
function importDocumentStating(name: string, statedAge: unknown): number {
  const profileId = newProfile(name);
  const result = resultFromExtractionInput(
    { document_type: "clinic note", patient_age: statedAge, results: [] },
    [],
    "test-model"
  );
  const persist = extractionToPersistInput(result, "2026-01-05");
  applyImportFollowups(profileId, {
    demographics: persist.demographics,
    canonicalNames: [],
    insertedObservationIds: [],
  });
  return profileId;
}

function stageOf(profileId: number): LifeStage | null {
  return lifeStage(getProfileAge(profileId));
}

describe("a document stating an age in months records an infant (#3020)", () => {
  it("adopts '6 months' as an infant, not as a six-year-old", () => {
    const p = importDocumentStating("aup six months", "6 months");
    expect(getStoredAge(p)).toBe(0);
    expect(stageOf(p)).toBe("infant");

    // The paired control: the SAME number stated in years is the six-year-old the
    // old parser produced from the line above. Both answers were "child" on main.
    const control = importDocumentStating("aup six years", "6 years");
    expect(getStoredAge(control)).toBe(6);
    expect(stageOf(control)).toBe("child");
  });

  it("handles the abbreviated spellings a paediatric document uses", () => {
    for (const [i, stated] of ["6mo", "6 mos", "6m", "6-month-old"].entries()) {
      const p = importDocumentStating(`aup abbrev ${i}`, stated);
      expect(getStoredAge(p)).toBe(0);
      expect(stageOf(p)).toBe("infant");
    }
  });

  it("records 18 months as a one-year-old", () => {
    // Completed years: 18 months is a one-year-old, and 18 YEARS is an adult. The
    // gap between those two readings is the whole bug.
    const p = importDocumentStating("aup eighteen months", "18 months");
    expect(getStoredAge(p)).toBe(1);
    expect(stageOf(p)).toBe("child");

    const control = importDocumentStating("aup eighteen years", "18");
    expect(stageOf(control)).toBe("adult");
  });

  it("records a neonate stated in weeks or days as an infant", () => {
    for (const [i, stated] of ["3 weeks", "2 wk", "10 days", "1 d"].entries()) {
      const p = importDocumentStating(`aup neonate ${i}`, stated);
      expect(getStoredAge(p)).toBe(0);
      expect(stageOf(p)).toBe("infant");
    }
  });

  it("keeps a plain number and a year unit meaning years", () => {
    for (const stated of [45, "45", "45 years", "45 y/o", "45 yrs"]) {
      const p = importDocumentStating(`aup years ${String(stated)}`, stated);
      expect(getStoredAge(p)).toBe(45);
      expect(stageOf(p)).toBe("adult");
    }
  });

  it("records nothing at all for a unit it cannot vouch for", () => {
    // The refusing half: "unknown age" is a state every gate has a documented policy
    // for; a confident wrong number is not. Nothing is written, so a later document
    // stating a usable age can still fill it in.
    for (const [i, stated] of ["7 hours", "2 y 3 m", "45abc"].entries()) {
      const p = importDocumentStating(`aup unrecognized ${i}`, stated);
      expect(getStoredAge(p)).toBeNull();
      expect(stageOf(p)).toBeNull();
    }
  });
});

// The consequence the issue is actually about: these gates read the life stage, and
// the six-year-old they saw on main answered every one of them the adult-ward way.
// Each infant assertion is paired with the six-YEAR-old the old parser produced from
// the same document, so a regression that reinstates the discard flips the pair.
describe("the life-stage gates see the infant, not a six-year-old (#3020)", () => {
  it("does not turn food logging on for a baby", () => {
    const infant = importDocumentStating("aup food", "6 months");
    expect(isFoodLoggingRelevant(getProfileAge(infant))).toBe(false);

    const sixYears = importDocumentStating("aup food ctl", "6 years");
    expect(isFoodLoggingRelevant(getProfileAge(sixYears))).toBe(true);
  });

  it("treats the infant as a minor", () => {
    const infant = importDocumentStating("aup minor", "6 months");
    expect(isMinor(getProfileAge(infant))).toBe(true);
    // The six-year-old is a minor too — this pair is not what separates them, and it
    // is here so the food-logging flip above is not read as the only difference.
    expect(isMinor(getProfileAge(importDocumentStating("aup minor ctl", 6)))).toBe(
      true
    );
  });

  it("keeps the adult-only surfaces and write cores refusing", () => {
    const infant = importDocumentStating("aup adult only", "6 months");
    const relevance = getRecordsSpecialtyRelevance(infant);
    expect(relevance.substanceUse).toBe(false);
    expect(relevance.mentalHealth).toBe(false);
    expect(adultOnlyRefusal(infant, "AUDIT-C")).toBe(true);
    expect(fastingAvailable(infant)).toBe(false);
  });
});
