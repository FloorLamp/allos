// Builds the supplement-reminder notification for a send slot (a time-of-day
// window, or the workout-relative PreWorkout pseudo-slot — issue #1154), reusing
// the schedule helpers so workout/rest-day and situational logic is honored.
// The DB-touching gather lives here; the message formatting is the pure
// renderWindowMessage / renderMergedIntakeMessage in ./supplement-format.

import { today } from "../db";
import { lastNDates, zonedDateParts } from "../date";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  inferWorkoutSchedule,
  getSupplementLogsInRange,
} from "../queries";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
  getUserAge,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import {
  adherenceSummary,
  doseStrip,
  indexTakenByDose,
} from "../supplement-adherence";
import {
  isDueOn,
  isPostWorkoutReady,
  timeBucket,
} from "../supplement-schedule";
import type { Supplement, SupplementDose } from "../types";
import {
  doseSendSlot,
  notifiableWindowDoses,
  renderWindowMessage,
  renderMergedIntakeMessage,
  type IntakeSendSlot,
  type IntakeSlotPart,
  type ReminderWindow,
  type WindowDose,
} from "./supplement-format";
import { preWorkoutSlotHour } from "./schedule";
import type { NotificationMessage } from "./types";

export type { ReminderWindow, IntakeSendSlot };

// Rolling window for the streak + adherence percentage shown on each line —
// matches the supplements page's strip length.
const ADHERENCE_DAYS = 14;

// The current profile-local minute-of-day (0–1439), for post_workout timing.
function currentMinutesOfDay(profileId: number): number {
  const { hhmm } = zonedDateParts(getTimezone(profileId), new Date());
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// Whether this profile's `anytime` pre_workout doses are workout-relative
// (issue #1154 Fix A): true when a training cadence (and hence an hour) can be
// inferred. Kept as the ONE gate both the slot membership (doseSendSlot) and the
// tick's pseudo-slot hour derive from, so a dose can never fall between slots.
function preWorkoutTimed(profileId: number): boolean {
  return inferWorkoutSchedule(profileId).hasPattern;
}

// The profile-local hour the PreWorkout pseudo-slot fires (one hour before the
// inferred training hour), or null when it doesn't apply: no inferable cadence
// (the #558 logged-signal fallback keeps those doses in their bucket window), or
// no active `anytime` pre_workout dose to time.
export function getPreWorkoutSlotHour(profileId: number): number | null {
  const preSupps = getSupplements(profileId).filter(
    (s) => s.active && !s.as_needed && s.condition === "pre_workout"
  );
  if (preSupps.length === 0) return null;
  const ids = new Set(preSupps.map((s) => s.id));
  const hasAnytime = getSupplementDoses(profileId).some(
    (d) => ids.has(d.item_id) && timeBucket(d.time_of_day) === "Anytime"
  );
  if (!hasAnytime) return null;
  const inf = inferWorkoutSchedule(profileId);
  if (!inf.hasPattern) return null;
  return preWorkoutSlotHour(inf.hour);
}

// Gather the due doses in send slot `slot` on `date` from an already-fetched dose
// list, each tagged with whether it's been logged and its recent adherence.
// Taking the doses as an argument lets the callback path resolve a tapped dose's
// slot and collect that slot in a single query.
//
// NOTE: this gather is deliberately UNFILTERED by the #1156 priority floor — the
// send-assembly layer (buildIntakeReminderForSlots / the finish nudge) and the
// button paths apply notifiableWindowDoses; the missed-dose escalation gather
// (lib/notifications/escalate.ts) reads THIS unfiltered set on purpose, so the
// safety tier is structurally never priority-gated.
function gatherWindowDoses(
  profileId: number,
  slot: IntakeSendSlot,
  date: string,
  doses: SupplementDose[]
): WindowDose[] {
  const supplements = getSupplements(profileId).filter((s) => s.active);
  if (supplements.length === 0) return [];

  const suppById = new Map(supplements.map((s) => [s.id, s]));
  const taken = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  const activeSituations = new Set(getActiveSituations(profileId));
  // Per-day situation resolver for the adherence strip below: each past day is scored
  // against the situations active THAT day (#654), not today's toggle retroactively.
  const situationsOn = situationHistoryResolver(
    activeSituations,
    getSituationEvents(profileId)
  );
  const activitiesToday = getActivitiesByDate(profileId, date);
  // #558: a pre_workout reminder fires on a PREDICTED training day (so it can land
  // before the session), not only after a workout is logged; post_workout stays
  // gated on a logged session and held until it has ended. Only workout-
  // conditioned items are affected — a daily med reminder (safety tier) is
  // unconditional, so it never becomes workout-dependent.
  const isForToday = date === today(profileId);
  const nowMinutes = isForToday ? currentMinutesOfDay(profileId) : null;
  const ctx = {
    isWorkoutDay: activitiesToday.length > 0,
    activeSituations,
    predictedWorkoutDay: isPredictedWorkoutDay(profileId, date),
    postWorkoutReady: isPostWorkoutReady(
      activitiesToday.map((a) => a.end_time ?? a.start_time),
      nowMinutes
    ),
  };
  // #1154 Fix A: whether `anytime` pre_workout doses ride the PreWorkout
  // pseudo-slot instead of folding into Morning.
  const workoutTimed = preWorkoutTimed(profileId);

  // Inputs for the per-dose streak + adherence percentage. Anchored on the real
  // today (not `date`, which may be a prior day's reminder tapped late) so the
  // column window lines up with getSupplementLogsInRange's own today-anchored
  // range and with adherenceSummary's "last column is today, still pending" rule.
  const windowDates = lastNDates(today(profileId), ADHERENCE_DAYS);
  const workoutDays = new Set(getActivityDates(profileId));
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, ADHERENCE_DAYS)
  );

  const entries: WindowDose[] = [];
  for (const dose of doses) {
    const supp = suppById.get(dose.item_id);
    if (!supp) continue;
    if (!isDueOn(supp, ctx)) continue;
    if (doseSendSlot(supp.condition, timeBucket(dose.time_of_day), workoutTimed) !== slot)
      continue;
    // A dose is "due" on a past date when its supplement was due that day
    // (workout/situational logic); situations are only known as of now.
    const dd = takenByDose.get(dose.id);
    const strip = doseStrip(
      windowDates,
      (d) =>
        isDueOn(supp, {
          isWorkoutDay: workoutDays.has(d),
          activeSituations: situationsOn(d),
        }),
      dd?.taken ?? new Set<string>(),
      dd?.skipped ?? new Set<string>()
    );
    entries.push({
      dose,
      supp,
      taken: taken.has(dose.id),
      skipped: skipped.has(dose.id),
      adherence: adherenceSummary(strip),
    });
  }
  return entries;
}

// Every dose due in send slot `slot` on `date`, each tagged with whether it's
// already been logged. Includes taken doses (unlike a plain "what's left" query)
// so a reminder — or a rebuilt message after a tap — reflects the whole session.
export function collectWindowDoses(
  profileId: number,
  slot: IntakeSendSlot,
  date: string
): WindowDose[] {
  return gatherWindowDoses(
    profileId,
    slot,
    date,
    getSupplementDoses(profileId)
  );
}

// The merged send for every slot due (and unsent) this hour — issue #1154's
// one-reminder-per-hour invariant. Gathers each slot, applies the #1156 priority
// floor, drops empty slots, and renders ONE message (a single slot renders the
// classic window message). Returns null — no send — when nothing is due after
// the floor, or when EVERY dose across the merged set is already resolved
// (taken or deliberately skipped, #232): the empty/all-low check runs on the
// MERGED set. `slots` in the result are the slots that actually contributed
// entries — the tick marks each of their per-day markers on delivery so none
// re-fires today.
export function buildIntakeReminderForSlots(
  profileId: number,
  slots: IntakeSendSlot[]
): { message: NotificationMessage; slots: IntakeSendSlot[] } | null {
  const date = today(profileId);
  const doses = getSupplementDoses(profileId);
  const parts: IntakeSlotPart[] = [];
  for (const slot of slots) {
    const entries = notifiableWindowDoses(
      gatherWindowDoses(profileId, slot, date, doses)
    );
    if (entries.length === 0) continue;
    parts.push({ slot, entries });
  }
  if (parts.length === 0) return null;
  // Every dose resolved — taken OR deliberately skipped (#232) — means nothing
  // is pending, so no reminder goes out (a skip stops re-nudging like a take).
  const all = parts.flatMap((p) => p.entries);
  if (all.every((e) => e.taken || e.skipped)) return null;
  return {
    message: renderMergedIntakeMessage(
      profileId,
      parts,
      date,
      getUserAge(profileId)
    ),
    slots: parts.map((p) => p.slot),
  };
}

// Reminder for supplements due in one slot today, or null when nothing is due —
// including when every dose for the slot is already logged, so a reminder is
// never sent just to say everything's done. (The tick sends via
// buildIntakeReminderForSlots; this single-slot form serves the manual CLI mode
// and keeps the classic per-window shape.)
export function buildSupplementReminder(
  profileId: number,
  window: IntakeSendSlot
): NotificationMessage | null {
  return buildIntakeReminderForSlots(profileId, [window])?.message ?? null;
}

// Resolve a tapped dose's slot and collect that slot's session in one dose
// fetch. Null when the dose isn't found for this profile; the returned entries
// can still be empty (e.g. the supplement was deactivated or is no longer due),
// which the caller treats as "can't rebuild the session view". Entries are
// floor-filtered (#1156) — a rebuilt reminder must not resurface doses the send
// excluded.
export function windowSessionForDose(
  profileId: number,
  doseId: number,
  date: string
): { window: IntakeSendSlot; entries: WindowDose[] } | null {
  const doses = getSupplementDoses(profileId);
  const tapped = doses.find((d) => d.id === doseId);
  if (!tapped) return null;
  const supp = getSupplements(profileId).find((s) => s.id === tapped.item_id);
  const slot = doseSendSlot(
    supp?.condition ?? "daily",
    timeBucket(tapped.time_of_day),
    preWorkoutTimed(profileId)
  );
  return {
    window: slot,
    entries: notifiableWindowDoses(
      gatherWindowDoses(profileId, slot, date, doses)
    ),
  };
}

// The MERGED session view for a set of dose ids + slots harvested from a tapped
// message's keyboard (issue #1154): a coalesced reminder can span several slots,
// so its rebuild must re-render every slot the message covered, not only the
// tapped dose's. Slots are derived from the surviving buttons (dose ids + any
// per-slot All tokens); parts gather floor-filtered (#1156), empty slots drop.
export function slotSessionForKeyboard(
  profileId: number,
  doseIds: number[],
  slots: IntakeSendSlot[],
  date: string
): IntakeSlotPart[] {
  const doses = getSupplementDoses(profileId);
  const supps = new Map<number, Supplement>(
    getSupplements(profileId).map((s) => [s.id, s])
  );
  const workoutTimed = preWorkoutTimed(profileId);
  const wanted = new Set<IntakeSendSlot>(slots);
  const doseById = new Map(doses.map((d) => [d.id, d]));
  for (const id of doseIds) {
    const d = doseById.get(id);
    if (!d) continue;
    const supp = supps.get(d.item_id);
    if (!supp) continue;
    wanted.add(
      doseSendSlot(supp.condition, timeBucket(d.time_of_day), workoutTimed)
    );
  }
  const parts: IntakeSlotPart[] = [];
  for (const slot of wanted) {
    const entries = notifiableWindowDoses(
      gatherWindowDoses(profileId, slot, date, doses)
    );
    if (entries.length > 0) parts.push({ slot, entries });
  }
  return parts;
}
