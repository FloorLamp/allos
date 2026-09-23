// Structural data-quality rule findings (#2962).
//
// The setup-shaped half of the collection: gaps in the profile's own configuration
// rather than observations about its days. One gather feeds both the coaching finding
// and the household rollup, so every surface keys on the same gap model.

import {
  getProfileSex,
  getProfileAge,
  getProfileReproductiveStatus,
  getSmokingHistory,
  getRiskAttributesReviewed,
} from "../settings";
import {
  getMedicationsMissingRxcuiCount,
  getMedicationMissingRxcuiSoleId,
  getFailedExtractionDocumentCount,
  getIntakeDataQualityRows,
  getLatestMetricSample,
  getBioAgeReadings,
  hasImportedSmokingHistory,
  countPrescribersNeedingLink,
} from "../queries";
import { resolveSmoking } from "../smoking";
import { PHENOAGE_INPUT_COUNT, PHENOAGE_INPUT_NAMES } from "../bio-age";
import {
  detectDataQualityGaps,
  dataQualityDedupeKey,
  type DataQualityInputs,
  type DataQualityGap,
} from "../data-quality";
import {
  FINDING_DASHBOARD_RELEVANCE,
  type RollupOnlyFinding,
} from "../findings";

// ---- Structural data-quality gaps (#1045) ----------------------------------

// The builder for the structural data-quality gaps: it GATHERS the profile's
// structural inputs (the #448 builder shape) and hands them to the pure detectors
// (lib/data-quality.ts), then maps each gap into the shared Finding envelope. Reuses
// the EXISTING computations everywhere — lib/bio-age input-completeness (never a
// second bio-age math), resolveSmoking (the same tri-state the preventive gates read),
// getLatestMetricSample for height — so a gap and the surface it degrades can't
// disagree. COACHING tier ONLY (#449): it joins collectCoachingFindings, its dedupeKey
// (`data-quality:<gap>`, DATA_QUALITY_PREFIX registered) rides the shared suppression
// bus, and it NEVER notifies / never reaches the hero. STRUCTURAL, one-time gaps only
// — never behavioral nagging (the hard boundary in lib/data-quality's header). No owned
// SQL is added here (reads through profile-scoped queries), so the scoping guard holds.
// The ONE gather → detect for a profile's structural gaps, leverage-ranked, behind the
// dashboard presentation/coaching finding (buildDataQualityFindings). No owned SQL
// added (reads through profile-scoped queries).
export function collectDataQualityGaps(profileId: number): DataQualityGap[] {
  const bioAge = getBioAgeReadings(profileId);
  const smoking = resolveSmoking(
    getSmokingHistory(profileId),
    hasImportedSmokingHistory(profileId)
  );
  const sex = getProfileSex(profileId);
  // ONE pass over the intake rows for all three intake-shaped gaps (#3320, #5285):
  // Home's Setup section runs outside the read snapshot, so a second reader would be a
  // second execution of the item and dose reads rather than a cache hit.
  const intakeRows = getIntakeDataQualityRows(profileId);
  const unreadableDoses = intakeRows.unreadableAmounts;
  const inputs: DataQualityInputs = {
    age: getProfileAge(profileId),
    sexKnown: sex !== null,
    sex,
    reproductiveStatusKnown: getProfileReproductiveStatus(profileId) !== null,
    heightKnown: getLatestMetricSample(profileId, "height_cm") !== null,
    smokingKnown: smoking.source !== null,
    medsMissingRxcui: getMedicationsMissingRxcuiCount(profileId),
    medMissingRxcuiId: getMedicationMissingRxcuiSoleId(profileId),
    prescribersNeedingLink: countPrescribersNeedingLink(profileId),
    phenoAgePresentCount: bioAge.presentInputs.length,
    phenoAgeMissingCount: PHENOAGE_INPUT_COUNT - bioAge.presentInputs.length,
    // The first missing analyte in checklist order — the #662 add-form prefill
    // target for the phenoage CTA (#1146). Null when the panel is complete.
    phenoAgeMissingPrimary:
      PHENOAGE_INPUT_NAMES.find((n) => !bioAge.presentInputs.includes(n)) ??
      null,
    failedExtractions: getFailedExtractionDocumentCount(profileId),
    riskAttributesReviewed: getRiskAttributesReviewed(profileId),
    // Legacy dose amounts nothing can read (#3320). Gathered as the affected ROWS so
    // the detector can name both the count and the surface to fix them on; the read
    // owns no SQL (it projects the cached, profile-scoped intake reads).
    unreadableDoseAmounts: unreadableDoses.length,
    unreadableDoseAmountItem: unreadableDoses[0]
      ? { id: unreadableDoses[0].itemId, kind: unreadableDoses[0].kind }
      : null,
    // The two #5285 setup rows, from the same already-cached item/dose reads the
    // unreadable-amount gather above takes: an obligation whose schedule states no
    // time, and one the curated PRN registry knows as an as-needed product. Same
    // arrangement, same reason — the rules live in `stackSchedule` / `prnDefaultsFor`
    // and the read owns no SQL of its own.
    unscheduledObligations: intakeRows.unscheduled.length,
    unscheduledObligationItem: intakeRows.unscheduled[0] ?? null,
    obligationMismatches: intakeRows.obligationMismatch.length,
    obligationMismatchItem: intakeRows.obligationMismatch[0] ?? null,
  };
  return detectDataQualityGaps(inputs);
}

export function buildDataQualityFindings(
  profileId: number
): RollupOnlyFinding[] {
  return collectDataQualityGaps(profileId).map((gap) => ({
    domain: "data-quality",
    dedupeKey: dataQualityDedupeKey(gap.key),
    title: gap.label,
    detail: gap.whyLine,
    // Calm, structural FYI — never an alarm, never a push (coaching tier).
    tone: "info",
    dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
    evidence: `Unblocks ${gap.leverage} ${gap.leverage === 1 ? "engine" : "engines"} once fixed.`,
    actionHref: gap.ctaHref,
    actionLabel: "Fix it",
  }));
}
