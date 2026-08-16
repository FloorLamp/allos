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
import { setStoredAge } from "@/lib/settings";
import { reconcileFlags } from "@/lib/queries/medical/flags";
import { today } from "@/lib/db";

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
    // A bare "6m" is deliberately NOT here — see the age+sex shorthand describe below.
    for (const [i, stated] of [
      "6mo",
      "6 mos",
      "6 mths",
      "6-month-old",
    ].entries()) {
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

  it("holds the just-under-a-year line in every sub-year unit", () => {
    // The band, at the boundary each conversion factor actually decides. A factor that
    // is off by a rounding — `w` as 52 rather than 365.25/7 — is invisible in the
    // middle of the range and turns THIS profile, a 364-day-old, into a one-year-old
    // with food logging on. The pure tier walks every spelling; this pins what the
    // gates do at the line.
    for (const [i, stated] of ["11 months", "52 w", "365 days"].entries()) {
      const p = importDocumentStating(`aup under a year ${i}`, stated);
      expect([stated, getStoredAge(p)]).toEqual([stated, 0]);
      expect(stageOf(p)).toBe("infant");
      expect(isFoodLoggingRelevant(getProfileAge(p))).toBe(false);
    }
    // And the first day of the next band, so the assertion above is a line rather than
    // a floor everything falls under.
    for (const [i, stated] of ["12 months", "53 w", "366 days"].entries()) {
      const p = importDocumentStating(`aup a year ${i}`, stated);
      expect([stated, getStoredAge(p)]).toEqual([stated, 1]);
      expect(stageOf(p)).toBe("child");
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
    expect(
      isMinor(getProfileAge(importDocumentStating("aup minor ctl", 6)))
    ).toBe(true);
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

// ── R1: reading an age DOWNWARD is not the conservative direction ───────────────
//
// The first cut of the unit table read a bare "m" as months, so "45M" — the ordinary
// age+sex shorthand of a triage note — stored a 45-year-old as 3. That was defended as
// "conservative, because it withholds content". It is not.
//
// Below 13 the app applies a DIFFERENT CLINICAL INTERPRETATION rather than simply less
// of the app. An adult's alkaline phosphatase of 300 U/L is genuinely out of range
// (adult band 40–129) and gets a `high` flag; the pediatric band for a three-year-old
// is 140–420, so the next reconcile finds the same value normal and ERASES the flag.
// A suppressed true positive is worse than a withheld surface, which is why the fix is
// to refuse the shorthand rather than to guess younger.
describe("mis-reading age+sex shorthand would erase a true positive (#3020 R1)", () => {
  function alpOf(recordId: number): string | null {
    return (
      (
        db
          .prepare("SELECT flag FROM medical_records WHERE id = ?")
          .get(recordId) as { flag: string | null } | undefined
      )?.flag ?? null
    );
  }

  // An out-of-range adult ALP on a profile whose age is not yet known. Unknown age
  // takes the adult band (lib/life-stage's positive-match-only policy), so the flag
  // starts out — correctly — as "high".
  function profileWithAdultAlpClaim(name: string): {
    p: number;
    alp: number;
  } {
    const p = newProfile(name);
    const alp = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
           VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p,
          today(p),
          "Alkaline Phosphatase",
          "300",
          "U/L",
          "Alkaline Phosphatase",
          300,
          "high"
        ).lastInsertRowid
    );
    return { p, alp };
  }

  it("refuses '45M' rather than recording a three-year-old", () => {
    for (const [i, shorthand] of ["45M", "45 M", "45m", "32F"].entries()) {
      const p = importDocumentStating(`aup shorthand ${i}`, shorthand);
      expect([shorthand, getStoredAge(p)]).toEqual([shorthand, null]);
      expect(stageOf(p)).toBeNull();
    }
  });

  it("leaves the adult's out-of-range ALP flagged", () => {
    const { p, alp } = profileWithAdultAlpClaim("aup alp shorthand");
    // The document the model returned off-schema: "45M presenting with chest pain".
    const result = resultFromExtractionInput(
      { document_type: "clinic note", patient_age: "45M", results: [] },
      [],
      "test-model"
    );
    const persist = extractionToPersistInput(result, "2026-01-05");
    applyImportFollowups(p, {
      demographics: persist.demographics,
      canonicalNames: [],
      insertedObservationIds: [],
    });
    reconcileFlags(p);

    // Nothing was adopted, so the adult band still applies and the true positive
    // survives. Asserted as ONE object so a failure shows both halves at once: with a
    // bare "m" in the table this reads `{ storedAge: 3, alp: null }` — the age the
    // shorthand was mis-read as, and the flag that mis-reading erased.
    expect({ storedAge: getStoredAge(p), alp: alpOf(alp) }).toEqual({
      storedAge: null,
      alp: "high",
    });
  });

  it("still clears the claim when the document really does state a child's age", () => {
    // The control that proves the assertion above is about the SHORTHAND and not about
    // reconcile having stopped working: a document that genuinely states 3 years does
    // re-band the same value, which is correct and must keep happening.
    const { p, alp } = profileWithAdultAlpClaim("aup alp child ctl");
    const child = importDocumentStating("aup alp child ctl doc", "3 years");
    expect(getStoredAge(child)).toBe(3);

    setStoredAge(p, 3);
    reconcileFlags(p);
    expect(alpOf(alp)).toBeNull();
  });
});

// The write boundary itself. Every caller passes a whole number today, so this is the
// trap the next one falls into rather than a live defect — and it was the only
// surviving round-UP in the write path after the parser started flooring.
describe("setStoredAge floors rather than rounding (#3020)", () => {
  it("does not round a fractional age up into the next life stage", () => {
    const infant = newProfile("aup set floor infant");
    setStoredAge(infant, 0.9);
    expect(getStoredAge(infant)).toBe(0);
    expect(lifeStage(getProfileAge(infant))).toBe("infant");

    const minor = newProfile("aup set floor minor");
    setStoredAge(minor, 17.6);
    expect(getStoredAge(minor)).toBe(17);
    expect(isMinor(getProfileAge(minor))).toBe(true);
  });
});
