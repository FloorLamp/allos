// Profile-scoped risk-factor gather (issue #517). Reads the EXISTING risk inputs
// — family history, active conditions, and the self-declared occupational/immune
// attributes — and hands them to the pure risk-stratification classifier
// (lib/risk-stratification.ts). Every read here is profile-scoped (the getX it
// calls all filter profile_id; enforced by lib/__tests__/profile-scoping.test.ts).
// Cached per request so the retest generator and the preventive-priority pass
// don't re-gather.

import { cache } from "../../request-cache";
import { deriveRiskFactors, type RiskFactor } from "../../risk-stratification";
import { getRiskAttributes } from "../../settings";
import { getConditions, getFamilyHistory } from "../clinical";

// The profile's active risk-factor set. Family conditions come from every
// family_history row; personal conditions from the ACTIVE conditions only (a
// resolved condition no longer modulates cadence). The occupational/immune
// attributes are the self-declared profile flags.
export const getRiskFactors = cache(function getRiskFactors(
  profileId: number
): Set<RiskFactor> {
  return deriveRiskFactors({
    familyConditions: getFamilyHistory(profileId).map((f) => f.condition),
    activeConditions: getConditions(profileId, { status: "active" }).map(
      (c) => c.name
    ),
    attributes: getRiskAttributes(profileId),
  });
});
