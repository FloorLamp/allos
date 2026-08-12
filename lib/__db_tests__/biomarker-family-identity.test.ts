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
  getClinicalObservations,
  getBiomarkerSeries,
  getSavedBiomarkers,
  isBiomarkerSaved,
  collectUpcoming,
  biomarkerFamilyKey,
} from "@/lib/queries";
import {
  BIOMARKER_FAMILIES,
  biomarkerFamily,
  buildCanonicalIndex,
  snapCanonicalName,
} from "@/lib/canonical-name";
import { reconciledFlag } from "@/lib/reference-range";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import type { CanonicalResultDefinition } from "@/lib/types";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { seedProfile, type SeededProfile } from "./fixtures";

// The committed JSON is the seed for CanonicalResultDefinition rows; treat it as such for the
// reconciledFlag() calls below, which take the full CanonicalRanges shape (the same
// cast the sibling biomarker-loinc test uses — the dataset's CanonicalBiomarkerEntry
// omits the sex-specific optimal_* fields CanonicalRanges now Picks).
const CB_ROWS = (canonicalSeed as { biomarkers: unknown[] })
  .biomarkers as CanonicalResultDefinition[];
const cbByName = new Map<string, CanonicalResultDefinition>(
  CB_ROWS.map((b) => [b.name.toLowerCase(), b])
);
const cbRanges = (name: string): CanonicalResultDefinition | null =>
  cbByName.get(name.toLowerCase()) ?? null;

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
  db.prepare("DELETE FROM saved_items WHERE profile_id = ?").run(p.profileId);
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
    const currentVitD = getClinicalObservations(p.profileId, {
      current: true,
    }).filter((r) =>
      (r.canonical_name ?? "").toLowerCase().includes("vitamin d")
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
    expect(canonicalBiomarkerForName("Vitamin D, 25-Hydroxy")?.ref_low).toBe(
      30
    );
    expect(canonicalBiomarkerForName("Vitamin D2, 25-Hydroxy")?.ref_low).toBe(
      null
    );
    expect(canonicalBiomarkerForName("Vitamin D3, 25-Hydroxy")?.ref_low).toBe(
      null
    );
    const totalEntry = cbRanges("Vitamin D, 25-Hydroxy");
    const d2Entry = cbRanges("Vitamin D2, 25-Hydroxy");
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
    const calcitriol = cbRanges("Vitamin D, 1,25-Dihydroxy");
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
    const currentVitD = getClinicalObservations(p.profileId, {
      current: true,
    }).filter((r) =>
      (r.canonical_name ?? "").toLowerCase().includes("vitamin d")
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
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    expect(isBiomarkerSaved(p.profileId, "Vitamin D")).toBe(true);

    // RETEST: a fresh total satisfies the family, so no retest nudge fires.
    expect(retestKeys()).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
  });

  it("a starred total member surfaces its newest total SIBLING reading on the tile", () => {
    const old = shiftDateStr(p.todayStr, -120);
    addReading("Vitamin D, 25-Hydroxy", old, 30);
    // Star the total; then a NEWER generic-"Vitamin D" total sibling arrives.
    db.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', 'Vitamin D, 25-Hydroxy')"
    ).run(p.profileId);
    addReading("Vitamin D", shiftDateStr(p.todayStr, -5), 41);

    const star = getSavedBiomarkers(p.profileId).find(
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
  // The kidney index's canonical entry, and the retest key derived from it. Both are
  // the "Long Name (ABBR)" spelling since #2335 — and the key is the LOWERCASED name,
  // so it moves with the rename. Storing the retired bare "eGFR" here would have gone
  // on passing the first assertion while proving nothing (no entry of that name, so
  // no retest clock either).
  const EGFR = "Estimated Glomerular Filtration Rate (eGFR)";
  const EGFR_KEY = `biomarker:${EGFR.toLowerCase()}`;

  it("a stored eGFR is not overdue while its input (Creatinine) is fresh", () => {
    const stale = shiftDateStr(p.todayStr, -800); // past the 365d window
    const fresh = shiftDateStr(p.todayStr, -20);
    addReading(EGFR, stale, 78, "mL/min/1.73m2");
    addReading("Creatinine", fresh, 1.0, "mg/dL");

    // The stored eGFR is old, but re-drawing Creatinine re-derives it, so the clock
    // treats the fresh input as the effective last-tested date — no retest nudge.
    expect(retestKeys()).not.toContain(EGFR_KEY);
  });

  it("a stored eGFR IS overdue when its input is also stale", () => {
    const stale = shiftDateStr(p.todayStr, -800);
    addReading(EGFR, stale, 78, "mL/min/1.73m2");
    addReading("Creatinine", shiftDateStr(p.todayStr, -790), 1.0, "mg/dL");

    expect(retestKeys()).toContain(EGFR_KEY);
  });
});

// ---------------------------------------------------------------------------
// #1401 — the SQL family key must realize the family's `match` matcher, not just
// its enumerated member list. A stored display name caught ONLY by the regex was a
// family member to every JS surface (star, retest clock, dismissal key) and its OWN
// singleton to the dedup / is_latest SQL, so the same measurement double-counted on
// one date and could be marked "current" twice. The key now calls the ONE pure
// biomarkerFamily() through the biomarker_family() user function, so the two halves
// agree on EVERY name rather than only the enumerated ones.
// ---------------------------------------------------------------------------
describe("the SQL family key honours a family's match matcher (#1401)", () => {
  // An A1c spelling `isA1cFamily` catches, that NO family enumerates and that
  // snapCanonicalName leaves untouched — the escape the issue reports. Synthetic.
  const FREEFORM = "HbA1c (Whole Blood)";

  function a1cRows(rows: { canonical_name: string | null }[]) {
    return rows.filter((r) =>
      (r.canonical_name ?? "").toLowerCase().includes("a1c")
    );
  }

  // The SQL family key over a stored row's display name — the exact expression the
  // dedup / is_latest partitions use.
  function sqlFamilyKeyOf(canonical: string): string | null {
    return (
      db
        .prepare(
          `SELECT ${biomarkerFamilyKey()} AS k FROM medical_records
             WHERE profile_id = ? AND canonical_name = ?`
        )
        .get(p.profileId, canonical) as { k: string | null }
    ).k;
  }

  it("the fixture name really is match-only (unsnapped and un-enumerated)", () => {
    // If a later change enumerates or snaps this spelling the test stops proving
    // anything, so pin the premise: the vocabulary leaves it alone and no family's
    // member list contains it — yet JS still folds it into the A1c family.
    expect(snapCanonicalName(FREEFORM, INDEX)).toBe(FREEFORM);
    const enumerated = BIOMARKER_FAMILIES.flatMap((f) => f.members);
    expect(enumerated).not.toContain(FREEFORM.toLowerCase());
    expect(biomarkerFamily(FREEFORM)).toBe("family:hemoglobin-a1c");
  });

  it("SQL resolves it to the SAME family identity the JS surfaces do", () => {
    addReading(FREEFORM, shiftDateStr(p.todayStr, -10), 6.1, "%");
    addReading("Hemoglobin A1c", shiftDateStr(p.todayStr, -40), 6.0, "%");
    expect(sqlFamilyKeyOf(FREEFORM)).toBe(biomarkerFamily(FREEFORM));
    expect(sqlFamilyKeyOf(FREEFORM)).toBe(sqlFamilyKeyOf("Hemoglobin A1c"));
    // A non-family analyte still falls through to its own display name — byte-for-
    // byte the pre-family grouping, so nothing outside a family moved.
    addReading("Ferritin", p.todayStr, 55);
    expect(sqlFamilyKeyOf("Ferritin")).toBe("Ferritin");
  });

  it("a same-date canonical + match-only pair is ONE reading, not a double count", () => {
    // The failure scenario: one draw, printed twice — once under the canonical name
    // and once under a freeform spelling. Same date, value and unit, so this is one
    // measurement and cross-source dedup must collapse it.
    const date = shiftDateStr(p.todayStr, -10);
    addReading("Hemoglobin A1c", date, 6.1, "%");
    addReading(FREEFORM, date, 6.1, "%");
    expect(a1cRows(getClinicalObservations(p.profileId))).toHaveLength(1);
    expect(
      a1cRows(getClinicalObservations(p.profileId, { current: true }))
    ).toHaveLength(1);
  });

  it("a same-date pair with DIFFERENT values stays visible but marks ONE current", () => {
    // Different values on one date is a genuine conflict, never silently merged —
    // both rows stay listed — but only ONE can be the family's current reading.
    const date = shiftDateStr(p.todayStr, -10);
    addReading("Hemoglobin A1c", date, 6.1, "%");
    addReading(FREEFORM, date, 6.4, "%");
    expect(a1cRows(getClinicalObservations(p.profileId))).toHaveLength(2);
    const current = a1cRows(
      getClinicalObservations(p.profileId, { current: true })
    );
    expect(current).toHaveLength(1);
  });

  it("the star store and the readings agree about it too", () => {
    // The cross-surface half of the bug: the star folded the freeform spelling into
    // the family while the SQL join keyed it as a singleton, so the tile and the
    // "current reading" pointed at different rows.
    addReading(FREEFORM, shiftDateStr(p.todayStr, -5), 6.3, "%");
    db.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', 'Hemoglobin A1c')"
    ).run(p.profileId);
    expect(isBiomarkerSaved(p.profileId, FREEFORM)).toBe(true);
    const star = getSavedBiomarkers(p.profileId).find(
      (s) => s.canonical_name === "Hemoglobin A1c"
    );
    expect(star?.latest_value_num).toBe(6.3);
  });
});

// ---------------------------------------------------------------------------
// #1394/#1395 — the retest CLOCK grouped by family while the retest INTERVAL was
// looked up by the representative row's raw name. Labs report HbA1c and its eAG
// re-expression on one draw; the eAG line lands with the higher id and becomes the
// family's representative; the curated dataset has no eAG entry — so a diabetic's
// quarterly A1c silently fell to the flat 365-day default and the nudge went quiet.
// ---------------------------------------------------------------------------
describe("the A1c retest clock and interval key on the same identity (#1394/#1395)", () => {
  function biomarkerItem(key: string) {
    return collectUpcoming(p.profileId, p.todayStr).find((i) => i.key === key);
  }
  const A1C_KEY = "biomarker:family:hemoglobin-a1c";

  // A1c 7.2% plus its eAG re-expression on one draw. eAG is inserted SECOND, so it
  // carries the higher id and wins the family's "newest wins, id breaks the tie"
  // representative rule — the condition the bug needs. Synthetic values.
  function addOneDraw(date: string) {
    addReading("Hemoglobin A1c", date, 7.2, "%");
    addReading("Estimated Average Glucose", date, 160, "mg/dL");
  }

  it("an eAG-representative family still nudges on the 90-day A1c clock", () => {
    const date = shiftDateStr(p.todayStr, -120); // stale at 90d, fresh at 365d
    addOneDraw(date);
    // Premise: the family's representative really is the eAG line, whose name the
    // curated dataset does not carry.
    const current = getClinicalObservations(p.profileId, {
      current: true,
    }).filter(
      (r) =>
        biomarkerFamily(r.canonical_name ?? r.name) === "family:hemoglobin-a1c"
    );
    expect(current).toHaveLength(1);
    expect(current[0].canonical_name).toBe("Estimated Average Glucose");

    const item = biomarkerItem(A1C_KEY);
    expect(item).toBeDefined();
    // The family's curated cadence, not the flat 365-day fallback.
    expect(item!.dueDate).toBe(shiftDateStr(date, 90));
    // …and the line names the family's anchor, so the title doesn't drift with
    // whichever member happens to be newest (the key never did).
    expect(item!.title).toBe("Retest Hemoglobin A1c");
  });

  it("stays quiet inside the 90-day window", () => {
    addOneDraw(shiftDateStr(p.todayStr, -30));
    expect(biomarkerItem(A1C_KEY)).toBeUndefined();
  });

  it("reads the same clock when the lab reported ONLY the eAG line", () => {
    const date = shiftDateStr(p.todayStr, -120);
    addReading("Estimated Average Glucose", date, 160, "mg/dL");
    const item = biomarkerItem(A1C_KEY);
    expect(item).toBeDefined();
    expect(item!.dueDate).toBe(shiftDateStr(date, 90));
  });

  it("does not leak the A1c clock onto a neighbouring glucose analyte", () => {
    // A plain fasting glucose is NOT the A1c family — it keeps its own 180d cadence,
    // its own key, and its own title.
    const date = shiftDateStr(p.todayStr, -200);
    addReading("Glucose, Fasting", date, 96, "mg/dL");
    const item = biomarkerItem("biomarker:glucose, fasting");
    expect(item).toBeDefined();
    expect(item!.dueDate).toBe(shiftDateStr(date, 180));
    expect(item!.title).toBe("Retest Glucose, Fasting");
    expect(biomarkerItem(A1C_KEY)).toBeUndefined();
  });
});
