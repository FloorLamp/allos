// The ONE profile-scoped gather of ITEM-LEVEL adherence history (issue #1505).
//
// Three consumers ask nearly the same question and used to be one refactor away from
// three different answers: the demotion detector ("has this been abandoned over a
// month?", part 2), the digest delta classifier ("what changed in the last fortnight?",
// part 3), and any surface that wants the per-item strip the Supplements page renders.
// They now share this gather, so a day scored "missed" for the digest is the same day
// scored "missed" for the suggestion and for the strip the user can see (#221).
//
// No SQL of its own: everything is read through the existing profile-scoped query
// functions, so profile scoping is inherited rather than re-implemented. The per-day
// aggregation is `supplementAdherenceStrip` — the medicine page's own computation,
// including its #430/#1442 lifetime clamp, so a freshly-added item never scores a
// month of phantom misses.

import { lastNDates, shiftDateStr } from "./date";
import {
  getSupplements,
  getSupplementDoses,
  getSupplementLogsInRange,
  getActivityDates,
} from "./queries";
import { getActiveSituations, getSituationEvents } from "./settings";
import { getTimezone } from "./settings";
import { situationHistoryResolver } from "./trend-annotations";
import {
  doseWindowSince,
  indexTakenByDose,
  stripWithoutTrailingPending,
  supplementAdherenceStrip,
  type AdherenceDot,
} from "./supplement-adherence";
import type { Supplement } from "./types";

// One item plus its window: the aggregated per-day strip (oldest-first, trailing
// still-pending day dropped) and whether the item existed with a schedule for the
// WHOLE window — the cold-start guard the demotion detector needs (#1442).
export interface IntakeHistoryEntry {
  item: Supplement;
  strip: AdherenceDot[];
  existedWholeWindow: boolean;
}

// Every ACTIVE item's adherence history over the trailing `days` window ending at
// `today` (the profile-local date the caller resolved). Items with no live dose row
// are still returned — their strip is all "na", which every consumer reads as "no
// occurrences", never as a lapse.
export function getIntakeHistory(
  profileId: number,
  today: string,
  days: number
): IntakeHistoryEntry[] {
  const items = getSupplements(profileId).filter((s) => s.active);
  if (items.length === 0) return [];

  const doses = getSupplementDoses(profileId);
  const dosesByItem = new Map<number, typeof doses>();
  for (const d of doses) {
    const list = dosesByItem.get(d.item_id);
    if (list) list.push(d);
    else dosesByItem.set(d.item_id, [d]);
  }

  const dates = lastNDates(today, days);
  const windowStart = dates[0] ?? today;
  const tz = getTimezone(profileId);
  const workoutDays = new Set(getActivityDates(profileId));
  // Per-day situation resolver (#654): a past day is scored against the situations
  // active THAT day, never today's toggle applied retroactively — otherwise turning
  // a situation on this morning would manufacture a month of misses for every item
  // keyed to it, which is exactly the evidence a demotion suggestion must not invent.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, days)
  );

  const out: IntakeHistoryEntry[] = [];
  for (const item of items) {
    const itemDoses = dosesByItem.get(item.id) ?? [];
    const strip = stripWithoutTrailingPending(
      supplementAdherenceStrip(
        item,
        itemDoses,
        dates,
        workoutDays,
        situationsOn,
        takenByDose,
        tz
      )
    );
    // The earliest day ANY of the item's doses could be judged from — the same bound
    // the strip itself clamps to. An item whose every dose starts AFTER the window
    // opened has not been around long enough to be judged over the whole window. A
    // null bound means "no known lower bound" (no stored timestamps), the pre-#1442
    // behavior, and counts as covering the window.
    const sinces = itemDoses.map((d) =>
      doseWindowSince(item.created_at, d.created_at, takenByDose.get(d.id), tz)
    );
    const covered =
      itemDoses.length > 0 &&
      sinces.some((since) => since == null || since <= windowStart);
    out.push({ item, strip, existedWholeWindow: covered });
  }
  return out;
}

// The window's first date, exported so a caller that needs to reason about the
// boundary doesn't recompute the arithmetic.
export function intakeHistoryWindowStart(today: string, days: number): string {
  return shiftDateStr(today, -(days - 1));
}
