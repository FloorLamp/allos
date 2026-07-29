// DB INTEGRATION TIER (issue #1405) — a REFUTED allergy stops gating.
//
// This is the clinically load-bearing half of #1405: recording that a penicillin
// "allergy" was ruled out is only worth doing if it actually stops the drug-allergy
// matcher from flagging penicillin, and stops the passport / emergency card from
// listing it. Those are three different read paths, so this fixture asserts all of
// them answer from the ONE decision (isAllergyActionable).
//
// Deterministic: :memory:-backed temp DB via setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getAllergies,
  getAllergiesView,
  getIntakeSafetyContext,
} from "@/lib/queries";
import { setAllergyReactions } from "@/lib/allergy-write";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addAllergyRow(
  profileId: number,
  substance: string,
  verification: string | null,
  criticality: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO allergies
           (substance, reaction, severity, status, verification_status, criticality, profile_id)
         VALUES (?, 'Rash', 'mild', 'active', ?, ?, ?)`
      )
      .run(substance, verification, criticality, profileId).lastInsertRowid
  );
}

describe("verification status gates the safety surfaces", () => {
  it("a refuted allergy stays on the record list but leaves the safety context and the passport view", () => {
    const p = newProfile("refuted");
    addAllergyRow(p, "Penicillin", "refuted");
    addAllergyRow(p, "Peanut", "confirmed");

    // The management list still shows it — the user must be able to see (and undo)
    // the refutation.
    expect(
      getAllergies(p)
        .map((a) => a.substance)
        .sort()
    ).toEqual(["Peanut", "Penicillin"]);

    // The drug-allergy / food / supplement screen must not see it.
    const ctx = getIntakeSafetyContext(p);
    expect(ctx.allergens).toEqual(["Peanut"]);
    expect(ctx.allergyRecords.map((a) => a.substance)).toEqual(["Peanut"]);

    // Neither must the merged passport / emergency-card view.
    expect(getAllergiesView(p).map((a) => a.substance)).toEqual(["Peanut"]);
  });

  it("an entered-in-error row is excluded the same way", () => {
    const p = newProfile("entered-in-error");
    addAllergyRow(p, "Latex", "entered-in-error");
    expect(getIntakeSafetyContext(p).allergens).toEqual([]);
    expect(getAllergiesView(p)).toEqual([]);
  });

  it("an UNSTATED verification status keeps screening (every legacy row means unstated)", () => {
    const p = newProfile("legacy");
    addAllergyRow(p, "Sulfa", null);
    expect(getIntakeSafetyContext(p).allergens).toEqual(["Sulfa"]);
    expect(getAllergiesView(p).map((a) => a.substance)).toEqual(["Sulfa"]);
  });

  it("criticality rides through to the passport view", () => {
    const p = newProfile("criticality");
    addAllergyRow(p, "Bee venom", "confirmed", "high");
    expect(getAllergiesView(p)[0].criticality).toBe("high");
  });
});

describe("setAllergyReactions — the single writer of the manifestation list", () => {
  it("replaces the list, re-syncs the parent's cached first manifestation, and composes on read", () => {
    const p = newProfile("reactions");
    const id = addAllergyRow(p, "Peanut", "confirmed");
    expect(
      setAllergyReactions(p, id, [
        { manifestation: "Hives", severity: "moderate" },
        { manifestation: "Anaphylaxis", severity: "severe" },
        { manifestation: "   ", severity: "ignored" }, // blank rows are dropped
      ])
    ).toBe(true);

    const [stored] = getAllergies(p);
    expect(stored.reaction).toBe("Hives");
    expect(stored.severity).toBe("moderate");
    expect(stored.reactions).toEqual([
      { manifestation: "Hives", severity: "moderate" },
      { manifestation: "Anaphylaxis", severity: "severe" },
    ]);

    // Replace, not merge.
    setAllergyReactions(p, id, [{ manifestation: "Swelling", severity: null }]);
    const [after] = getAllergies(p);
    expect(after.reactions).toEqual([
      { manifestation: "Swelling", severity: null },
    ]);
    expect(after.reaction).toBe("Swelling");
    expect(after.severity).toBeNull();
  });

  it("clearing the list clears the cached scalar too", () => {
    const p = newProfile("reactions-clear");
    const id = addAllergyRow(p, "Dust", null);
    setAllergyReactions(p, id, []);
    const [after] = getAllergies(p);
    expect(after.reactions).toEqual([]);
    expect(after.reaction).toBeNull();
  });

  it("refuses another profile's allergy without writing anything", () => {
    const owner = newProfile("reactions-owner");
    const other = newProfile("reactions-other");
    const id = addAllergyRow(owner, "Shellfish", null);
    expect(setAllergyReactions(other, id, [{ manifestation: "Hives" }])).toBe(
      false
    );
    expect(getAllergies(owner)[0].reaction).toBe("Rash");
  });
});
