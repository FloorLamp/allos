// DB INTEGRATION TIER — the #482 biomarker FAMILY identity is ONE grouping used by
// EVERY surface: the cross-source dedup, the is_latest/current marker, the
// chart/detail series, the starred tile, and the retest clock all resolve a family
// member to the SAME group. This is the "same fixture, same answer everywhere" pin
// the repo uses for a shared computation — here proven end-to-end through the real
// query layer, plus the two behaviors the generalization adds: a starred member
// surfaces a sibling reading, and a derived analyte's retest is satisfied by fresh
// inputs. All values are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getMedicalRecords,
  getBiomarkerSeries,
  getStarredBiomarkers,
  isBiomarkerStarred,
  collectUpcoming,
  biomarkerFamilyKey,
} from "@/lib/queries";
import { biomarkerFamily } from "@/lib/canonical-name";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addReading(
  canonical: string,
  date: string,
  value: number,
  unit = "ng/mL"
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'Fam')`
  ).run(p.profileId, date, canonical, String(value), unit, canonical, value);
}

function clearRows() {
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Fam'"
  ).run(p.profileId);
  db.prepare("DELETE FROM starred_biomarkers WHERE profile_id = ?").run(
    p.profileId
  );
}

function retestKeys(): string[] {
  return collectUpcoming(p.profileId, p.todayStr)
    .filter((i) => i.domain === "biomarker")
    .map((i) => i.key);
}

beforeEach(() => {
  p = seedProfile("FAMID");
  clearRows();
});

describe("vitamin-D family resolves to one group on every surface (#482)", () => {
  it("dedup/current, series, starred, and retest all agree on the family", () => {
    const recent = shiftDateStr(p.todayStr, -30);
    const old = shiftDateStr(p.todayStr, -120);
    addReading("Vitamin D, 25-Hydroxy", recent, 34);
    addReading("Vitamin D3, 25-Hydroxy", old, 22);

    // DEDUP + is_latest/current: one current row for the whole family (the newest
    // member, the total), not one per stored name.
    const currentVitD = getMedicalRecords(p.profileId, {
      current: true,
    }).filter((r) =>
      (r.canonical_name ?? "").toLowerCase().includes("vitamin d")
    );
    expect(currentVitD).toHaveLength(1);
    expect(currentVitD[0].canonical_name).toBe("Vitamin D, 25-Hydroxy");

    // SERIES: a request for ANY member returns the WHOLE family's readings, and
    // both members resolve to the identical series.
    const viaTotal = getBiomarkerSeries(p.profileId, "Vitamin D, 25-Hydroxy");
    const viaD3 = getBiomarkerSeries(p.profileId, "Vitamin D3, 25-Hydroxy");
    expect(viaTotal.map((r) => r.value_num).sort()).toEqual([22, 34]);
    expect(viaD3.map((r) => r.id).sort()).toEqual(
      viaTotal.map((r) => r.id).sort()
    );

    // STARRED: a star on the total lights the star on the D3 detail page too.
    db.prepare(
      "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    expect(isBiomarkerStarred(p.profileId, "Vitamin D3, 25-Hydroxy")).toBe(
      true
    );

    // RETEST: a fresh member satisfies the family, so no retest nudge fires.
    expect(retestKeys()).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
  });

  it("a starred member surfaces its newest SIBLING reading on the tile", () => {
    const old = shiftDateStr(p.todayStr, -120);
    addReading("Vitamin D, 25-Hydroxy", old, 30);
    // Star the total; then a NEWER D3 sibling arrives.
    db.prepare(
      "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    addReading("Vitamin D3, 25-Hydroxy", shiftDateStr(p.todayStr, -5), 41);

    const star = getStarredBiomarkers(p.profileId).find(
      (s) => s.canonical_name === "Vitamin D, 25-Hydroxy"
    );
    // The tile shows the family's latest reading — the D3 sibling, not the older
    // total it was pinned on.
    expect(star?.latest_value_num).toBe(41);
    expect(star?.latest_date).toBe(shiftDateStr(p.todayStr, -5));
  });
});

// The supplement-suggest "is this biomarker new" gate counts prior readings by the
// SAME family identity the biomarkers table partitions on (#504) — not the raw name.
// Before the fix it keyed on the literal canonical-or-name, so a fresh reading under a
// DIFFERENT family member's spelling counted as 0 prior readings and was misjudged
// "brand new" (eligible for a first-ever AI supplement suggestion) even when the
// family already had a full trend. This pins that the exact count query the gate runs
// resolves cross-member readings to one family.
describe("supplement-suggest 'new reading' count keys on the family (#504)", () => {
  // Mirrors autoSuggestFromBiomarkers' private count statement.
  function priorReadingCount(name: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM medical_records
             WHERE profile_id = ? AND ${biomarkerFamilyKey()} = ? COLLATE NOCASE`
        )
        .get(p.profileId, biomarkerFamily(name)) as { c: number }
    ).c;
  }

  it("a fresh family member sees the whole family's history, not zero", () => {
    // Existing history under one member's name, then a fresh reading under a DIFFERENT
    // member's spelling — the exact divergence scenario from the issue.
    addReading("Vitamin D2", shiftDateStr(p.todayStr, -60), 40);
    addReading("Vitamin D, 25-Hydroxy", p.todayStr, 30);

    // Family-keyed count sees BOTH readings (≥ 2) → NOT new, so the gate correctly
    // declines to treat the fresh member as a first-ever reading. A raw-name count
    // would have returned 1 for that literal string — the pre-#504 bug.
    expect(priorReadingCount("Vitamin D, 25-Hydroxy")).toBe(2);
    expect(priorReadingCount("Vitamin D2")).toBe(2);

    // An unrelated analyte with a single reading still counts as new (1).
    addReading("Ferritin", p.todayStr, 55, "ng/mL");
    expect(priorReadingCount("Ferritin")).toBe(1);
  });
});

describe("derived-analyte retest is satisfied by fresh inputs (#482 scope 2)", () => {
  it("a stored eGFR is not overdue while its input (Creatinine) is fresh", () => {
    const stale = shiftDateStr(p.todayStr, -800); // past the 365d window
    const fresh = shiftDateStr(p.todayStr, -20);
    addReading("eGFR", stale, 78, "mL/min/1.73m2");
    addReading("Creatinine", fresh, 1.0, "mg/dL");

    // The stored eGFR is old, but re-drawing Creatinine re-derives it, so the clock
    // treats the fresh input as the effective last-tested date — no retest nudge.
    expect(retestKeys()).not.toContain("biomarker:egfr");
  });

  it("a stored eGFR IS overdue when its input is also stale", () => {
    const stale = shiftDateStr(p.todayStr, -800);
    addReading("eGFR", stale, 78, "mL/min/1.73m2");
    addReading("Creatinine", shiftDateStr(p.todayStr, -790), 1.0, "mg/dL");

    expect(retestKeys()).toContain("biomarker:egfr");
  });
});
