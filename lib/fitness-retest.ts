// Pure retest-cadence decision for the Fitness check (issue #834). A COACHING-tier nudge
// (calm; #449): once a user has DONE a check, if it's older than their per-profile retest
// cadence (~quarterly by default) the coaching rollup surfaces a "Fitness check due" item
// through the standard findings/dismissal bus — never a push notification. DB-free; the
// builder in lib/rule-findings.ts gathers the last-check date + cadence and calls this.
//
// Deliberately calm: a subject who has NEVER done a check is NOT nagged to start one
// (hide, don't shame — #489); the nudge only appears once a baseline exists and has aged
// past the cadence.

import { daysBetweenDateStr } from "@/lib/date";

// The dedupeKey namespace this builder keys under (registered in
// lib/rule-finding-prefixes.ts; the #448 reflection guard enforces it).
export const FITNESS_CHECK_PREFIX = "fitness-check:";

// The default retest cadence (days) when the profile hasn't set one — roughly quarterly.
export const DEFAULT_FITNESS_RETEST_DAYS = 90;

// The retest nudge's dedupeKey, RE-KEYED by the last-check date (the #203/#482 discipline):
// once the user does a NEW check the date changes, so an old dismissal never carries into
// the next window and a future overdue check re-surfaces cleanly.
export function fitnessCheckSignalKey(lastDate: string): string {
  return `${FITNESS_CHECK_PREFIX}retest:${lastDate}`;
}

export interface FitnessRetestDecision {
  due: boolean;
  daysSince: number | null; // null = never done
  lastDate: string | null;
}

// Whether a fitness check is overdue. Never due without a prior check (calm baseline
// restraint) or with a non-positive cadence.
export function fitnessRetestDue(
  lastDate: string | null,
  cadenceDays: number,
  today: string
): FitnessRetestDecision {
  if (!lastDate) return { due: false, daysSince: null, lastDate: null };
  const daysSince = daysBetweenDateStr(lastDate, today);
  if (daysSince == null) return { due: false, daysSince: null, lastDate };
  const due =
    Number.isFinite(cadenceDays) && cadenceDays > 0 && daysSince >= cadenceDays;
  return { due, daysSince, lastDate };
}
