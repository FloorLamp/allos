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
// aggregation is `intakeAdherenceStrip` — the intake surface's own computation,
// including its #430/#1442 lifetime clamp, so a freshly-added item never scores a
// month of phantom misses.

import { lastNDates, shiftDateStr } from "./date";
import {
  getIntakeItems,
  getIntakeDoses,
  getIntakeAdherenceEvidence,
  getActivityDates,
  getEverLoggedItemIds,
} from "./queries";
import { getActiveSituations, getSituationEvents } from "./settings";
import { situationHistoryResolver } from "./trend-annotations";
import {
  doseWindowSince,
  indexTakenByDose,
  stripWithoutTrailingPending,
  intakeAdherenceStrip,
  type AdherenceDot,
} from "./intake-adherence";
import { isPushedIntake } from "./intake-schedule";
import { profileDayZone, travelExcusalResolver } from "./travel-excusal";
import {
  classifyIntakeDeltas,
  intakeDeltaLine,
  INTAKE_DELTA_DAYS,
  type IntakeDeltaReportWindow,
  type IntakeDeltas,
} from "./intake-deltas";
import {
  detectUnconfirmedMedications,
  isImportProvenanced,
  UNCONFIRMED_WINDOW_DAYS,
} from "./medication-unconfirmed";
import type { IntakeItem } from "./types";

// One item plus its window: the aggregated per-day strip (oldest-first, trailing
// still-pending day dropped) and whether the item existed with a schedule for the
// WHOLE window — the cold-start guard the demotion detector needs (#1442).
export interface IntakeHistoryEntry {
  item: IntakeItem;
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
  const items = getIntakeItems(profileId).filter((s) => s.active);
  if (items.length === 0) return [];

  const doses = getIntakeDoses(profileId);
  const dosesByItem = new Map<number, typeof doses>();
  for (const d of doses) {
    const list = dosesByItem.get(d.item_id);
    if (list) list.push(d);
    else dosesByItem.set(d.item_id, [d]);
  }

  const dates = lastNDates(today, days);
  const windowStart = dates[0] ?? today;
  const dayZone = profileDayZone(profileId);
  const workoutDays = new Set(getActivityDates(profileId));
  // Per-day situation resolver (#654): a past day is scored against the situations
  // DECLARED that day, never today's toggle applied retroactively — otherwise turning a
  // situation on this morning would manufacture a month of misses for every item keyed
  // to it, which is evidence a demotion suggestion must not invent.
  // NOT DATED (#3993), and it is a COST decision, not a claim that this surface differs.
  // The dated resolver runs one derived gather per DAY; this walks a window, and these
  // walks run on the DASHBOARD. Measured with the whole seam dated: +96 queries per
  // persona (+112 for the two with cycle rows) against the 274 backstop recorded in
  // lib/__db_tests__/dashboard-placement-manifest.test.ts, whose own message calls growth
  // of that size "a design conversation about what the dashboard gathers — not a number
  // to raise so CI goes green". So the surfaces a person can ACT on are dated (the
  // reminder rebuild, the catch-up sheet and the strips beside them) and the ones that
  // only SUMMARISE wait for that conversation. The consequence, written down rather than
  // discovered: a Poor-sleep item's rough-night days score `na` here while those surfaces
  // call them due. The fix that removes the cost instead of accepting it is to read the
  // derived half's DATE-INDEPENDENT inputs once per window — the nights, the period log,
  // the weather series — and evaluate each day purely against them, which the pure half
  // of lib/derived-situations.ts is already shaped for.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );
  const takenByDose = indexTakenByDose(
    getIntakeAdherenceEvidence(profileId, days)
  );
  // Travel (#3263): a dose whose slot a timezone switch jumped over is out of the
  // window's denominator, so a trip cannot manufacture the low adherence that a
  // demotion suggestion would then be built on.
  const isExcused = travelExcusalResolver(profileId);

  const out: IntakeHistoryEntry[] = [];
  for (const item of items) {
    const itemDoses = dosesByItem.get(item.id) ?? [];
    const strip = stripWithoutTrailingPending(
      intakeAdherenceStrip(
        item,
        itemDoses,
        dates,
        workoutDays,
        situationsOn,
        takenByDose,
        dayZone,
        isExcused
      )
    );
    // The earliest day ANY of the item's doses could be judged from — the same bound
    // the strip itself clamps to. An item whose every dose starts AFTER the window
    // opened has not been around long enough to be judged over the whole window. A
    // null bound means "no known lower bound" (no stored timestamps), the pre-#1442
    // behavior, and counts as covering the window.
    const sinces = itemDoses.map((d) =>
      doseWindowSince(
        item.created_at,
        d.created_at,
        takenByDose.get(d.id),
        dayZone
      )
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

// THE server-side entry point for the digest deltas (#1505 part 3): the pushed
// tier's state changes over the delta window, ready for `intakeDeltaLine`.
//
// Every digest channel calls THIS — the Telegram morning digest, the weekly recap
// (and therefore the dashboard recap atoms), and the household card — so none of
// them can compute its own variant of "what changed" (#221). The tier is chosen by
// the SAME `isPushedIntake` predicate part 1 gates the push surfaces with, which is
// what makes the digest's news exactly the set of obligations it is allowed to push
// about: a `may` supplement is tracked, so it still counts in the adherence
// fraction beside this line, but its misses are not news.
export function getIntakeDeltas(
  profileId: number,
  today: string
): IntakeDeltas {
  return classifyIntakeDeltas(
    getIntakeHistory(profileId, today, INTAKE_DELTA_DAYS)
      .filter(({ item }) => isPushedIntake(item))
      .map(({ item, strip }) => ({
        itemId: item.id,
        name: item.name,
        strip,
      }))
  );
}

// THE server-side entry point for the unconfirmed-medication offer (#2574): the item
// ids whose dose reminder may carry the one-tap Stop.
//
// A domain adapter over the SAME gather above, exactly as getIntakeDeltas is — the
// occurrence count is read off the strip the Supplements page renders, so the offer and
// the strip can never disagree about which days were occasions. The one fact this needs
// that the strip cannot supply is the LIFETIME log count, because the strip is windowed
// by construction and the claim is that nothing has ever happened; that is one extra
// profile-scoped read, done once per gather.
//
// Returns ids rather than the candidates because the one consumer is a per-dose boolean.
export function getUnconfirmedMedicationIds(
  profileId: number,
  today: string
): Set<number> {
  // A cheap gate on the item list BEFORE the 30-day gather. The detector's first three
  // refusals — not a medication, not import-provenanced, not pushed — are decidable
  // from the row alone, and a profile with no imported medication at all is the
  // overwhelmingly common case. Without this the reminder path would run a second full
  // history gather on every send for every profile, to answer "no".
  const eligible = getIntakeItems(profileId).some(
    (i) =>
      i.active &&
      i.kind === "medication" &&
      isImportProvenanced(i) &&
      isPushedIntake(i)
  );
  if (!eligible) return new Set();

  const everLogged = getEverLoggedItemIds(profileId);
  return new Set(
    detectUnconfirmedMedications(
      getIntakeHistory(profileId, today, UNCONFIRMED_WINDOW_DAYS).map(
        ({ item, strip }) => ({
          itemId: item.id,
          name: item.name,
          kind: item.kind,
          source: item.source,
          obligation: item.obligation,
          active: Boolean(item.active),
          strip,
          lifetimeLogs: everLogged.has(item.id) ? 1 : 0,
        })
      )
    ).map((c) => c.itemId)
  );
}

// The one-line headline for a profile, or null on a quiet window. The thin
// convenience over getIntakeDeltas + intakeDeltaLine that the three digest surfaces
// actually call. `window` is the caller's reporting period (#3033): the weekly
// recap passes its own window so a single-occurrence miss names its day; the
// day-scale surfaces pass nothing and keep their copy unchanged.
export function getIntakeDeltaLine(
  profileId: number,
  today: string,
  window: IntakeDeltaReportWindow | null = null
): string | null {
  return intakeDeltaLine(getIntakeDeltas(profileId, today), window);
}
