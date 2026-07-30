// The PURE decision half of the prolonged-bleeding observation (issue #1682 fix b).
// Coaching-tier only (the #449 findings reach policy): it joins collectCoachingFindings,
// its dedupeKey prefix is registered in RULE_FINDING_PREFIXES, and it NEVER notifies and
// never reaches the non-hideable "Needs attention" hero.
//
// WHY OBSERVE RATHER THAN REFUSE. A long recorded period is the one plausibility failure
// that must NOT be rejected at the write boundary: prolonged bleeding is real, and an app
// that refuses to record it is an app that can't record an emergency. So the row is stored
// exactly as entered (#1682 b) and the app simply SAYS what it noticed, calmly, once per
// period, dismissible.
//
// COPY STAYS OBSERVATIONAL, NEVER DIAGNOSTIC: it states the day count and suggests raising
// it with a clinician. No cause, no severity, no urgency — informational only, and no
// hint of a body-shaming or alarm register. Cycle carries no obligation (the attention
// doctrine: this domain is never a source of dueness), so this can never become a push.
//
// Pure (no DB/clock beyond the anchor it is handed); the DB input assembly lives in
// buildCycleBleedingFindings (lib/rule-findings.ts).

import {
  PROLONGED_PERIOD_DAYS,
  periodLengthDays,
  type CyclePeriod,
} from "./cycle";
import { daysBetweenDateStr } from "./date";

// dedupeKey namespace for the suppression bus + the RULE_FINDING_PREFIXES registry.
export const CYCLE_BLEEDING_PREFIX = "cycle-bleeding:";

// How far back a recorded period may end and still be observed. An unusually long period
// from two years ago is history, not something to raise today; the window keeps the note
// about the current picture. Also bounds the finding to at most a couple of periods.
export const CYCLE_OBSERVATION_WINDOW_DAYS = 90;

// The episode key: the specific period (its start day). Dismissing silences THAT period
// forever, and a later long period surfaces its own note — "dismiss once, silence until it
// changes" (#436), never a topic-wide mute.
export function cycleBleedingSignalKey(periodStart: string): string {
  return `${CYCLE_BLEEDING_PREFIX}${periodStart}`;
}

export interface ProlongedBleedingObservation {
  dedupeKey: string;
  periodStart: string;
  days: number;
  title: string;
  detail: string;
}

// Decide whether a single recorded period is worth mentioning. Emits only for a CLOSED
// period (an open one has no length yet — that case is the stale-open prompt's, not this
// one), at or above PROLONGED_PERIOD_DAYS bleeding days, ending within the window.
// Returns null otherwise. Pure.
export function decideProlongedBleeding(
  period: CyclePeriod,
  today: string
): ProlongedBleedingObservation | null {
  if (period.period_end == null) return null;
  const days = periodLengthDays(period);
  if (days == null || days < PROLONGED_PERIOD_DAYS) return null;
  const age = daysBetweenDateStr(period.period_end, today);
  if (age == null || age < 0 || age > CYCLE_OBSERVATION_WINDOW_DAYS)
    return null;
  return {
    dedupeKey: cycleBleedingSignalKey(period.period_start),
    periodStart: period.period_start,
    days,
    title: `${days} days of bleeding — worth discussing with a clinician`,
    detail:
      `The period starting ${period.period_start} is recorded as ${days} days of ` +
      `bleeding. Most periods run 3–7 days, so a longer one is worth mentioning at ` +
      `your next appointment. Informational only — not a diagnosis.`,
  };
}

// Every observable period in the history, newest first. Deterministic ordering so the
// coaching tab and the rollup list them the same way.
export function prolongedBleedingObservations(
  periods: CyclePeriod[],
  today: string
): ProlongedBleedingObservation[] {
  return periods
    .map((p) => decideProlongedBleeding(p, today))
    .filter((o): o is ProlongedBleedingObservation => o != null)
    .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
}
