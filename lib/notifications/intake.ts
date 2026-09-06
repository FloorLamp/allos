// Builds the intake-reminder notification for a send slot (a time-of-day
// window, or the workout-relative PreWorkout pseudo-slot — issue #1154), reusing
// the schedule helpers so workout/rest-day and situational logic is honored.
// The DB-touching gather lives here; the message formatting is the pure
// renderWindowMessage / renderMergedIntakeMessage in ./intake-format.

import { today } from "../db";
import { lastNDates, shiftDateStr, zonedDateParts } from "../date";
import {
  getIntakeItems,
  getIntakeDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  inferWorkoutSchedule,
  getIntakeAdherenceEvidence,
  effectiveSituationResolver,
  getMinutesSinceLastFoodLog,
} from "../queries";
import { foodTimingCheck } from "../food-timing-check";
import { getTimezone, getProfileAge } from "../settings";

import {
  adherenceSummary,
  doseStrip,
  doseWindowSince,
  indexTakenByDose,
} from "../intake-adherence";
import {
  doseBucketOn,
  doseDueOn,
  isPostWorkoutReady,
  timeBucket,
} from "../intake-schedule";
import type { IntakeItem, IntakeDose } from "../types";
import {
  doseSendSlot,
  notifiableWindowDoses,
  renderMergedIntakeMessage,
  type IntakeSendSlot,
  type IntakeSlotPart,
  type ReminderWindow,
  type StackOfferToken,
  type WindowDose,
} from "./intake-format";
import { preWorkoutSlotMinute } from "./schedule";
import { offerCallback } from "./offer-tokens";
import { mintOffer, readOfferRow } from "./offer-store";
import { isDoseDateAccepted } from "../dose-log-window";
import type { NotificationMessage } from "./types";
import { isOnDemand } from "../intake-schedule";
import { demotionCandidateItemIds } from "../rule-findings";
import { getUnconfirmedMedicationIds } from "../intake-history";
import { reminderOfferAction } from "./offer-tail";
import { getOfferedIntakeForSlot } from "../queries/intake";
import { now as clockNow } from "../clock";
import { getDoseCorrectionBursts } from "../queries/intake/adherence";
import { hasCorrectedAnyTime } from "../queries/correction-history";
import type { CorrectionDay } from "../correction-time";
import {
  correctionActions,
  correctionBodyStatement,
  correctionHintLine,
  correctionPickerActions,
  correctionPickerTitle,
  DOSE_TIME_PREFIXES,
} from "./correction-rows";
import {
  correctionMessageBinding,
  type CorrectionMessageRef,
} from "./message-pointers";
import { plainBody } from "./rich-text";
import { profileDayZone, travelExcusalResolver } from "../travel-excusal";

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
    // Which day level the open picker is showing (#3010).
    pickerLevel?: CorrectionDay;
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
    ? correctionPickerActions(
        DOSE_TIME_PREFIXES,
        profileId,
        open,
        now,
        tz,
        opts.pickerLevel ?? "today"
      )
    : correctionActions(DOSE_TIME_PREFIXES, profileId, bursts, tz, now);
  // The statement of record (#2264 bug 1): a corrected burst's stored time is stated in
  // the BODY — the label button states it too, but Telegram truncates buttons. One
  // computation with the food side (correctionBodyStatement over burstLabel).
  const statement = correctionBodyStatement(bursts, tz, now);
  // The twin of the food nudge's hint (#2874), from the same substrate helper: this
  // domain has carried the identical chips since #2020 and explained them nowhere, on
  // the side where the corrected instant arms the PRN redose window. It pairs with the
  // picker title exactly as the food side pairs them — an open drill-down asks its
  // question, and the hint takes its place otherwise — and it APPENDS, below the dose
  // content, so it can never displace the reminder itself. `bursts` is non-empty by the
  // early return above, so this never rides a message with nothing to correct.
  const hint = open
    ? null
    : correctionHintLine(DOSE_TIME_PREFIXES, hasCorrectedAnyTime(profileId));
  const lines = [
    plainBody(message.body),
    ...(open
      ? [correctionPickerTitle("when did you take these", open, tz)]
      : []),
    ...(hint ? [hint] : []),
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
  const { hhmm } = zonedDateParts(getTimezone(profileId), clockNow());
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// Whether this profile's `anytime` pre_workout doses are workout-relative
// (issue #1154 Fix A): true when a training cadence (and hence an hour) can be
// inferred, so a dose can never fall between slots.
//
// AS OF `date`, NOT AS OF NOW (#4026), which is the same split #4019 made one layer
// down for `predictedWorkoutDay`. The inference is a trailing window ending at its
// `asOf` day, so asking it today about a CLOSED day let a cadence that first became
// inferable this morning move yesterday's dose out of the slot yesterday's message
// named. `✅ All` is slot-scoped, so that stale token rebuilt EMPTY and wrote nothing
// while the message still listed the dose — and reconcile's death check needs
// `entries.length > 0`, so an empty rebuild is indistinguishable from "nothing to do"
// and the button never retires.
//
// ON A LIVE SEND, SLOT MEMBERSHIP AND THE PSEUDO-SLOT HOUR REDUCE TO THE SAME CALL —
// which is the whole of the invariant, and it is no longer one shared gate (#4030).
// Since this function became as-of-`date`, `getPreWorkoutSlotMinute` (the tick's and
// the escalation's hour) derives its own `inferWorkoutSchedule(profileId)` with no
// `asOf`. Every send passes today, where `asOf` defaults to today, so the two are the
// same inference over the same window; only a PAST-day rebuild asks this one about a
// closed day, and that path reads no hour. The hour must not be as-of-`date` anyway:
// it says when the pseudo-slot fires NOW.
function preWorkoutTimed(profileId: number, date: string): boolean {
  return inferWorkoutSchedule(profileId, undefined, date).hasPattern;
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
// NOTE: this gather is deliberately UNFILTERED by the #1156 obligation floor — the
// send-assembly layer (buildIntakeReminderForSlots / the finish nudge) and the
// button paths apply notifiableWindowDoses; the missed-dose escalation gather
// (lib/notifications/escalate.ts) reads THIS unfiltered set on purpose, so the
// safety tier is structurally never obligation-gated.
function gatherWindowDoses(
  profileId: number,
  slot: IntakeSendSlot,
  date: string,
  doses: IntakeDose[]
): WindowDose[] {
  const items = getIntakeItems(profileId).filter((item) => item.active);
  if (items.length === 0) return [];

  const itemById = new Map(items.map((item) => [item.id, item]));
  const taken = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  // Per-day DUENESS resolver for the whole gather — the day being reminded about and
  // every day of the strip below, each scored against what held THAT day, declared AND
  // derived (#654/#3993). One resolver, because a line that names a dose as owed and a
  // strip that scores the same day `na` are the same question answered twice. The span
  // is the strip's window widened to reach `date`, which on a late-tapped reminder can
  // sit before it — so the whole gather costs one read of each derived input.
  const stripStart = shiftDateStr(today(profileId), -(ADHERENCE_DAYS - 1));
  const situationsOn = effectiveSituationResolver(profileId, {
    from: date < stripStart ? date : stripStart,
    to: today(profileId),
  });
  const isForToday = date === today(profileId);
  // WHICH ACTIVITY READER, and the two are not interchangeable (#4019):
  // `getActivitiesByDate` is the raw row read, `getActivityDates` the same rows with
  // #3189's draft husks dropped, and the strip below already wanted the husk-free one.
  // Taking the raw reader to a closed day let one abandoned draft both conceal the
  // rest-day dose the day owed and offer a pre-workout dose it did not — and `✅ All`
  // writes what this gather returns. The raw read's only caller left is
  // `postWorkoutReady`, which needs session END TIMES and asks about the current minute.
  const workoutDays = new Set(getActivityDates(profileId));
  const activitiesToday = isForToday
    ? getActivitiesByDate(profileId, date)
    : [];
  // #558: a pre_workout reminder fires on a PREDICTED training day (so it can land
  // before the session), not only after a workout is logged; post_workout stays
  // gated on a logged session and held until it has ended. Only workout-
  // conditioned items are affected — a daily med reminder (safety tier) is
  // unconditional, so it never becomes workout-dependent.
  const nowMinutes = isForToday ? currentMinutesOfDay(profileId) : null;
  const ctx = {
    date,
    isWorkoutDay: isForToday
      ? activitiesToday.length > 0
      : workoutDays.has(date),
    // The situations active ON `date`, declared AND derived (#3973/#3993). Scoring a
    // past day against the set declared NOW moved yesterday's reminder whenever a
    // situation was toggled today; scoring it without the derived half dropped the
    // context the day actually carried.
    //
    // THERE IS NO TODAY/PAST BRANCH LEFT HERE, and its absence is the fix. The branch
    // existed because the derived widening was said to have no dated form — but a logged
    // period day, a weather spell and the night ending a day are each a fact about that
    // day, so one resolver answers for whichever day is being rebuilt — and the strip
    // below is built from that SAME resolver, so the line and its dots agree.
    activeSituations: situationsOn(date),
    // TODAY ONLY, the same split (#4019). The prediction is a rhythm inferred from a
    // trailing window ending NOW, and `conditionAppliesOn` reads it as
    // `predictedWorkoutDay ?? isWorkoutDay` — so on a closed day a guess made today
    // overrides the training already on the record. Undefined falls back to
    // `isWorkoutDay`, which is what the strip and `pendingDayDoses` both answer.
    //
    // THE WRITE MOVES BOTH WAYS, and the second way is the one to say out loud: a
    // PREDICTED training day with no session logged loses its pre-workout dose from
    // the rebuild, so `✅ All` on that message now writes nothing where it used to
    // write `taken`. #558 gives the prediction its job — landing a reminder BEFORE the
    // session — and that job is over once the day is closed; what the day actually
    // owed is then a question for the record, not the rhythm. #3996 has since ruled
    // that a rebuild reproduces the message AS SENT, and this is the one axis where
    // that rule cannot be honoured: the prediction has no dated form to reproduce, so
    // the record is all a closed day leaves to read.
    predictedWorkoutDay: isForToday
      ? isPredictedWorkoutDay(profileId, date)
      : undefined,
    postWorkoutReady: isPostWorkoutReady(
      activitiesToday.map((a) => a.end_time ?? a.start_time),
      nowMinutes
    ),
  };
  // #1154 Fix A: whether `anytime` pre_workout doses ride the PreWorkout
  // pseudo-slot instead of folding into Morning — as of the day being gathered.
  const workoutTimed = preWorkoutTimed(profileId, date);

  // Inputs for the per-dose adherence percentage. Anchored on the real
  // today (not `date`, which may be a prior day's reminder tapped late) so the
  // column window lines up with the drawn half of getIntakeAdherenceEvidence's
  // today-anchored range and with adherenceSummary's "last column is today, still
  // pending" rule. The evidence set is deliberately WIDER than the columns: the
  // lifetime bound inside the strip is not a windowed question (#3988).
  const windowDates = lastNDates(today(profileId), ADHERENCE_DAYS);
  const dayZone = profileDayZone(profileId);
  const takenByDose = indexTakenByDose(
    getIntakeAdherenceEvidence(profileId, ADHERENCE_DAYS)
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

  // TRAVEL (#3263): which of this profile's slots its own wall clock jumped over.
  // One resolver for the whole gather, and the SAME one the adherence denominator
  // reads — a slot the app has decided was impossible must not be counted against
  // the person AND must not be chased. Silence over a false miss.
  const isExcused = travelExcusalResolver(profileId);

  const entries: WindowDose[] = [];
  for (const dose of doses) {
    const item = itemById.get(dose.item_id);
    if (!item) continue;
    // The CALENDAR gate on the SEND path (#1602): a weekly med's reminder fires on its
    // on-days only, and an out-of-window taper row stops reminding without being
    // retired. This is the half that makes the whole feature safe to use — the item can
    // stay `must` (reminders + missed-dose escalation intact) precisely because the
    // machinery can now say "not today" instead of the user having to silence it.
    if (!doseDueOn(item, dose, ctx)) continue;
    // THE SLOT IS THE ONE THIS DOSE SAT IN ON `date`, NOT THE ONE IT SITS IN NOW
    // (#3996, ruled AS SENT). A rebuild reproduces a message already sent, so the
    // buttons under Tuesday's reminder mean what they meant on Tuesday — and `✅ All`
    // writes exactly the set this gather returns, so the bucket decides what a bulk
    // tap RESOLVES, not only what it says. `doseBucketOn` is the dated resolver for
    // that; the plain `timeBucket` beside it answers about today and is right for the
    // live surfaces. Same rule and same reason as the quick-log day switcher (#3936):
    // a slot label must name a slot the doses actually sat in.
    const bucket = doseBucketOn(dose, date);
    if (doseSendSlot(item.condition, bucket, workoutTimed) !== slot) continue;
    // The TRAVEL gate on the SEND path (#3263), the twin of the #1602 calendar gate
    // above: an eastward switch means this dose's hour never arrived on this
    // profile-local day, so there is nothing to remind about. A dose ALREADY
    // answered on that date stays in the gather — the person logged it, so the
    // message must still show it as done, and the log outranks the clock.
    //
    // THE CARVE-OUT COVERS THIS GATE ONLY, decided rather than inherited (#3997).
    // Excusal is a claim about the CLOCK, which a log on that date falsifies outright.
    // The dueness gate is a claim about the SCHEDULE, which it does not: taking a dose
    // the day never owed is an extra, and re-admitting it would put rows that are never
    // scheduled-due into the unfiltered set the missed-dose escalation reads.
    if (isExcused(bucket, date) && !taken.has(dose.id) && !skipped.has(dose.id))
      continue;
    // A dose is "due" on a past date when its item was due that day — workout and
    // situational logic both resolved per-day (situationsOn, #654), never as of now.
    const dd = takenByDose.get(dose.id);
    // Clamp the window to the dose's lifetime (#430/#1442) before summarizing it:
    // a fixed lookback over a med added this morning is all pre-existence days,
    // and scoring them would make the very first reminder announce "0% adherence".
    const since = doseWindowSince(
      item.created_at,
      dose.created_at,
      dd,
      dayZone
    );
    // …and the same bound gates the DAY (#4011), as `pendingDayDoses` already does:
    // `doseOnDay` reads only the declared start/end dates, so a stale keyboard rebuilt
    // for day−2 offered a dose for an item created this morning, and `✅ All` would
    // write `taken` and decrement real stock for it. A PAST-DAY rule by construction:
    // a dose row being read at all is proof it exists today.
    //
    // AND THE BOUND IS A FACT ABOUT THE ROW, NOT ABOUT WHERE THE PERSON IS STANDING
    // (#4025). A dose ALREADY ANSWERED on `date` was always safe — that log is inside
    // `dd`, and `doseWindowSince` widens the bound to it — but an UNANSWERED one used
    // to have no protection at all: resolving a historical `created_at` through the
    // profile's CURRENT zone let an eastward move walk the bound forward across a
    // stamp sitting near local midnight and drop a dose the day did own. `dayZone`
    // resolves each stamp through the zone in force at it, so this gate and the
    // adherence strip (which clamps on the same bound) give one answer for one day.
    // A zone move the app never recorded still leaves no evidence to read.
    if (!isForToday && since != null && date < since) continue;
    const strip = doseStrip(
      since ? windowDates.filter((d) => d >= since) : windowDates,
      (d) =>
        doseDueOn(item, dose, {
          date: d,
          isWorkoutDay: workoutDays.has(d),
          activeSituations: situationsOn(d),
        }),
      dd?.taken ?? new Set<string>(),
      dd?.skipped ?? new Set<string>(),
      (d) => isExcused(doseBucketOn(dose, d), d)
    );
    entries.push({
      dose,
      item,
      taken: taken.has(dose.id),
      skipped: skipped.has(dose.id),
      adherence: adherenceSummary(strip),
      // Ride-the-nag (#1505 part 2): a ⤓ May button appears on this dose's row only
      // while the item is a live demotion candidate. Detection state alone governs
      // it — an in-app dismissal deliberately does NOT remove it, because for a
      // tap-only user this is the only escape hatch that ever reaches them.
      demotable: demotableItemIds.has(item.id),
      // Ride-the-nag again (#2574): a Stop button appears on this dose's row only while
      // the item is a live unconfirmed-import candidate. Detection state alone governs
      // it, and any log of either status clears the candidacy on the next gather — so
      // the button cannot outlive the claim it is making.
      stoppable: unconfirmedItemIds.has(item.id),
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

// ---- The per-stack one-tap's stored offer (#3098, on #3268's substrate since
// #3282; the byte problem it solves is in ./callback-data.ts) ------------------
export const STACK_OFFER_FAMILY = "stack-take" as const;

type StoredStackOffer = { doseIds: number[] };

// The mint the DB-free renderer is handed. Re-offering the same members is a READ (see
// `mintOffer`), so a rebuild is byte-identical and the sweep stays at zero calls.
export function stackOfferToken(
  profileId: number,
  date: string
): StackOfferToken {
  return (doseIds) =>
    offerCallback(
      "stacktake",
      profileId,
      mintOffer(profileId, STACK_OFFER_FAMILY, date, {
        doseIds: [...doseIds],
      } satisfies StoredStackOffer)
    );
}

// The stack a token names and the DAY its doses belong to — or null for anything that
// is not this profile's stack offer, or whose day is outside the window `markDoseTaken`
// itself accepts. A pre-#3282 button lands in that same refusal: no offer id to read.
//
// THE DAY IS THE OFFER'S, NOT `today`. A dose's day is a fact the SCHEDULE established
// before the message was sent, so a reminder sent at 21:00 and tapped at 00:05 confirms
// the day it was sent for, through the predicate the `take:` and `all:` buttons beside
// it gate on. Scoping this to `today` deletes the button at midnight while its
// neighbours keep working — RECONCILE_DATE_GUARD["intake-dose"] calls that pure loss.
export function standingStackOffer(
  profileId: number,
  offerId: number,
  todayStr: string
): { doseIds: number[]; date: string } | null {
  const row = readOfferRow<StoredStackOffer>(
    profileId,
    STACK_OFFER_FAMILY,
    offerId
  );
  return row && isDoseDateAccepted(todayStr, row.date)
    ? { doseIds: row.payload.doseIds, date: row.date }
    : null;
}

// The dose-session message every send and every rebuild renders — the one place stack
// offers are minted, so no caller has to know they exist.
export function renderDoseSession(
  profileId: number,
  parts: IntakeSlotPart[],
  date: string
): NotificationMessage {
  return renderMergedIntakeMessage(
    profileId,
    parts,
    date,
    getProfileAge(profileId),
    stackOfferToken(profileId, date)
  );
}

// The merged send for every slot due (and unsent) this hour — issue #1154's
// one-reminder-per-hour invariant. Gathers each slot, applies the #1156 obligation
// floor, drops empty slots, and renders ONE message (a single slot renders the
// classic window message). Returns null — no send — when nothing is due after
// the floor, or when EVERY dose across the merged set is already resolved
// (taken or deliberately skipped, #232): the empty/all-resolved check runs on the
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
    renderDoseSession(profileId, parts, date)
  );
  // RIDE-ALONG (#1505 Part 1, class 3). A reminder that is going out anyway for this
  // slot's must/should doses carries a More… row exposing the SAME slot's `may`
  // items. Convenience only — the digest tail is the guaranteed path — and inherently
  // slot-correct, because the reminder IS the slot.
  //
  // It costs no send: the message already exists. That is the only reason it is
  // allowed to exist at all ("a suggestion may only decorate a send that exists for
  // its own reasons").
  const nowHhmm = zonedDateParts(getTimezone(profileId), clockNow()).hhmm;
  const offered = getOfferedIntakeForSlot(profileId, nowHhmm);
  if (offered.length > 0) {
    message.actions = [
      ...(message.actions ?? []),
      // The REMINDER's wording, not the digest's (#2890): this keyboard already
      // carries "✅ All (N)", and a second bare dose count beside it would be two
      // numbers that mean different things and cannot be added up.
      reminderOfferAction(profileId, date, offered.length),
    ];
  }
  return { message, slots: parts.map((p) => p.slot) };
}

// Reminder for intake items due in one slot today, or null when nothing is due —
// including when every dose for the slot is already logged, so a reminder is
// never sent just to say everything's done. (The tick sends via
// buildIntakeReminderForSlots; this single-slot form serves the manual CLI mode
// and keeps the classic per-window shape.)
export function buildIntakeReminder(
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
  const items = new Map<number, IntakeItem>(
    getIntakeItems(profileId).map((s) => [s.id, s])
  );
  // As of the message's OWN day (#4026), the same question `gatherWindowDoses` asks:
  // this rebuild derives the slots from the surviving buttons of a message that may be
  // a day or two old, so today's cadence must not re-file its doses.
  const workoutTimed = preWorkoutTimed(profileId, date);
  const wanted = new Set<IntakeSendSlot>(slots);
  const doseById = new Map(doses.map((d) => [d.id, d]));
  for (const id of doseIds) {
    const d = doseById.get(id);
    if (!d) continue;
    const item = items.get(d.item_id);
    if (!item) continue;
    wanted.add(
      doseSendSlot(item.condition, doseBucketOn(d, date), workoutTimed)
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
