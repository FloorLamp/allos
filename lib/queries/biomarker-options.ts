// Shared query boundary for ranked biomarker picker options (#1675). It resolves
// profile facts once, translates family/retest identities onto the candidate
// names, and hands only bucketed sets to the pure biomarker-rank tenant.

import { biomarkerFamily, biomarkerRetestIdentity } from "../canonical-name";
import { PHENOAGE_INPUT_NAMES } from "../bio-age";
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
  const pillarKeys = new Set(PHENOAGE_INPUT_NAMES.map(biomarkerRankKey));

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
