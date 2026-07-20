// Profile-scoped risk-factor gather (issue #517). Reads the EXISTING risk inputs
// — family history, active conditions, and the self-declared occupational/immune
// attributes — and hands them to the pure risk-stratification classifier
// (lib/risk-stratification.ts). Every read here is profile-scoped (the getX it
// calls all filter profile_id; enforced by lib/__tests__/profile-scoping.test.ts).
// Cached per request so the retest generator and the preventive-priority pass
// don't re-gather.

import { cache } from "../../request-cache";
import { deriveRiskFactors, type RiskFactor } from "../../risk-stratification";
import { getRiskAttributes, getSmokingHistory } from "../../settings";
import { resolveSmoking } from "../../smoking";
import {
  getConditions,
  getFamilyHistory,
  getGenomicVariants,
  hasImportedSmokingHistory,
} from "../clinical";
import { getOtotoxicWarnings } from "../intake";

// The profile's active risk-factor set. Family conditions come from every
// family_history row; personal conditions from the ACTIVE conditions only (a
// resolved condition no longer modulates cadence). The occupational/immune
// attributes are the self-declared profile flags.
export const getRiskFactors = cache(function getRiskFactors(
  profileId: number
): Set<RiskFactor> {
  return deriveRiskFactors({
    // Coded refs, not bare labels (#1030): both tables store code/code_system,
    // so the recognizers run code-first with the stem fallback — a coded-terse
    // row ("DM2" as E11.9) tightens cadence like its verbose twin.
    familyConditions: getFamilyHistory(profileId).map((f) => ({
      name: f.condition,
      code: f.code,
      codeSystem: f.code_system,
    })),
    activeConditions: getConditions(profileId, { status: "active" }).map(
      (c) => ({ name: c.name, code: c.code, codeSystem: c.code_system })
    ),
    attributes: getRiskAttributes(profileId),
    // Resolved smoking status (#706): the structured record wins, else the imported
    // social-history fallback — the SAME resolution the preventive lung/AAA gates
    // use. A `current` status is the periodontal-risk input for the dental cadence.
    smokingStatus: resolveSmoking(
      getSmokingHistory(profileId),
      hasImportedSmokingHistory(profileId)
    ).status,
    // Stored genomic variants (#709) → the hereditary-risk cadence input class (#711).
    // The full rows go in; deriveRiskFactors applies the pathogenic/likely-pathogenic
    // + hereditary-risk gates and the curated gene table, so a predictive-only variant
    // (APOE ε4, Huntington) or a VUS never becomes a factor. Profile-scoped through
    // getGenomicVariants (filters profile_id).
    genomicVariants: getGenomicVariants(profileId).map((v) => ({
      gene: v.gene,
      significance: v.significance,
      result_type: v.result_type,
    })),
    // Active ototoxic medication (#717) → the hearing-screening cadence input. Resolved
    // by the ototoxic cross-check over the shared safety-context gather (active meds), so
    // the cadence factor and the ototoxic finding can't disagree ("one question, one
    // computation"). Profile-scoped through getOtotoxicWarnings; no new SQL.
    ototoxicMedication: getOtotoxicWarnings(profileId).length > 0,
  });
});
