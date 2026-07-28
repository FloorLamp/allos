// Shared logical identity for outcomes that can arrive through more than one
// storage vocabulary. New imports project body measurements into body_metrics,
// but older medical_records rows can still carry those canonical names. Pickers
// and protocol persistence use these helpers so one concept has one public key.

import { bodyMetricKind } from "./body-metric-extract";
import { normalizeCanonicalKey } from "./canonical-name";
import type { BodyMetricKind } from "./types";

const PHENOAGE_KEY = normalizeCanonicalKey("PhenoAge");

export function bodyMetricKindForBiomarker(
  canonical: string
): BodyMetricKind | null {
  return bodyMetricKind(canonical, canonical);
}

export function preferredOutcomeKeyForBiomarker(
  canonical: string
): `metric:${BodyMetricKind}` | "index:phenoage" | null {
  const bodyKind = bodyMetricKindForBiomarker(canonical);
  if (bodyKind) return `metric:${bodyKind}`;
  if (normalizeCanonicalKey(canonical) === PHENOAGE_KEY)
    return "index:phenoage";
  return null;
}
