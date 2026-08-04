// The runtime half of the ONE judgement lookup (#1996) — lib/metric-judgment.ts
// resolved against a real profile and the seeded canonical vocabulary.
//
// Two reasons it is a query rather than a pure call at the call site:
//
//   • THE VOCABULARY. `canonical_biomarkers` is what boot seeds from the committed
//     dataset, what a re-seed updates, and what the flag reconcile judges rows
//     against. Reading the DB row here is what keeps a metric page's band and the
//     flag stored on a row of the same reading in agreement (#221) — a page that
//     judged against the bundled file could quietly disagree with the row.
//   • THE SUBJECT. Age is taken ON the reading's date, never today (the #150
//     precedent lib/queries/bp-context.ts sets): a band for a 3-year-old must not
//     be applied to a reading taken when they were 1.
//
// Auth-blind and profile-scoped: `profileId` first, no `lib/auth` import.

import { getCanonicalBiomarker } from "./medical/canonical";
import {
  METRIC_KNOWLEDGE,
  metricJudgment,
  type JudgmentEntry,
  type MetricJudgment,
} from "../metric-judgment";
import { readingIdentity } from "../reading-model";
import {
  getUserAge,
  getUserAgeOn,
  getUserReproductiveStatus,
  getUserSex,
} from "../settings";
import type { BodyMetricSlug } from "../trends-body-metrics";

/**
 * The clinical judgement for one metric surface, or null when no knowledge system
 * answers for that metric (see METRIC_KNOWLEDGE, where every slug says which one
 * does or why none can).
 *
 * `value`/`onDate` describe the reading being judged — normally the latest one. The
 * value must be in the identity's CANONICAL unit; every metric with canonical
 * knowledge is charted in that unit already (weight, the one display-unit
 * conversion, has no canonical entry).
 */
export function getMetricJudgment(
  profileId: number,
  slug: BodyMetricSlug,
  value: number | null,
  onDate: string | null
): MetricJudgment | null {
  const knowledge = METRIC_KNOWLEDGE[slug];
  if (knowledge.source !== "canonical") return null;
  const entry = getCanonicalBiomarker(knowledge.canonical) as
    JudgmentEntry | undefined;
  if (!entry) return null;
  return metricJudgment(
    readingIdentity(knowledge.canonical),
    {
      // The subject's age ON the reading's date; today's age only when the
      // reading has no date to be judged as of.
      age: onDate ? getUserAgeOn(profileId, onDate) : getUserAge(profileId),
      sex: getUserSex(profileId),
      status: getUserReproductiveStatus(profileId),
      value,
    },
    [entry]
  );
}
