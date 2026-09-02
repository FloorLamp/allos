// DB INTEGRATION TIER — the one intake-form context loader (#4609).
//
// WHAT COULD GO WRONG THAT A PURE TEST CANNOT SEE. The defect this loader exists to
// close was a host handing the form SOMEBODY's context rather than the SUBJECT's, and
// the reassuring version of that bug resolves "the current user" — which is correct on
// every fixture where the acting profile and the subject are the same person, and wrong
// the moment a caregiver opens the add door for a child. So every assertion here runs
// over TWO profiles seeded to give DIFFERENT answers to each question, and the parent's
// answers are asserted too: a test where both profiles agree proves nothing.
//
// Fixtures are synthetic (a throwaway per-file DB; plainly fictional people).

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { loadIntakeFormContext } from "@/lib/intake-form-context";
import { PEDIATRIC_MAX_AGE_MONTHS, pediatricAgeYears } from "@/lib/prn-dosing";
import { setProfileBirthdate } from "@/lib/settings";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addMedication(
  profileId: number,
  name: string,
  rxcui: string | null = null
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
           VALUES (?, ?, 1, 'medication', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  if (rxcui)
    db.prepare("UPDATE intake_items SET rxcui = ? WHERE id = ?").run(rxcui, id);
  return id;
}

// A January-1 birthdate exactly `years` before the profile's own current year: the
// whole-year age is then `years` on every day this runs, with no leap-day or
// birthday-not-yet-reached edge to drift on.
function birthdateFor(profileId: number, years: number): string {
  return `${Number(today(profileId).slice(0, 4)) - years}-01-01`;
}

// A household with one adult and one child, each carrying a different answer to every
// question the form's safety surface asks.
function household() {
  const parentId = makeProfile("Parent Ora");
  const childId = makeProfile("Child Bo");

  setProfileBirthdate(parentId, birthdateFor(parentId, 41));
  setProfileBirthdate(childId, birthdateFor(childId, 6));

  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
  ).run(parentId, today(parentId), 74);
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
  ).run(childId, today(childId), 21);

  addMedication(parentId, "Warfarin", "11289");
  addMedication(childId, "Amoxicillin");

  db.prepare(
    `INSERT INTO genomic_variants
       (profile_id, gene, star_allele, significance, result_type, interpretation)
       VALUES (?, 'CYP2C9', '*3/*3', 'pathogenic', 'pharmacogenomic', 'Poor metabolizer')`
  ).run(parentId);
  db.prepare(
    `INSERT INTO genomic_variants
       (profile_id, gene, star_allele, significance, result_type, interpretation)
       VALUES (?, 'CYP2D6', '*4/*4', 'pathogenic', 'pharmacogenomic', 'Poor metabolizer')`
  ).run(childId);
  // Not pharmacogenomic: it belongs to the child and must NOT reach the form.
  db.prepare(
    `INSERT INTO genomic_variants
       (profile_id, gene, significance, result_type)
       VALUES (?, 'BRCA1', 'pathogenic', 'hereditary-risk')`
  ).run(childId);

  db.prepare(
    "INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Atrial fibrillation', 'active')"
  ).run(parentId);
  db.prepare(
    "INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Ear infection', 'active')"
  ).run(childId);

  return { parentId, childId };
}

describe("loadIntakeFormContext is keyed on the write's subject (#4609)", () => {
  it("answers for the profile it is asked about, not for its household", () => {
    const { parentId, childId } = household();
    const parent = loadIntakeFormContext(parentId);
    const child = loadIntakeFormContext(childId);

    // THE FIXTURE REACHES THE STATE THE ASSERTIONS ARE ABOUT: the two profiles
    // disagree on every axis, so an acting-profile-keyed loader could not pass.
    expect(pediatricAgeYears(parent.pediatric)).toBe(41);
    expect(pediatricAgeYears(child.pediatric)).toBe(6);
    expect(parent.pediatric.ageMonths).toBeGreaterThanOrEqual(
      PEDIATRIC_MAX_AGE_MONTHS
    );
    expect(child.pediatric.ageMonths).toBeLessThan(PEDIATRIC_MAX_AGE_MONTHS);

    expect(parent.pediatric.weightKg).toBe(74);
    expect(child.pediatric.weightKg).toBe(21);

    expect(parent.allIntakeItems.map((i) => i.name)).toEqual(["Warfarin"]);
    expect(child.allIntakeItems.map((i) => i.name)).toEqual(["Amoxicillin"]);

    expect(parent.stackItems.map((i) => i.name)).toEqual(["Warfarin"]);
    expect(child.stackItems.map((i) => i.name)).toEqual(["Amoxicillin"]);
    expect(parent.stackItems[0]!.rxcui).toBe("11289");

    expect(parent.pgxVariants.map((v) => v.gene)).toEqual(["CYP2C9"]);
    expect(child.pgxVariants.map((v) => v.gene)).toEqual(["CYP2D6"]);

    expect(parent.conditions.map((c) => c.name)).toEqual([
      "Atrial fibrillation",
    ]);
    expect(child.conditions.map((c) => c.name)).toEqual(["Ear infection"]);

    // The start-date seed is the SUBJECT's local day (#4609's todayStr half — its
    // absence is what silently switched addIntakeItem's validation branch).
    expect(child.todayStr).toBe(today(childId));
    expect(child.todayStr).toBe(child.pediatric.today);
  });

  it("is empty rather than borrowed for a profile with nothing on file", () => {
    const { childId } = household();
    const stranger = makeProfile("Stranger Vee");
    const context = loadIntakeFormContext(stranger);

    // The neighbour HAS the rows, so an unscoped read would have found them.
    expect(loadIntakeFormContext(childId).allIntakeItems).toHaveLength(1);
    expect(context.allIntakeItems).toEqual([]);
    expect(context.stackItems).toEqual([]);
    expect(context.pgxVariants).toEqual([]);
    expect(context.conditions).toEqual([]);
    expect(context.pediatric.ageMonths).toBeNull();
    expect(pediatricAgeYears(context.pediatric)).toBeNull();
  });

  it("carries the weight unit the caller asked for", () => {
    const { childId } = household();
    expect(loadIntakeFormContext(childId).pediatric.weightUnit).toBe("kg");
    expect(loadIntakeFormContext(childId, "lb").pediatric.weightUnit).toBe(
      "lb"
    );
  });
});
