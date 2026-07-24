// DB INTEGRATION TIER — the Tier-1 multi-view flat-list readers (issue #1328).
//
// Two reader styles land in this PR:
//   • SET-BASED (`profile_id IN`): getCareGoalsForProfiles / getGenomicVariantsForProfiles
//     / getImagingStudiesForProfiles — the truly-flat, durable lists.
//   • LOOP-COMPOSED (readForProfiles over a per-profile reader): the deduped clinical
//     lists — here exercised with getConditions, whose cross-document representative-id
//     CTE must stay per-profile.
// Both must (a) return the whole view-set, (b) tag each row with its `profileId` so
// stampSubjects can attach subject identity, and (c) EXCLUDE a profile that's accessible
// but NOT in the view-set (the not-in-view case). Synthetic fixtures only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { readForProfiles } from "@/lib/scope";
import {
  getConditions,
  getCareGoalsForProfiles,
  getGenomicVariantsForProfiles,
  getImagingStudiesForProfiles,
} from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function addCondition(profileId: number, name: string): void {
  db.prepare(
    "INSERT INTO conditions (profile_id, name, status, source) VALUES (?, ?, 'active', NULL)"
  ).run(profileId, name);
}
function addCareGoal(profileId: number, description: string): void {
  db.prepare(
    "INSERT INTO care_goals (profile_id, description) VALUES (?, ?)"
  ).run(profileId, description);
}
function addVariant(profileId: number, gene: string): void {
  db.prepare(
    "INSERT INTO genomic_variants (profile_id, gene, result_type) VALUES (?, ?, 'pharmacogenomic')"
  ).run(profileId, gene);
}
function addStudy(profileId: number, region: string, date: string): void {
  db.prepare(
    "INSERT INTO imaging_studies (profile_id, modality, body_region, study_date) VALUES (?, 'ct', ?, ?)"
  ).run(profileId, region, date);
}

describe("Tier-1 multi-view readers over a multi-profile view-set (#1328)", () => {
  it("readForProfiles (loop): getConditions across the view-set, tagged + not-in-view excluded", () => {
    const dad = newProfile("Dad");
    const mia = newProfile("Mia");
    const notInView = newProfile("Uncle");
    addCondition(dad, "Hypertension");
    addCondition(mia, "Asthma");
    addCondition(notInView, "Should not appear");

    const rows = readForProfiles([dad, mia], (pid) => getConditions(pid));
    const byProfile = new Map(rows.map((r) => [r.name, r.profileId]));
    expect(byProfile.get("Hypertension")).toBe(dad);
    expect(byProfile.get("Asthma")).toBe(mia);
    // Not-in-view profile is absent.
    expect(rows.some((r) => r.name === "Should not appear")).toBe(false);
    // Every row carries a profileId in the requested set.
    expect(rows.every((r) => r.profileId === dad || r.profileId === mia)).toBe(
      true
    );
  });

  it("getCareGoalsForProfiles (set-based) returns the view-set, tagged, excluding not-in-view", () => {
    const a = newProfile("A");
    const b = newProfile("B");
    const c = newProfile("C");
    addCareGoal(a, "A1c < 7");
    addCareGoal(b, "BP < 130/80");
    addCareGoal(c, "hidden goal");

    const rows = getCareGoalsForProfiles([a, b]);
    expect(rows.map((r) => r.description).sort()).toEqual([
      "A1c < 7",
      "BP < 130/80",
    ]);
    expect(rows.find((r) => r.description === "A1c < 7")?.profileId).toBe(a);
    expect(rows.some((r) => r.description === "hidden goal")).toBe(false);
  });

  it("getGenomicVariantsForProfiles (set-based) returns the view-set, tagged, excluding not-in-view", () => {
    const a = newProfile("GA");
    const b = newProfile("GB");
    const c = newProfile("GC");
    addVariant(a, "CYP2C19");
    addVariant(b, "CYP2D6");
    addVariant(c, "TPMT");

    const rows = getGenomicVariantsForProfiles([a, b]);
    expect(rows.map((r) => r.gene).sort()).toEqual(["CYP2C19", "CYP2D6"]);
    expect(rows.find((r) => r.gene === "CYP2C19")?.profileId).toBe(a);
    expect(rows.some((r) => r.gene === "TPMT")).toBe(false);
  });

  it("getImagingStudiesForProfiles (set-based) returns the view-set, tagged, excluding not-in-view, contrast as boolean", () => {
    const a = newProfile("IA");
    const b = newProfile("IB");
    const c = newProfile("IC");
    addStudy(a, "chest", "2026-01-01");
    addStudy(b, "abdomen", "2026-02-01");
    addStudy(c, "head", "2026-03-01");

    const rows = getImagingStudiesForProfiles([a, b]);
    expect(rows.map((r) => r.body_region).sort()).toEqual(["abdomen", "chest"]);
    expect(rows.find((r) => r.body_region === "chest")?.profileId).toBe(a);
    expect(rows.some((r) => r.body_region === "head")).toBe(false);
    // contrast is surfaced as a boolean, not the stored 0/1.
    expect(typeof rows[0].contrast).toBe("boolean");
  });

  it("an empty view-set returns nothing (never everything)", () => {
    const a = newProfile("EA");
    addCareGoal(a, "orphan");
    expect(getCareGoalsForProfiles([])).toEqual([]);
    expect(getGenomicVariantsForProfiles([])).toEqual([]);
    expect(getImagingStudiesForProfiles([])).toEqual([]);
  });
});
