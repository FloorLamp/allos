// Builds the supplement-reminder notification for a send slot (a time-of-day
// window, or the workout-relative PreWorkout pseudo-slot — issue #1154), reusing
// the schedule helpers so workout/rest-day and situational logic is honored.
// The DB-touching gather lives here; the message formatting is the pure
// renderWindowMessage / renderMergedIntakeMessage in ./supplement-format.

import { today } from "../db";
import { lastNDates, zonedDateParts } from "../date";
import {
  getIntakeItems,
  getIntakeDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  inferWorkoutSchedule,
  getIntakeLogsInRange,
  getEffectiveActiveSituations,
  getMinutesSinceLastFoodLog,
} from "../queries";
import { foodTimingCheck } from "../food-timing-check";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
  getProfileAge,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import {
  adherenceSummary,
  doseStrip,
  doseWindowSince,
  indexTakenByDose,
} from "../intake-adherence";
import { doseDueOn, isPostWorkoutReady, timeBucket } from "../intake-schedule";
import type { IntakeItem, IntakeDose } from "../types";
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
import { preWorkoutSlotMinute } from "./schedule";
import type { NotificationMessage } from "./types";
import { isOnDemand } from "../intake-schedule";
import { demotionCandidateItemIds } from "../rule-findings";
import { getUnconfirmedMedicationIds } from "../intake-history";
import { collapsedOfferAction } from "./offer-tail";
import { getOfferedIntakeForSlot } from "../queries/intake";
import { now as clockNow } from "../clock";
import { getDoseCorrectionBursts } from "../queries/intake/adherence";
import {
  correctionActions,
  correctionBodyStatement,
  correctionPickerActions,
  correctionPickerTitle,
  DOSE_TIME_PREFIXES,
} from "./correction-rows";
import {
  correctionMessageBinding,
  type CorrectionMessageRef,
} from "./message-pointers";
import { plainBody } from "./rich-text";

export type { ReminderWindow, IntakeSendSlot };

// ---- The dose-time correction ride-along (issue #2020) ----

// Append the eating-time model's dose twin to a rendered intake message: one row per
// burst of confirmations tapped in the last hour, derived from the LEDGER rather than
// from any memory of what an earlier keyboard showed.
//
// A RIDE-ALONG in the strict sense — no message is ever SENT because an instant might be
// wrong. It decorates the reminder that already exists, which is what makes the whole
// affordance free: the dose keyboard lives for the dose-log window (#2018), so the chips
// simply appear on whichever copy of it is currently in the chat, and the hourly sweep
// strips them when the burst ages out.
//
// One helper for every site that renders this message — the send, both tap rebuilds and
// the reconcile rebuild — so the sweep can never produce a keyboard a tap would not
// (#221), which is exactly the condition its zero-call steady state depends on.
export function withDoseCorrections(
  profileId: number,
  message: NotificationMessage,
  // `ref` is the MESSAGE being rebuilt (#2264): tap rebuilds and the sweep pass their
  // own (chat, message), so the rows are bound to the message whose taps produced their
  // bursts; a fresh send omits it and carries only unattributed bursts, being about to
  // be the newest live dose message in every chat it lands in.
  opts: {
    now?: Date;
    pickerAnchor?: number | null;
    ref?: CorrectionMessageRef | null;
  } = {}
): NotificationMessage {
  const now = opts.now ?? clockNow();
  const bursts = getDoseCorrectionBursts(
    profileId,
    now,
    correctionMessageBinding(profileId, "dose", opts.ref ?? null)
  );
  if (bursts.length === 0) return message;
  const tz = getTimezone(profileId);
  // An OPEN picker survives the rebuild (see `openPickerAnchor`): the sweep re-renders
  // from this builder, and dropping the drill-down would take the question away from
  // someone in the middle of answering it.
  const open = opts.pickerAnchor
    ? bursts.find((b) => b.fromId === opts.pickerAnchor)
    : undefined;
  const extra = open
    ? correctionPickerActions(DOSE_TIME_PREFIXES, profileId, open, now, tz)
    : correctionActions(DOSE_TIME_PREFIXES, profileId, bursts, tz, now);
  // The statement of record (#2264 bug 1): a corrected burst's stored time is stated in
  // the BODY — the label button states it too, but Telegram truncates buttons. One
  // computation with the food side (correctionBodyStatement over burstLabel).
  const statement = correctionBodyStatement(bursts, tz);
  const lines = [
    plainBody(message.body),
    ...(open
      ? [correctionPickerTitle("when did you take these", open, tz)]
      : []),
    ...(statement ? [statement] : []),
  ];
  const body = lines.length > 1 ? lines.join("\n") : message.body;
  return {
    ...message,
    body,
    actions: [...(message.actions ?? []), ...extra],
  };
}

// Rolling window for the adherence percentage shown on each line —
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

// The profile-local minute of day the PreWorkout pseudo-slot fires (one hour
// before the inferred training time), or null when it doesn't apply: no inferable
// cadence (the #558 logged-signal fallback keeps those doses in their bucket
// window), or no active `anytime` pre_workout dose to time. The inference itself
// stays hour-grain (inferWorkoutSchedule takes the mode over start HOURS), so the
// resulting minute is always :00 today — the type is minutes so the slot joins the
// #2121 vocabulary without a private unit.
export function getPreWorkoutSlotMinute(profileId: number): number | null {
  const preSupps = getIntakeItems(profileId).filter(
    (s) => s.active && !isOnDemand(s) && s.condition === "pre_workout"
  );
  if (preSupps.length === 0) return null;
  const ids = new Set(preSupps.map((s) => s.id));
  const hasAnytime = getIntakeDoses(profileId).some(
    (d) => ids.has(d.item_id) && timeBucket(d.time_of_day) === "Anytime"
  );
  if (!hasAnytime) return null;
  const inf = inferWorkoutSchedule(profileId);
  if (!inf.hasPattern) return null;
  return preWorkoutSlotMinute(inf.hour * 60);
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
  doses: IntakeDose[]
): WindowDose[] {
  const supplements = getIntakeItems(profileId).filter((s) => s.active);
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
    date,
    isWorkoutDay: activitiesToday.length > 0,
    // Derived context (#1292/#1298) widens the active set for TODAY only (a surfacing
    // path); a past-day reminder scores against the declared set (the history resolver
    // above owns retroactive membership, so it must NOT see derived names).
    activeSituations: isForToday
      ? getEffectiveActiveSituations(profileId, date)
      : activeSituations,
    predictedWorkoutDay: isPredictedWorkoutDay(profileId, date),
    postWorkoutReady: isPostWorkoutReady(
      activitiesToday.map((a) => a.end_time ?? a.start_time),
      nowMinutes
    ),
  };
  // #1154 Fix A: whether `anytime` pre_workout doses ride the PreWorkout
  // pseudo-slot instead of folding into Morning.
  const workoutTimed = preWorkoutTimed(profileId);

  // Inputs for the per-dose adherence percentage. Anchored on the real
  // today (not `date`, which may be a prior day's reminder tapped late) so the
  // column window lines up with getIntakeLogsInRange's own today-anchored
  // range and with adherenceSummary's "last column is today, still pending" rule.
  const windowDates = lastNDates(today(profileId), ADHERENCE_DAYS);
  const tz = getTimezone(profileId);
  const workoutDays = new Set(getActivityDates(profileId));
  const takenByDose = indexTakenByDose(
    getIntakeLogsInRange(profileId, ADHERENCE_DAYS)
  );

  // The demotion candidates for THIS profile, resolved once per gather rather than
  // per dose (the detector reads a 30-day window per item — doing it inside the loop
  // would re-read the same ledger for every slot).
  const demotableItemIds = demotionCandidateItemIds(
    profileId,
    today(profileId)
  );

  // The unconfirmed imported MEDICATIONS for this profile (#2574) — the sibling flag,
  // resolved once per gather for the same reason: it reads a 30-day window per item, so
  // asking inside the loop would re-read one ledger per slot. Disjoint from the set
  // above by construction (that detector refuses medications; this one requires one),
  // so no dose row can ever gain both buttons.
  const unconfirmedItemIds = getUnconfirmedMedicationIds(
    profileId,
    today(profileId)
  );

  // The food ledger's answer to "has anything gone in lately", read ONCE per gather
  // (#2022) — it is one number for the profile, not a per-dose fact, and the loop below
  // only turns it into a per-dose clause through the pure predicate.
  //
  // TODAY ONLY. A reminder gathered for a PAST date (a late tap rebuilding yesterday's
  // message) must not carry a clause about the present: "no food logged in the last 90
  // min" is a statement about right now, and pinning it to a day that has ended would be
  // a confident falsehood. Those gathers pass null and every dose's check resolves to
  // `none` — note that is the WHOLE gate, because `null` minutes on a with_food dose
  // legitimately means "nothing logged" and would otherwise render. It is deliberately
  // NOT lazy behind "does any dose declare a timing": one bounded index read per gather
  // is cheaper than the branch is worth, and a lazy read would make the reminder's text
  // depend on evaluation order.
  const minutesSinceFood = isForToday
    ? getMinutesSinceLastFoodLog(profileId)
    : null;

  const entries: WindowDose[] = [];
  for (const dose of doses) {
    const supp = suppById.get(dose.item_id);
    if (!supp) continue;
    // The CALENDAR gate on the SEND path (#1602): a weekly med's reminder fires on its
    // on-days only, and an out-of-window taper row stops reminding without being
    // retired. This is the half that makes the whole feature safe to use — the item can
    // stay `must` (reminders + missed-dose escalation intact) precisely because the
    // machinery can now say "not today" instead of the user having to silence it.
    if (!doseDueOn(supp, dose, ctx)) continue;
    if (
      doseSendSlot(
        supp.condition,
        timeBucket(dose.time_of_day),
        workoutTimed
      ) !== slot
    )
      continue;
    // A dose is "due" on a past date when its supplement was due that day
    // (workout/situational logic); situations are only known as of now.
    const dd = takenByDose.get(dose.id);
    // Clamp the window to the dose's lifetime (#430/#1442) before summarizing it:
    // a fixed lookback over a med added this morning is all pre-existence days,
    // and scoring them would make the very first reminder announce "0% adherence".
    const since = doseWindowSince(supp.created_at, dose.created_at, dd, tz);
    const strip = doseStrip(
      since ? windowDates.filter((d) => d >= since) : windowDates,
      (d) =>
        doseDueOn(supp, dose, {
          date: d,
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
      // Ride-the-nag (#1505 part 2): a ⤓ May button appears on this dose's row only
      // while the item is a live demotion candidate. Detection state alone governs
      // it — an in-app dismissal deliberately does NOT remove it, because for a
      // tap-only user this is the only escape hatch that ever reaches them.
      demotable: demotableItemIds.has(supp.id),
      // Ride-the-nag again (#2574): a Stop button appears on this dose's row only while
      // the item is a live unconfirmed-import candidate. Detection state alone governs
      // it, and any log of either status clears the candidacy on the next gather — so
      // the button cannot outlive the claim it is making.
      stoppable: unconfirmedItemIds.has(supp.id),
      // The declared timing as a live check (#2022). Today only — see the read above.
      ...(isForToday
        ? { foodCheck: foodTimingCheck(dose.food_timing, minutesSinceFood) }
        : {}),
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
  return gatherWindowDoses(profileId, slot, date, getIntakeDoses(profileId));
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
  const doses = getIntakeDoses(profileId);
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
  const message = withDoseCorrections(
    profileId,
    renderMergedIntakeMessage(profileId, parts, date, getProfileAge(profileId))
  );
  // RIDE-ALONG (#1505 Part 1, class 3). A reminder that is going out anyway for this
  // slot's must/should doses carries a More… row exposing the SAME slot's `may`
  // items. Convenience only — the digest tail is the guaranteed path — and inherently
  // slot-correct, because the reminder IS the slot.
  //
  // It costs no send: the message already exists. That is the only reason it is
  // allowed to exist at all ("a suggestion may only decorate a send that exists for
  // its own reasons").
  const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;
  const offered = getOfferedIntakeForSlot(profileId, nowHhmm);
  if (offered.length > 0) {
    message.actions = [
      ...(message.actions ?? []),
      collapsedOfferAction(profileId, date, nowHhmm, offered.length),
    ];
  }
  return { message, slots: parts.map((p) => p.slot) };
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
  const doses = getIntakeDoses(profileId);
  const supps = new Map<number, IntakeItem>(
    getIntakeItems(profileId).map((s) => [s.id, s])
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
