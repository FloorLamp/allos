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
import { flagReconcileProfileContext } from "./medical/flags";
import { cyclePhaseOnDate } from "../cycle";
import { ageForRecord } from "../flag-reconcile";
import {
  METRIC_KNOWLEDGE,
  metricJudgment,
  type JudgmentEntry,
  type MetricJudgment,
} from "../metric-judgment";
import { readingIdentity } from "../reading-model";
import {
  getProfileAge,
  getProfileAgeOn,
  getProfileReproductiveStatus,
  getProfileSex,
} from "../settings";
import type { TrendMetricSlug } from "../trend-metrics";

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
  slug: TrendMetricSlug,
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
      age: onDate
        ? getProfileAgeOn(profileId, onDate)
        : getProfileAge(profileId),
      sex: getProfileSex(profileId),
      status: getProfileReproductiveStatus(profileId),
      value,
    },
    [entry]
  );
}

/**
 * A stored reading, as the judgement lookup reads it. Deliberately the SAME three
 * fields the flag reconcile keys on — the resolved name, the collection date — so
 * a row cannot be judged here against context the flag was not judged against.
 */
export interface JudgedObservation {
  canonical_name?: string | null;
  name: string;
  date?: string | null;
}

/**
 * The judgement for each of a profile's stored readings, positionally (#2315).
 *
 * This is the READ half of "the row states the band its flag came from". It goes
 * through `flagReconcileProfileContext` — the same canonical map, the same
 * alias-aware name resolver, and the same subject context (sex, birthdate/stored
 * age, reproductive status, cycle log) that `reconcileFlags` derived the stored
 * flag with — so the bands a row prints are, by construction, the bands that
 * judged it. Per row it then applies the two axes that are PER-RECORD rather than
 * per-profile: the subject's age ON the collection date (#150) and their cycle
 * phase on that date (#718).
 *
 * Returns `null` in a slot when no canonical entry covers the analyte, or when the
 * entry states no numeric band — the caller renders the lab's printed string for
 * those, which is genuinely the deciding range there.
 *
 * No `value` is supplied: the row already carries its stored flag, and the surface
 * renders THAT (via `flagLabel`) rather than a second verdict computed here. The
 * returned `badge` is therefore "unknown" by design.
 *
 * Auth-blind and profile-scoped: `profileId` first, no `lib/auth` import. A
 * multi-profile caller partitions its rows by owning profile and calls once per
 * profile — per-profile context is never shared across subjects.
 */
export function judgeObservations<T extends JudgedObservation>(
  profileId: number,
  rows: readonly T[]
): (MetricJudgment | null)[] {
  if (rows.length === 0) return [];
  const { cbByName, ctx, resolve } = flagReconcileProfileContext(profileId);
  const periods = ctx.periods ?? [];
  // One judgement per (analyte, age, phase) — a table lists many readings of one
  // analyte, and re-resolving identical bands per row is pure waste.
  const cache = new Map<string, MetricJudgment | null>();
  return rows.map((r) => {
    const raw = r.canonical_name?.trim() || r.name?.trim();
    if (!raw) return null;
    const name = resolve(raw);
    const entry = cbByName.get(name.toLowerCase());
    if (!entry) return null;
    const age = ageForRecord(ctx, r.date);
    // The phase on THIS row's own collection date, against the profile-local today
    // the shared context resolved (#2613) — a row dated after today derives none.
    const cyclePhase =
      periods.length > 0 && r.date
        ? cyclePhaseOnDate(periods, r.date, ctx.today)
        : null;
    const key = `${name.toLowerCase()}|${age ?? ""}|${cyclePhase ?? ""}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const judgment = metricJudgment(
      readingIdentity(entry.name),
      {
        sex: ctx.sex,
        age,
        status: ctx.reproductiveStatus,
        cyclePhase,
      },
      [entry as JudgmentEntry]
    );
    cache.set(key, judgment);
    return judgment;
  });
}
