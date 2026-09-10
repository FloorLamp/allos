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
  getUnreadableDoseAmounts,
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
import { FINDING_DASHBOARD_RELEVANCE, type Finding } from "../findings";

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
// The ONE gather → detect for a profile's structural gaps, leverage-ranked. Shared by
// the dashboard presentation/coaching finding (buildDataQualityFindings) and the household
// rollup (household/page.tsx), so every surface keys on the SAME gap model (one
// question, one computation). No owned SQL added (reads through profile-scoped queries).
export function collectDataQualityGaps(profileId: number): DataQualityGap[] {
  const bioAge = getBioAgeReadings(profileId);
  const smoking = resolveSmoking(
    getSmokingHistory(profileId),
    hasImportedSmokingHistory(profileId)
  );
  const sex = getProfileSex(profileId);
  const unreadableDoses = getUnreadableDoseAmounts(profileId);
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
  };
  return detectDataQualityGaps(inputs);
}

export function buildDataQualityFindings(profileId: number): Finding[] {
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
