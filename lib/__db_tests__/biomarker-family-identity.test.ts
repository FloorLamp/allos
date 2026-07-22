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
import {
  biomarkerFamily,
  buildCanonicalIndex,
  snapCanonicalName,
} from "@/lib/canonical-name";
import { reconciledFlag } from "@/lib/reference-range";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { seedProfile, type SeededProfile } from "./fixtures";

const VOCAB = (
  canonicalSeed as { biomarkers: { name: string }[] }
).biomarkers.map((b) => b.name);
const INDEX = buildCanonicalIndex(VOCAB);

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

describe("vitamin-D fractions keep their OWN identity but share the retest clock (#1193)", () => {
  it("a same-date D2/D3/total panel is THREE distinct series, none dedup'd, only the total banded", () => {
    const date = shiftDateStr(p.todayStr, -30);
    // One panel reporting all three on the same date — the exact over-collapse case.
    addReading("Vitamin D, 25-Hydroxy", date, 50);
    addReading("Vitamin D2, 25-Hydroxy", date, 5);
    addReading("Vitamin D3, 25-Hydroxy", date, 45);

    // DEDUP + is_latest/current: THREE distinct current rows (one per fraction/total),
    // never collapsed onto one — a D3 (45) must not dedup against a total (50) on one
    // date, nor mark the whole group "current" off whichever is newest.
    const currentVitD = getMedicalRecords(p.profileId, { current: true }).filter(
      (r) => (r.canonical_name ?? "").toLowerCase().includes("vitamin d")
    );
    expect(currentVitD).toHaveLength(3);
    expect(currentVitD.map((r) => r.canonical_name).sort()).toEqual([
      "Vitamin D, 25-Hydroxy",
      "Vitamin D2, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
    ]);

    // SERIES: each member resolves to its OWN series, not a merged family series.
    expect(
      getBiomarkerSeries(p.profileId, "Vitamin D, 25-Hydroxy").map(
        (r) => r.value_num
      )
    ).toEqual([50]);
    expect(
      getBiomarkerSeries(p.profileId, "Vitamin D2, 25-Hydroxy").map(
        (r) => r.value_num
      )
    ).toEqual([5]);
    expect(
      getBiomarkerSeries(p.profileId, "Vitamin D3, 25-Hydroxy").map(
        (r) => r.value_num
      )
    ).toEqual([45]);

    // BAND: only the TOTAL carries the 30–100 sufficiency band; the fractions carry
    // null bands, so a low D2 (5) never flags "deficient" (adult age).
    expect(canonicalBiomarkerForName("Vitamin D, 25-Hydroxy")?.ref_low).toBe(30);
    expect(canonicalBiomarkerForName("Vitamin D2, 25-Hydroxy")?.ref_low).toBe(
      null
    );
    expect(canonicalBiomarkerForName("Vitamin D3, 25-Hydroxy")?.ref_low).toBe(
      null
    );
    const totalEntry = canonicalBiomarkerForName("Vitamin D, 25-Hydroxy");
    const d2Entry = canonicalBiomarkerForName("Vitamin D2, 25-Hydroxy");
    // A total of 20 flags low (below 30); a D2 of 4 does NOT flag deficient (no band).
    expect(reconciledFlag(null, 20, "ng/mL", totalEntry, null, 40)).toBe("low");
    expect(reconciledFlag(null, 4, "ng/mL", d2Entry, null, 40)).not.toBe("low");
  });

  it("a stored D3 breakdown is NOT flagged overdue when a recent total exists (shared retest clock)", () => {
    // An old D3 fraction alongside a FRESH total — the fractions share the total's
    // redraw clock (biomarkerRetestIdentity), so the fresh total satisfies the whole
    // vitamin-D family and no retest nudge fires.
    addReading("Vitamin D3, 25-Hydroxy", shiftDateStr(p.todayStr, -400), 22);
    addReading("Vitamin D, 25-Hydroxy", shiftDateStr(p.todayStr, -20), 34);
    expect(retestKeys()).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
  });

  it("an imported 1,25-dihydroxy (calcitriol) reading resolves to the new pg/mL entry", () => {
    // A common calcitriol print form snaps onto the new active-metabolite entry,
    // which carries its OWN pg/mL band and its own identity (never the 25-OH family).
    expect(snapCanonicalName("1,25-Dihydroxyvitamin D", INDEX)).toBe(
      "Vitamin D, 1,25-Dihydroxy"
    );
    const calcitriol = canonicalBiomarkerForName("Vitamin D, 1,25-Dihydroxy");
    expect(calcitriol?.unit).toBe("pg/mL");
    expect(calcitriol?.ref_low).toBe(18);
    expect(calcitriol?.ref_high).toBe(72);
    // Its own identity — not folded into the 25-OH storage-form family.
    expect(biomarkerFamily("Vitamin D, 1,25-Dihydroxy")).not.toBe(
      "family:vitamin-d-25-hydroxy"
    );
    // A low calcitriol flags against its OWN band.
    expect(reconciledFlag(null, 10, "pg/mL", calcitriol, null, 40)).toBe("low");
  });

  it("the TOTAL 25-OH spellings still resolve to ONE group (series + starred + retest)", () => {
    const recent = shiftDateStr(p.todayStr, -30);
    const old = shiftDateStr(p.todayStr, -120);
    addReading("Vitamin D, 25-Hydroxy", recent, 34);
    addReading("Vitamin D", old, 22);

    // Both total spellings collapse to one current row and one series.
    const currentVitD = getMedicalRecords(p.profileId, { current: true }).filter(
      (r) => (r.canonical_name ?? "").toLowerCase().includes("vitamin d")
    );
    expect(currentVitD).toHaveLength(1);
    expect(currentVitD[0].canonical_name).toBe("Vitamin D, 25-Hydroxy");
    const viaTotal = getBiomarkerSeries(p.profileId, "Vitamin D, 25-Hydroxy");
    const viaGeneric = getBiomarkerSeries(p.profileId, "Vitamin D");
    expect(viaTotal.map((r) => r.value_num).sort()).toEqual([22, 34]);
    expect(viaGeneric.map((r) => r.id).sort()).toEqual(
      viaTotal.map((r) => r.id).sort()
    );

    // A star on one total spelling lights the star on the other total spelling.
    db.prepare(
      "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    expect(isBiomarkerStarred(p.profileId, "Vitamin D")).toBe(true);

    // RETEST: a fresh total satisfies the family, so no retest nudge fires.
    expect(retestKeys()).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
  });

  it("a starred total member surfaces its newest total SIBLING reading on the tile", () => {
    const old = shiftDateStr(p.todayStr, -120);
    addReading("Vitamin D, 25-Hydroxy", old, 30);
    // Star the total; then a NEWER generic-"Vitamin D" total sibling arrives.
    db.prepare(
      "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    addReading("Vitamin D", shiftDateStr(p.todayStr, -5), 41);

    const star = getStarredBiomarkers(p.profileId).find(
      (s) => s.canonical_name === "Vitamin D, 25-Hydroxy"
    );
    // The tile shows the family's latest reading — the newer total sibling.
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
    // Existing history under one TOTAL spelling, then a fresh reading under a DIFFERENT
    // total spelling — the exact divergence scenario from the issue. (Uses two TOTAL
    // spellings: the D2/D3 fractions are their OWN identity now, #1193.)
    addReading("Vitamin D", shiftDateStr(p.todayStr, -60), 40);
    addReading("Vitamin D, 25-Hydroxy", p.todayStr, 30);

    // Family-keyed count sees BOTH readings (≥ 2) → NOT new, so the gate correctly
    // declines to treat the fresh member as a first-ever reading. A raw-name count
    // would have returned 1 for that literal string — the pre-#504 bug.
    expect(priorReadingCount("Vitamin D, 25-Hydroxy")).toBe(2);
    expect(priorReadingCount("Vitamin D")).toBe(2);

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
