// DB INTEGRATION TIER — the multi-view Biomarkers table (#1331) merges PER-MEMBER
// partitions. The load-bearing invariant proven end-to-end here against the real
// query layer: is_latest / dedup / the reconciled reference-range flag are computed
// in EACH member's OWN profile context, so a shared analyte family (both members
// have "Vitamin D") never collapses two people's readings into one series, and a
// sex-dependent reference range judges each member against their OWN demographics.
// This is the #448 "every builder ships a realistic-fixture DB test" bar applied to
// the multi-view read path. All values are SYNTHETIC (no PHI).
//
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getMedicalRecords, getDerivedBiomarkerReadings, reconcileFlags } from "@/lib/queries";
import { setUserSex } from "@/lib/settings";
import {
  filterDerivedForTable,
  prepareMultiViewTableRecords,
  type WithProfile,
} from "@/lib/derived-table";
import { NON_BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import type { MedicalRecord } from "@/lib/types";

let male: number;
let female: number;

function mkProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name).lastInsertRowid
  );
}

function addReading(
  profileId: number,
  canonical: string,
  date: string,
  value: number,
  unit: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
      )
      .run(profileId, date, canonical, String(value), unit, canonical, value)
      .lastInsertRowid
  );
}

// The exact loop-composed gather the multi-view Section performs: each member's
// stored + derived readings read in ITS OWN profile context, tagged, then merged.
function mergedTable(
  ids: number[],
  opts: { current?: boolean } = {}
): WithProfile<MedicalRecord>[] {
  const stored = ids.flatMap((id) =>
    getMedicalRecords(id, {
      excludeCategories: NON_BIOMARKER_CATEGORIES,
      current: opts.current,
    }).map((r) => ({ ...r, profileId: id }))
  );
  const derived = ids.flatMap((id) =>
    filterDerivedForTable(getDerivedBiomarkerReadings(id), {
      excludeCategories: NON_BIOMARKER_CATEGORIES,
    }).map((r) => ({ ...r, profileId: id }))
  );
  return prepareMultiViewTableRecords(stored, derived, { current: opts.current });
}

beforeAll(() => {
  male = mkProfile("MV Bio Male (e2e)");
  female = mkProfile("MV Bio Female (e2e)");
  setUserSex(male, "male");
  setUserSex(female, "female");

  // Shared "Vitamin D" family, different values AND dates per member. Male's newest
  // is 2024-06; female's newest is 2024-03 — each member's own newest must win.
  addReading(male, "Vitamin D", "2024-01-01", 30, "ng/mL");
  addReading(male, "Vitamin D", "2024-06-01", 55, "ng/mL");
  addReading(female, "Vitamin D", "2024-03-01", 42, "ng/mL");

  // Sex-dependent reference range (Hemoglobin): male 13.5–17.5, female 12–15.5.
  // The SAME 16.5 g/dL value is in-range for the male, HIGH for the female — the
  // per-member-range proof. Reconcile each in its OWN profile context.
  const hbM = addReading(male, "Hemoglobin", "2024-05-01", 16.5, "g/dL");
  const hbF = addReading(female, "Hemoglobin", "2024-05-01", 16.5, "g/dL");
  reconcileFlags(male, [hbM]);
  reconcileFlags(female, [hbF]);
});

describe("multi-view Biomarkers table — per-member partitions (#1331)", () => {
  it("both members' Vitamin D readings survive — a family collapse never crosses members", () => {
    const rows = mergedTable([male, female]);
    const vitD = rows.filter((r) => r.canonical_name === "Vitamin D");
    // 2 male + 1 female = 3 rows; none merged across members.
    expect(vitD.length).toBe(3);
    expect(vitD.filter((r) => r.profileId === male).length).toBe(2);
    expect(vitD.filter((r) => r.profileId === female).length).toBe(1);
  });

  it("is_latest is computed per (member, family) — one member's newest never marks the other's", () => {
    const rows = mergedTable([male, female]);
    const latest = rows.filter(
      (r) => r.canonical_name === "Vitamin D" && r.is_latest === 1
    );
    // Exactly one current Vitamin D per member: the male's June reading and the
    // female's March reading — and the female's older-than-the-male's date does not
    // suppress her own latest.
    expect(latest.length).toBe(2);
    const byMember = new Map(latest.map((r) => [r.profileId, r.date]));
    expect(byMember.get(male)).toBe("2024-06-01");
    expect(byMember.get(female)).toBe("2024-03-01");
  });

  it("`current` keeps each member's own latest Vitamin D", () => {
    const rows = mergedTable([male, female], { current: true }).filter(
      (r) => r.canonical_name === "Vitamin D"
    );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.profileId))).toEqual(
      new Set([male, female])
    );
  });

  it("reference-range flags resolve in each member's OWN demographic context", () => {
    const rows = mergedTable([male, female]);
    const hb = rows.filter((r) => r.canonical_name === "Hemoglobin");
    const flagBy = new Map(hb.map((r) => [r.profileId, r.flag]));
    // Same 16.5 g/dL: normal for the male (13.5–17.5), high for the female (12–15.5).
    expect(flagBy.get(male)).not.toBe("high");
    expect(flagBy.get(female)).toBe("high");
  });

  it("a single-member view yields exactly that member's rows (byte-identical basis)", () => {
    const single = mergedTable([male]);
    const direct = getMedicalRecords(male, {
      excludeCategories: NON_BIOMARKER_CATEGORIES,
    });
    // Same stored readings, same is_latest marks — the multi-view merge over one
    // member is the per-profile reader's own result.
    const vitDSingle = single
      .filter((r) => r.canonical_name === "Vitamin D")
      .map((r) => [r.id, r.is_latest]);
    const vitDDirect = direct
      .filter((r) => r.canonical_name === "Vitamin D")
      .map((r) => [r.id, r.is_latest]);
    expect(new Set(single.map((r) => r.profileId))).toEqual(new Set([male]));
    expect(vitDSingle.sort()).toEqual(vitDDirect.sort());
  });
});
