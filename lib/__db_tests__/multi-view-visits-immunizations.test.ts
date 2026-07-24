// DB INTEGRATION TIER — the Tier-1b bespoke-list multi-view readers (issue #1359).
//
// Two flat SUB-lists of otherwise-bespoke surfaces adopt multi-view in #1359, both
// LOOP-COMPOSED (readForProfiles over a per-profile reader whose cross-document dedup
// CTE must stay per-profile):
//   • Visits → the "Past" encounters list  (readForProfiles + getEncounters)
//   • Immunizations → the "All recorded doses" list (readForProfiles + getImmunizations)
// Each must (a) return the whole view-set, (b) tag each row with its `profileId` so
// stampSubjects can attach subject identity, and (c) EXCLUDE a profile that's accessible
// but NOT in the view-set (the not-in-view case).
//
// Immunizations additionally guards the per-profile-context trap (#1096/#1359): the
// "Dose N of M" sequence label is a PER-MEMBER computation — numbering the flat merged
// list would commingle two members' series. This tier pins that partitioning yields
// each member an INDEPENDENT sequence (the exact per-subject merge ImmunizationHistory
// applies). Synthetic fixtures only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { readForProfiles } from "@/lib/scope";
import { getEncounters, getImmunizations } from "@/lib/queries";
import { resolveDoseLabelsByVaccine } from "@/lib/immunization-status";
import type { Immunization } from "@/lib/types";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function addEncounter(profileId: number, type: string, date: string): void {
  db.prepare(
    "INSERT INTO encounters (profile_id, date, type, source) VALUES (?, ?, ?, NULL)"
  ).run(profileId, date, type);
}
function addImmunization(
  profileId: number,
  vaccine: string,
  date: string
): void {
  db.prepare(
    "INSERT INTO immunizations (profile_id, vaccine, date, source) VALUES (?, ?, ?, NULL)"
  ).run(profileId, vaccine, date);
}

describe("Tier-1b multi-view readers over a multi-profile view-set (#1359)", () => {
  it("readForProfiles (loop): getEncounters across the view-set, tagged + not-in-view excluded", () => {
    const dad = newProfile("Dad");
    const mia = newProfile("Mia");
    const notInView = newProfile("Uncle");
    addEncounter(dad, "Annual physical", "2026-03-01");
    addEncounter(mia, "Well-child visit", "2026-04-01");
    addEncounter(notInView, "Should not appear", "2026-05-01");

    const rows = readForProfiles([dad, mia], (pid) => getEncounters(pid));
    const byType = new Map(rows.map((r) => [r.type, r.profileId]));
    expect(byType.get("Annual physical")).toBe(dad);
    expect(byType.get("Well-child visit")).toBe(mia);
    // Not-in-view profile is absent.
    expect(rows.some((r) => r.type === "Should not appear")).toBe(false);
    // Every row carries a profileId in the requested set.
    expect(rows.every((r) => r.profileId === dad || r.profileId === mia)).toBe(
      true
    );
  });

  it("readForProfiles (loop): getImmunizations across the view-set, tagged + not-in-view excluded", () => {
    const dad = newProfile("IDad");
    const mia = newProfile("IMia");
    const notInView = newProfile("IUncle");
    addImmunization(dad, "influenza", "2026-01-10");
    addImmunization(mia, "mmr", "2026-02-10");
    addImmunization(notInView, "hepb", "2026-03-10");

    const rows = readForProfiles([dad, mia], (pid) => getImmunizations(pid));
    const byVaccine = new Map(rows.map((r) => [r.vaccine, r.profileId]));
    expect(byVaccine.get("influenza")).toBe(dad);
    expect(byVaccine.get("mmr")).toBe(mia);
    expect(rows.some((r) => r.vaccine === "hepb")).toBe(false);
    expect(rows.every((r) => r.profileId === dad || r.profileId === mia)).toBe(
      true
    );
  });

  it("dose-sequence labels are PER-MEMBER: partitioning by profile keeps each member's series independent (the #1096 per-profile-context trap)", () => {
    // Two members each with their own two-dose HepB series. Numbering the FLAT merged
    // list would produce doses 1..4; the per-subject partition ImmunizationHistory
    // applies must number each member 1..2.
    const a = newProfile("SeqA");
    const b = newProfile("SeqB");
    addImmunization(a, "hepb", "2026-01-01");
    addImmunization(a, "hepb", "2026-06-01");
    addImmunization(b, "hepb", "2026-02-01");
    addImmunization(b, "hepb", "2026-07-01");

    const rows = readForProfiles([a, b], (pid) => getImmunizations(pid));

    // The exact per-subject merge the client component does: partition by profileId,
    // number within each member's own history, merge (ids are globally unique).
    const merged = new Map<number, string>();
    const byProfile = new Map<
      number,
      (Immunization & { profileId: number })[]
    >();
    for (const r of rows) {
      const list = byProfile.get(r.profileId);
      if (list) list.push(r);
      else byProfile.set(r.profileId, [r]);
    }
    for (const group of byProfile.values())
      for (const [id, label] of resolveDoseLabelsByVaccine(group))
        merged.set(id, label);

    // Each member has exactly one "Dose 1" and one "Dose 2" — not a shared 1..4 run.
    const dose1s = [...merged.values()].filter((l) => l.startsWith("Dose 1"));
    const dose2s = [...merged.values()].filter((l) => l.startsWith("Dose 2"));
    expect(dose1s).toHaveLength(2);
    expect(dose2s).toHaveLength(2);
    expect([...merged.values()].some((l) => /Dose [34]/.test(l))).toBe(false);
  });

  it("a single-view read (ids = [acting]) yields exactly the per-profile reader's rows", () => {
    const solo = newProfile("Solo");
    addEncounter(solo, "Solo visit", "2026-08-01");
    addImmunization(solo, "tdap", "2026-08-02");
    const enc = readForProfiles([solo], (pid) => getEncounters(pid));
    const imm = readForProfiles([solo], (pid) => getImmunizations(pid));
    expect(enc.map((r) => r.type)).toEqual(
      getEncounters(solo).map((r) => r.type)
    );
    expect(imm.map((r) => r.vaccine)).toEqual(
      getImmunizations(solo).map((r) => r.vaccine)
    );
    expect(enc.every((r) => r.profileId === solo)).toBe(true);
    expect(imm.every((r) => r.profileId === solo)).toBe(true);
  });
});
