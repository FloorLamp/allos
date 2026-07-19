// DB INTEGRATION TIER — the ototoxic-medication awareness builder (#717), per the #448
// findings-builder-test discipline.
//
// getOtotoxicWarnings is a findings BUILDER: it GATHERS DB state (the profile's ACTIVE
// medications, via the shared getIntakeSafetyContext) and hands it to the pure engine
// (crossCheckOtotoxic). The pure tier (lib/__tests__/ototoxic.test.ts) takes pre-gathered
// arrays and structurally can't see a gather bug (an inactive/supplement row leaking in,
// the wrong med set) — so this seeds a realistic fixture and asserts the END-TO-END
// finding, its dismissible Upcoming twin (one question, one computation), AND the
// downstream risk-cadence consumer (#717 half 2): an active ototoxic med brings the
// hearing screening due sooner.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getOtotoxicWarnings,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";
import { getRiskFactors } from "@/lib/queries/upcoming/risk";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addMedication(
  profileId: number,
  name: string,
  active = 1,
  rxcui: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, rxcui)
         VALUES (?, ?, ?, 'medication', ?)`
      )
      .run(profileId, name, active, rxcui).lastInsertRowid
  );
}

describe("getOtotoxicWarnings — active ototoxic meds (#717)", () => {
  it("flags an active aminoglycoside on both surfaces, and dismiss silences everywhere", () => {
    const profileId = makeProfile("ototoxic-aminoglycoside");
    const medId = addMedication(profileId, "Gentamicin 80 mg");

    const warnings = getOtotoxicWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].entryKey).toBe("aminoglycoside");
    expect(warnings[0].dedupeKey).toBe(`ototoxic:${medId}:aminoglycoside`);

    // Surface 2: the dismissible Upcoming finding — same dedupeKey, care-tier band.
    const up = collectUpcoming(profileId, today(profileId)).find(
      (i) => i.domain === "ototoxic"
    );
    expect(up?.key).toBe(warnings[0].dedupeKey);
    expect(up?.band).toBe("today"); // care-tier → Needs-attention hero

    dismissFinding(profileId, warnings[0].dedupeKey);
    expect(
      collectUpcoming(profileId, today(profileId)).some(
        (i) => i.domain === "ototoxic"
      )
    ).toBe(false);
  });

  it("ignores an INACTIVE ototoxic med and a non-ototoxic active med", () => {
    const profileId = makeProfile("ototoxic-inactive");
    addMedication(profileId, "Cisplatin", 0); // inactive → not in the active gather
    addMedication(profileId, "Lisinopril", 1); // active but not ototoxic
    expect(getOtotoxicWarnings(profileId)).toEqual([]);
    expect(getRiskFactors(profileId).has("ototoxic-medication")).toBe(false);
  });

  it("an active ototoxic med activates the ototoxic-medication risk factor (cadence half)", () => {
    const profileId = makeProfile("ototoxic-cadence");
    addMedication(profileId, "Furosemide 40 mg");
    // The risk gather resolves the factor from the ototoxic cross-check, so the two
    // can't disagree ("one question, one computation").
    expect(getRiskFactors(profileId).has("ototoxic-medication")).toBe(true);
  });
});
