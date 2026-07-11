// DB INTEGRATION TIER — pins the equivalence the #386 performance fix relies on:
// getDerivedBiomarkerReadings now sources every input analyte from ONE deduped
// getAllBiomarkerSeries read (grouped in JS) instead of a per-analyte
// getBiomarkerSeries fan-out. This proves the grouped read yields byte-identical
// per-analyte series to the individual query (including cross-source dedup), and
// that the derived indices computed off it are unchanged — so the fewer scans
// change performance only, never results.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getAllBiomarkerSeries,
  getBiomarkerSeries,
  getDerivedBiomarkerReadings,
} from "@/lib/queries";
import { canonicalGroupKey, groupByCanonicalName } from "@/lib/biomarker-group";
import { db } from "@/lib/db";

const DATE = "2024-05-01";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLab(
  profileId: number,
  canonical: string,
  value: number,
  date = DATE
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, ?, 'mg/dL', ?, ?, 'Lipids')`
  ).run(profileId, date, canonical, String(value), canonical, value);
}

describe("derived-biomarker reads: grouped getAllBiomarkerSeries == per-analyte", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("Derived Cache Test");
    // Two lipid analytes that combine into Non-HDL Cholesterol (Total - HDL),
    // plus a second Total draw on another date and an exact-duplicate Total row
    // (same content-identity) so the dedup window is genuinely exercised.
    insertLab(profileId, "Total Cholesterol", 200);
    insertLab(profileId, "Total Cholesterol", 200); // duplicate → dedups to one
    insertLab(profileId, "HDL Cholesterol", 50);
    insertLab(profileId, "Total Cholesterol", 210, "2024-08-01");
    insertLab(profileId, "HDL Cholesterol", 55, "2024-08-01");
  });

  it("groups getAllBiomarkerSeries into the same series each getBiomarkerSeries returns", () => {
    const grouped = groupByCanonicalName(getAllBiomarkerSeries(profileId));
    for (const name of ["Total Cholesterol", "HDL Cholesterol"]) {
      const perAnalyte = getBiomarkerSeries(profileId, name);
      const fromBulk = grouped.get(canonicalGroupKey(name)) ?? [];
      expect(fromBulk).toEqual(perAnalyte);
    }
    // The duplicate Total row collapsed to one representative in both reads.
    expect(getBiomarkerSeries(profileId, "Total Cholesterol")).toHaveLength(2);
  });

  it("still computes the derived Non-HDL Cholesterol index off the grouped read", () => {
    const derived = getDerivedBiomarkerReadings(profileId);
    const nonHdl = derived.filter((r) => r.name === "Non-HDL Cholesterol");
    // One per lipid draw date; the dedup left a single Total per date.
    expect(
      nonHdl.map((r) => r.value_num).sort((a, b) => (a ?? 0) - (b ?? 0))
    ).toEqual([150, 155]); // 200-50 and 210-55
  });
});
