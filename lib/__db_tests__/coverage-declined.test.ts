// DB INTEGRATION TIER — #2319's actual deliverable: Coverage candidacy and the
// import debugger consult ONE declaration.
//
//   "No DEXA regional-decomposition label is offered as a Coverage candidate, and
//    each instead states why it is not catalogued."
//
// Run against the real profile-scoped query (`getCoverageCandidacy`) over the real
// curated vocabulary, because the two halves this issue joins are only equal in
// production: Coverage compares `biomarkerCoverageKey` FAMILIES against the
// `source = 'seed'` rows of `canonical_biomarkers`, where the debugger compares
// `isSeededCanonical` on the exact name. Both reach `uncuratedAnalyte`, and the
// contrast rows below are what prove the filter is the DECLARATION and not an
// accident of the vocabulary.
//
// SYNTHETIC ONLY: fictional profiles, fixed deep-past dates, invented values. No PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seedActor } from "@/lib/__action_tests__/harness";
import {
  getCoverageCandidacy,
  getCoverageGapCandidates,
} from "@/lib/queries/coverage";
import { biomarkerCoverageKey } from "@/lib/coverage-gaps";
import { uncuratedAnalyte } from "@/lib/canonical-name";

const DATE = "2019-05-06";

// A DEXA prints its regional decomposition in the `scan` category — which DOES carry
// biomarker identity (#2318 withholds it only from `assessment`), so every one of
// these rows really did reach Coverage as an uncatalogued item.
function addScanRow(profileId: number, canonical: string, value: number): void {
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, value_num, canonical_name)
     VALUES (?, ?, 'scan', ?, ?, ?)`
  ).run(profileId, DATE, canonical, value, canonical);
}

function addLab(profileId: number, canonical: string): void {
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
     VALUES (?, ?, 'lab', ?, 5, 'mg/dL', ?)`
  ).run(profileId, DATE, canonical, canonical);
}

// The regional rows one scan produces, in the spellings a report actually prints.
const DEXA_REGIONAL = [
  "Body Fat Percentage, Left Arm",
  "Body Fat Percentage, Android",
  "Bone Mineral Density, Lumbar Spine",
  "Trunk Fat Mass (g)",
  "Android/Gynoid Ratio",
];
// A genuine curation candidate with a real clinical band, deliberately left for
// #2322. It is the control: it sits on the same profile, in the same category, and
// it MUST still be offered.
const GENUINE_CANDIDATE = "Waist Circumference";

describe("a DEXA regional label is never offered as a Coverage candidate (#2319)", () => {
  it("declines the whole regional family while a genuine gap stays offered", () => {
    const { profile } = seedActor();
    for (const [i, name] of DEXA_REGIONAL.entries())
      addScanRow(profile.id, name, 10 + i);
    addScanRow(profile.id, GENUINE_CANDIDATE, 84);

    const { candidates, declined } = getCoverageCandidacy(profile.id);
    const offered = candidates.map((c) => c.label);
    for (const name of DEXA_REGIONAL) expect(offered, name).not.toContain(name);
    // Detection IS running on this profile — the contrast, not an absence that
    // would hold even if candidacy were broken.
    expect(offered).toContain(GENUINE_CANDIDATE);

    // Each declined row STATES why, which is the half a plain filter would lose.
    const declinedLabels = declined.map((d) => d.label);
    for (const name of DEXA_REGIONAL)
      expect(declinedLabels, name).toContain(name);
    for (const d of declined) {
      expect(d.kind).toBe("biomarker");
      expect(d.declaration.kind).toBe("out-of-scope");
      expect(d.declaration.reason).toContain("per-region decomposition");
    }
    // The two lists are a partition of one set on one identity key (the used-name
    // read orders alphabetically, so compare as sets).
    expect([...declined.map((d) => d.itemKey)].sort()).toEqual(
      DEXA_REGIONAL.map(biomarkerCoverageKey).sort()
    );
    expect(offered.filter((l) => declinedLabels.includes(l))).toEqual([]);
  });

  it("the candidate-only reader agrees with the split", () => {
    const { profile } = seedActor();
    addScanRow(profile.id, DEXA_REGIONAL[0], 11);
    addScanRow(profile.id, GENUINE_CANDIDATE, 84);
    expect(getCoverageGapCandidates(profile.id).map((c) => c.label)).toEqual(
      getCoverageCandidacy(profile.id).candidates.map((c) => c.label)
    );
    expect(getCoverageGapCandidates(profile.id).map((c) => c.label)).toEqual([
      GENUINE_CANDIDATE,
    ]);
  });

  it("keeps the curated whole-body totals a DEXA also prints out of BOTH lists", () => {
    // The regions are declared; the totals they decompose are curated analytes, so
    // they are covered — neither a candidate nor a declination.
    const { profile } = seedActor();
    addScanRow(profile.id, "Body Fat Percentage", 21.4);
    addScanRow(profile.id, "Bone Mineral Density T-Score", -0.4);

    const { candidates, declined } = getCoverageCandidacy(profile.id);
    expect(candidates).toEqual([]);
    expect(declined).toEqual([]);
    expect(uncuratedAnalyte("Body Fat Percentage")).toBeNull();
  });

  it("declines a covered-elsewhere analyte with its instead target", () => {
    // The other declaration shape, on the surface #2313 never reached: a
    // race-branched eGFR read as untracked kidney function until it said otherwise.
    const { profile } = seedActor();
    addLab(profile.id, "eGFR, African American");

    const { candidates, declined } = getCoverageCandidacy(profile.id);
    expect(candidates).toEqual([]);
    expect(declined).toHaveLength(1);
    const d = declined[0].declaration;
    expect(d.kind).toBe("covered-elsewhere");
    expect(d.kind === "covered-elsewhere" && d.instead).toBe(
      "Estimated Glomerular Filtration Rate (eGFR)"
    );
  });

  it("leaves a declared analyte the user ALREADY tracked in their tracked list", () => {
    // User-owned state: the system may stop OFFERING something without deleting a
    // choice somebody made. It just isn't restated as a declination as well.
    const { profile } = seedActor();
    addScanRow(profile.id, DEXA_REGIONAL[0], 11);
    db.prepare(
      "INSERT INTO coverage_gaps (profile_id, kind, item_key, label) VALUES (?, 'biomarker', ?, ?)"
    ).run(profile.id, biomarkerCoverageKey(DEXA_REGIONAL[0]), DEXA_REGIONAL[0]);

    const { candidates, declined } = getCoverageCandidacy(profile.id);
    expect(candidates).toEqual([]);
    expect(declined).toEqual([]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM coverage_gaps WHERE profile_id = ?")
        .get(profile.id)
    ).toEqual({ c: 1 });
  });

  it("never crosses the profile boundary", () => {
    const { profile } = seedActor();
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("DEXA-OTHER")
        .lastInsertRowid
    );
    addScanRow(other, DEXA_REGIONAL[0], 11);
    addScanRow(other, GENUINE_CANDIDATE, 84);

    expect(getCoverageCandidacy(profile.id).declined).toEqual([]);
    expect(getCoverageCandidacy(profile.id).candidates).toEqual([]);
    expect(getCoverageCandidacy(other).declined.map((d) => d.label)).toEqual([
      DEXA_REGIONAL[0],
    ]);
  });
});
