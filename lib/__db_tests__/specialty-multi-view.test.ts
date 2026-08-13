// DB INTEGRATION TIER — the Records › Specialty panes under a multi-profile view
// (issue #2557).
//
// Two things have to hold once Dental and Vision read the view-set:
//   • the LISTS return every profile in view, tagged with the profile each row came
//     from (so stampSubjects can attach subject identity and the row's edit/delete can
//     post its own profile), and exclude an accessible profile that is NOT in view;
//   • the pane GATE agrees with what the lists will show. This is the issue's product
//     call: the data bits fold over the view set ("any member in view has rows"), the
//     life-stage bit does not. The pure fold is unit-tested (records-specialty-nav);
//     what this tier pins is that the GATHER asks the right profiles.
// Synthetic fixtures only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { readForProfiles } from "@/lib/scope";
import { getDentalProcedures, getOpticalPrescriptions } from "@/lib/queries";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function addDental(profileId: number, name: string): void {
  db.prepare(
    `INSERT INTO dental_procedures (profile_id, name, status, procedure_date, source)
     VALUES (?, ?, 'completed', '2026-02-10', NULL)`
  ).run(profileId, name);
}
function addRx(profileId: number, brand: string): void {
  db.prepare(
    `INSERT INTO optical_prescriptions (profile_id, kind, brand, issued_date, source)
     VALUES (?, 'glasses', ?, '2026-02-10', NULL)`
  ).run(profileId, brand);
}

describe("Specialty lists over a multi-profile view-set (#2557)", () => {
  it("dental records come back for every profile in view, tagged, not-in-view excluded", () => {
    const dad = newProfile("Dental Dad");
    const kid = newProfile("Dental Kid");
    const notInView = newProfile("Dental Uncle");
    addDental(dad, "Crown 19");
    addDental(kid, "Sealant 3");
    addDental(notInView, "Should not appear");

    const rows = readForProfiles([dad, kid], (pid) => getDentalProcedures(pid));
    const byName = new Map(rows.map((r) => [r.name, r.profileId]));
    expect(byName.get("Crown 19")).toBe(dad);
    expect(byName.get("Sealant 3")).toBe(kid);
    expect(byName.has("Should not appear")).toBe(false);
  });

  it("optical prescriptions come back for every profile in view, tagged, not-in-view excluded", () => {
    const dad = newProfile("Vision Dad");
    const kid = newProfile("Vision Kid");
    const notInView = newProfile("Vision Uncle");
    addRx(dad, "Frames 21");
    addRx(kid, "Frames 22");
    addRx(notInView, "Frames 23");

    const rows = readForProfiles([dad, kid], (pid) =>
      getOpticalPrescriptions(pid)
    );
    const byBrand = new Map(rows.map((r) => [r.brand, r.profileId]));
    expect(byBrand.get("Frames 21")).toBe(dad);
    expect(byBrand.get("Frames 22")).toBe(kid);
    expect(byBrand.has("Frames 23")).toBe(false);
  });
});

describe("Specialty pane gate follows the VIEW, not the actor (#2557)", () => {
  it("shows Dental and Vision for a caregiver with none of their own, when a member in view has rows", () => {
    const caregiver = newProfile("Gate Caregiver");
    const child = newProfile("Gate Child");
    addDental(child, "Filling 14");
    addRx(child, "Frames 31");

    // Acting alone: nothing of the caregiver's own, so both panes stay hidden.
    expect(
      getRecordsSpecialtyRelevanceForView(caregiver, [caregiver])
    ).toMatchObject({ vision: false, dental: false });

    // With the child in view, both panes are reachable — the pane WILL list rows,
    // which is exactly what the gate is asking about.
    const withChild = getRecordsSpecialtyRelevanceForView(caregiver, [
      caregiver,
      child,
    ]);
    expect(withChild.dental).toBe(true);
    expect(withChild.vision).toBe(true);
  });

  it("stays hidden when nobody in view has rows, and ignores an accessible profile out of view", () => {
    const actor = newProfile("Gate Actor");
    const inView = newProfile("Gate InView");
    const outOfView = newProfile("Gate OutOfView");
    addDental(outOfView, "Extraction 2");
    addRx(outOfView, "Frames 41");

    const relevance = getRecordsSpecialtyRelevanceForView(actor, [
      actor,
      inView,
    ]);
    expect(relevance.dental).toBe(false);
    expect(relevance.vision).toBe(false);
  });

  it("single view answers exactly what the per-profile predicate answers", () => {
    const solo = newProfile("Gate Solo");
    addDental(solo, "Cleaning");

    const relevance = getRecordsSpecialtyRelevanceForView(solo, [solo]);
    expect(relevance.dental).toBe(true);
    expect(relevance.vision).toBe(false);
    // Unknown age → the life-stage bit is permissive (isMinor's positive-match-only
    // policy), and it is read from the ACTING profile, never folded.
    expect(relevance.substanceUse).toBe(true);
  });
});
