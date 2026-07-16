// The Today panel model (issue #852 item 1) — the ONE pure computation the
// Medications page's Today panel formats over, so its scheduled rows read the same
// dose-day order the Supplements tab and the Upcoming/attention surfaces already use
// (#297): the SHARED doseSortKey comparator, never a second ordering. It also decides
// which unresolved doses are PAST their time-of-day bucket (the 8am dose still open at
// 6pm) and whether every due dose is resolved ("All done today ✓"). Pure — no DB — so
// a unit test can pin its order against the Upcoming sortHint order over one fixture.

import { compareSortHint, doseSortKey } from "./dose-order";
import {
  currentTimeBucket,
  timeBucket,
  TIME_BUCKETS,
} from "./supplement-schedule";
import type { SupplementPriority } from "./types";

const ANYTIME_RANK = TIME_BUCKETS.indexOf("Anytime");

export interface TodayPanelDose {
  id: number;
  timeOfDay: string | null;
  label: string;
  // Resolved = taken OR deliberately skipped — either way it needs no more action.
  resolved: boolean;
}

export interface TodayPanelMedInput {
  id: number;
  name: string;
  priority: SupplementPriority;
  stack: string | null;
  doses: TodayPanelDose[];
}

export interface TodayPanelDoseView extends TodayPanelDose {
  // Its time-of-day bucket is earlier than the current bucket AND it's still
  // unresolved — the "you meant to take this hours ago" state. A timeless "Anytime"
  // dose is never past-due.
  pastDue: boolean;
}

export interface TodayPanelMedView {
  id: number;
  name: string;
  doses: TodayPanelDoseView[];
  // The med's position in the dose day: the earliest (lowest) doseSortKey among its
  // doses, so a med with a morning dose leads one whose earliest dose is at bedtime.
  sortKey: string;
}

export interface TodayPanelModel {
  meds: TodayPanelMedView[];
  // Every due dose across all scheduled meds is resolved (and there was at least one),
  // so the panel can show a quiet "All done today ✓" instead of a wall of checked pills.
  allDone: boolean;
}

// Build the ordered, past-due-annotated Today panel model. `nowHhmm` is the profile's
// local wall clock (HH:MM), so "past-due" respects the profile timezone, not the server's.
export function buildTodayPanelModel(
  meds: TodayPanelMedInput[],
  nowHhmm: string
): TodayPanelModel {
  const currentRank = TIME_BUCKETS.indexOf(currentTimeBucket(nowHhmm));

  const views: TodayPanelMedView[] = meds.map((m) => {
    const doses: TodayPanelDoseView[] = m.doses.map((d) => {
      const rank = TIME_BUCKETS.indexOf(timeBucket(d.timeOfDay));
      const pastDue =
        !d.resolved && rank !== ANYTIME_RANK && rank < currentRank;
      return { ...d, pastDue };
    });
    // The med's sort position is its earliest dose's shared doseSortKey — the SAME key
    // Upcoming/attention carry as sortHint, so the two surfaces can't disagree (#297).
    const sortKey = m.doses
      .map((d) =>
        doseSortKey({
          timeOfDay: d.timeOfDay,
          priority: m.priority,
          stack: m.stack,
          name: m.name,
        })
      )
      .reduce<string | null>(
        (min, k) => (min == null || compareSortHint(k, min) < 0 ? k : min),
        null
      );
    return {
      id: m.id,
      name: m.name,
      doses,
      sortKey:
        sortKey ??
        doseSortKey({
          timeOfDay: null,
          priority: m.priority,
          stack: m.stack,
          name: m.name,
        }),
    };
  });

  views.sort((a, b) => compareSortHint(a.sortKey, b.sortKey));

  const allDoses = views.flatMap((m) => m.doses);
  const allDone = allDoses.length > 0 && allDoses.every((d) => d.resolved);

  return { meds: views, allDone };
}
