// Shared query boundary for ranked biomarker picker options (#1675). It resolves
// profile facts once, translates family/retest identities onto the candidate
// names, and hands only bucketed sets to the pure biomarker-rank tenant.

import {
  biomarkerFamily,
  biomarkerRetestIdentity,
  normalizeCanonicalKey,
} from "../canonical-name";
import { PHENOAGE_INPUT_ACCEPTED_NAMES } from "../bio-age";
import {
  biomarkerRankKey,
  emptyBiomarkerRankFacts,
  rankBiomarkers,
  type RankedBiomarker,
} from "../biomarker-rank";
import {
  getCanonicalAutocomplete,
  getCurrentFlaggedBiomarkers,
  getMedicalRecords,
} from "./medical";
import { getDerivedCanonicalNames } from "./derived";
import { getSavedItems } from "./saved";
import { getBiomarkerRetestRankSignals } from "./upcoming/generators";

function familyKey(name: string): string {
  return biomarkerFamily(name).toLowerCase();
}

export function getRankedBiomarkerOptions(
  profileId: number,
  today: string,
  scopedNames?: readonly string[]
): RankedBiomarker[] {
  const derivedNames = getDerivedCanonicalNames(profileId);
  const names = scopedNames
    ? [...scopedNames]
    : [...getCanonicalAutocomplete(profileId), ...derivedNames];
  const emptyFacts = emptyBiomarkerRankFacts();
  const due = new Set(emptyFacts.due);
  const dueSoon = new Set(emptyFacts.dueSoon);
  const flagged = new Set(emptyFacts.flagged);
  const measured = new Set(emptyFacts.measured);
  const starred = new Set(emptyFacts.starred);
  const pillar = new Set(emptyFacts.pillar);
  // Every spelling a PhenoAge input accepts, not just the preferred one: the
  // question here is "is this candidate analyte a bio-age pillar input?", and a
  // stored "Glucose" is one even though the input prefers "Glucose, Fasting" (#2334).
  const pillarKeys = new Set(
    PHENOAGE_INPUT_ACCEPTED_NAMES.map(biomarkerRankKey)
  );

  const latest = getMedicalRecords(profileId, { current: true });
  const measuredFamilies = new Set(
    latest.map((row) => familyKey(row.canonical_name?.trim() || row.name))
  );
  const flaggedFamilies = new Set(
    getCurrentFlaggedBiomarkers(profileId).map((row) =>
      familyKey(row.canonicalName?.trim() || row.name)
    )
  );
  const starredFamilies = new Set(
    getSavedItems(profileId, "biomarker").map((item) => familyKey(item.key))
  );
  const retestSignals = getBiomarkerRetestRankSignals(profileId, today);
  const dueRetestIdentities = new Set(
    retestSignals
      .filter((signal) => signal.status === "due")
      .map((signal) => signal.identity)
  );
  const soonRetestIdentities = new Set(
    retestSignals
      .filter((signal) => signal.status === "due-soon")
      .map((signal) => signal.identity)
  );
  const derivedKeys = new Set(derivedNames.map(biomarkerRankKey));

  for (const name of names) {
    const key = biomarkerRankKey(name);
    if (pillarKeys.has(key)) {
      pillar.add(key);
    }
    if (measuredFamilies.has(familyKey(name)) || derivedKeys.has(key)) {
      measured.add(key);
    }
    if (flaggedFamilies.has(familyKey(name))) {
      flagged.add(key);
    }
    if (starredFamilies.has(familyKey(name))) {
      starred.add(key);
    }
    const retestIdentity = biomarkerRetestIdentity(name).toLowerCase();
    if (dueRetestIdentities.has(retestIdentity)) {
      due.add(key);
    } else if (soonRetestIdentities.has(retestIdentity)) {
      dueSoon.add(key);
    }
  }

  return rankBiomarkers(names, {
    due,
    dueSoon,
    flagged,
    measured,
    starred,
    pillar,
  });
}

// The canonical spelling of an analyte a picker offered, or null when the name is
// not in this profile's biomarker vocabulary at all.
//
// The candidate set is EXACTLY the one getRankedBiomarkerOptions ranks — the curated
// canonical vocabulary plus the profile's derived analytes — so "what the picker
// could offer" and "what a write will accept" are one list and cannot drift. A
// biomarker GOAL (#1853) validates its target through this, so a hand-posted name
// can't create a goal anchored on an analyte the app has no series, unit or retest
// cadence for.
//
// Matching is on normalizeCanonicalKey, the ROW identity the pickers dedupe on —
// NOT on biomarkerFamily. Resolving on family would silently re-anchor a goal on
// "Vitamin D3, 25-Hydroxy" to the family's total, when #482 deliberately keeps the
// fractions separately trendable: family is how readings REACH a goal (that happens
// later, in getBiomarkerSeries), not what the goal IS.
export function resolveBiomarkerOptionName(
  profileId: number,
  name: string
): string | null {
  const wanted = normalizeCanonicalKey(name.trim());
  if (!wanted) return null;
  const candidates = [
    ...getCanonicalAutocomplete(profileId),
    ...getDerivedCanonicalNames(profileId),
  ];
  return candidates.find((c) => normalizeCanonicalKey(c) === wanted) ?? null;
}
