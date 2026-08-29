// The composed "your usual <window>" offer (#2458): the food half's slugs plus the
// doses this profile DECLARED for that window and still owes today.
//
// One gather for one question, so the dashboard control, the write core and the
// Telegram button (#2460) can never describe three different bundles. The pure rule
// is `usualRoutineOffer` (lib/usual-routine.ts); this only assembles its inputs from
// the profile's own state — which is exactly what lets the write core re-derive the
// SAME bundle against fresh state instead of trusting a submitted list.
//
// READ COST. The food half is the GATE and is evaluated FIRST: with no food offer the
// function returns before touching intake at all, so the dashboard pays for the dose
// reads only on the mornings the control would actually render (#2110/#2115 are the
// cautionary neighbours). When it does pay, it pays for four bounded per-profile reads
// already used by every other dueness surface — not a per-dose fan-out.
//
// Profile-scoped: every read below takes `profileId` and the dose rows are scoped
// through their parent item's `profile_id` (getIntakeDoses).

import {
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
} from "./training";
import { getIntakeItems } from "./intake";
import { getIntakeDoses } from "./intake/schedule";
import { getSkippedDoseIds, getTakenDoseIds } from "./intake/adherence";
import { getEffectiveActiveSituations } from "./derived-situations";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
} from "../settings";

import { doseWindowSince } from "../intake-adherence";
import { travelExcusalResolver } from "../travel-excusal";
import { situationsActiveOn } from "../trend-annotations";
import { db, today } from "../db";
import { doseBucketOn, doseDueOn, type TimeBucket } from "../intake-schedule";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import type { FoodSlot } from "../food-slot";
import {
  usualRoutineOffer,
  type UsualRoutineDose,
  type UsualRoutineOffer,
} from "../usual-routine";
import { getUsualFoodOffer } from "./nutrition";
import { getActiveFastCached } from "./fasting";
import { standsDownUsualRoutine } from "../fasting-standdown";
import { now as clockNow } from "../clock";

// The doses one tap would confirm for `window` on `date`: DECLARED in that window,
// due that day, and not yet taken or skipped.
//
// The four memberships, and the predicate each rides:
//
//   • declared in this window — the bucket the dose occupied ON `date`
//     (`doseBucketOn`, see PendingDayDose below), the profile's own stated intent as
//     it stood that day. A `FoodSlot` is spelled exactly like the `TimeBucket` it
//     names, so the comparison is direct; a "Before sleep" or "Anytime" dose is never
//     in a food window's bundle;
//   • due today — `doseDueOn`, the ONE dueness question (#1602/#221). It carries the
//     `may` short-circuit, the calendar gate, the workout/rest condition and the
//     situational hold, so this function declares none of those itself;
//   • active — the item's own flag;
//   • unresolved — neither taken nor skipped today. A deliberate skip is an answer,
//     and re-offering it would be the app arguing with the user.
//
// Deliberately NOT `collectWindowDoses`: that gather is the SEND path's, and it maps
// through `doseSendSlot` (folding `anytime` pre-workout doses into Morning) and builds
// a 30-day adherence strip plus the demotion-candidate scan for every dose. Neither is
// wanted here — the offer is about the window the user DECLARED, and a dashboard read
// must not pay for a reminder's furniture.
export function getPendingRoutineDoses(
  profileId: number,
  window: FoodSlot,
  date: string
): UsualRoutineDose[] {
  return pendingDayDoses(profileId, date).filter((d) => d.bucket === window);
}

// One unresolved dose plus the bucket it occupied ON `date` — `doseBucketOn`, the
// schedule version in force that day, NOT the current row (#1973). A dose moved
// evening → morning last week was an evening dose the week before, and the day's
// dueness is already judged that way two lines down (`doseDueOn` → `doseOnDay` is
// effective-dated), so reading the live `time_of_day` for the heading would file a row
// under a slot that never held it while judging it by the rule that did. The bulk row
// makes that worse than cosmetic: two moved doses would render "Morning stack (2)", a
// group label naming a slot none of them sat in, which is the label-is-a-promise rule
// (#3098) broken by the surface that quotes it.
export interface PendingDayDose extends UsualRoutineDose {
  bucket: TimeBucket;
}

// ── WHAT THIS FUNCTION CONSULTS, AND HOW EACH INPUT TREATS `date` ────────────
//
// `date` may be a PAST day here, which no other caller of most of these readers
// passes. Three separate defects came from an input written for today being handed a
// closed day, so the audit is recorded beside the code rather than in a review
// thread. "Date-resolved" means the input answers for `date` itself; "current-state"
// means it answers for now and there is no dated source to ask instead.
//
//   INPUT                     TREATMENT
//   situations (declared)     date-resolved — situationsActiveOn past / effective today
//   situations (derived)      today only; excluded on a past day (#654). NOTE: on TODAY
//                             this sheet unions derived names while the strip's own
//                             today-dot is declared-only — pre-existing, and the reason
//                             the agreement below is asserted over PAST days.
//   dose lifetime             date-resolved — doseWindowSince (#430/#1442). Its
//                             backwards widening reads ALL history, and so does the
//                             evidence supplied at every site that computes this bound
//                             — #3988 converted five, #4020 found and converted the
//                             sixth (lib/rule-findings.ts) — so they agree on the rule
//                             AND on the facts (pinned in the action tier). The census
//                             that settles "how many sites" is the one in
//                             lib/__db_tests__/adherence-bound-evidence.test.ts; two
//                             earlier ones each missed a caller by counting a narrower
//                             set.
//   travel excusal            DATE resolved, SLOT is not — isExcused reads the current
//                             `time_of_day` and today's notify schedule, so a re-timed
//                             dose is excused by a slot it may not have occupied. The
//                             strip does exactly the same, so they agree; neither is
//                             version-resolved (#3263).
//   workout logged            date-resolved — getActivityDates on a past day, which
//                             drops draft husks (#3189); the raw per-date read is for
//                             TODAY only, as everywhere else in the repo.
//   workout predicted         today only (#558); a past day falls back to what was
//                             logged, as the strip does.
//   cadence — dose half       date-resolved — doseOnDay over the schedule versions.
//   cadence — item half       CURRENT-STATE — cadenceOn reads the item's live
//                             cadence_kind/weekdays/interval/anchor; no version table
//                             exists for them. Same for the strip.
//   time bucket               date-resolved — doseBucketOn (#1973).
//   resolution state          date-resolved — taken/skipped ids for `date`.
//   item.active               CURRENT-STATE, no dated source. Deactivating an item
//                             today therefore hides yesterday's owed dose from this
//                             sheet. The strip has the same gap; a fix needs a schema
//                             decision, not a second opinion here.
//   condition / situation /   CURRENT-STATE, no dated source. Same for the strip.
//   pause_situation
//   dose.retired              CURRENT-STATE — a bare flag, no `retired_at`.
//   amount / product          CURRENT-STATE — the version table carries time_of_day,
//                             weekdays and the validity dates, NOT the amount, so a
//                             catch-up records today's. The audited backfill core has
//                             the same property.
//   timezone                  CURRENT zone, applied to stored UTC created_at stamps.
//   suppression               ABSENT — deliberate: this rides the offer contract, which
//                             does not filter it. `collectDueDosesNow` (today's list in
//                             the same sheet) DOES, so the sheet answers that question
//                             two ways across its own day boundary. Stated, not fixed.
//   supply                    not read here; markDoseTaken moves it in the write core.
//
// EVERY dose `date` still owes, across all five buckets (#3936) — the whole-day set
// the window-scoped offer above is a filter over, so the recent-past catch-up view
// and the composed one-tap can never disagree about what a day still owes.
//
// The four memberships are the ones documented above; only the window filter moves
// out. `date` is a profile-LOCAL day and every read below is scoped by `profileId`.
export function pendingDayDoses(
  profileId: number,
  date: string
): PendingDayDose[] {
  const items = getIntakeItems(profileId).filter((s) => s.active);
  if (items.length === 0) return [];
  const byId = new Map(items.map((s) => [s.id, s]));
  const taken = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  // The day context, resolved ONCE. THE SITUATION SET IS ASKED PER DAY (#654), and the
  // today/past split below is the one `intakeAdherenceStrip` and the reminder gather
  // already make — it is not a new policy, it is this function joining the existing one:
  //
  //   • TODAY  — `getEffectiveActiveSituations`: declared-now ∪ derived. Correct for a
  //     SURFACING path, and byte-identical to what this function did before, so the
  //     composed one-tap offer riding `getPendingRoutineDoses` is untouched.
  //   • A PAST DAY — `situationsActiveOn`: the DECLARED set reconstructed as of that day
  //     from the dated change log, and deliberately WITHOUT the derived half, exactly as
  //     lib/notifications/intake.ts says ("the history resolver owns retroactive
  //     membership, so it must NOT see derived names") and as `intakeAdherenceStrip`
  //     scores its dots.
  //
  // Both directions of the bug this closes were silent. Declaring Travel today used to
  // make the switcher claim two days of travel doses you never owed — and a tap would
  // have written `taken` and decremented on-hand supply for a dose that was not due.
  // Turning a situation OFF hid the days you were actually ill, which is the feature
  // defeating its own purpose: the doses most likely to be missed are the ones tied to a
  // situation that has since ended. It also made this sheet disagree with the adherence
  // strip that #3917's own missed-day offer is computed from — two catch-up surfaces,
  // one question, two answers (#221).
  const isToday = date === today(profileId);
  // Only a PAST day needs the husk-free list, so today's path — the one the composed
  // one-tap offer rides — pays for no extra read at all.
  const trainedOn = isToday
    ? new Set<string>()
    : new Set(getActivityDates(profileId));
  const ctx = {
    date,
    // WHICH READER, and the two are not interchangeable. `getActivitiesByDate` is the
    // raw row read; `getActivityDates` is the same rows with DRAFT HUSKS DROPPED
    // (#3189 — create-at-start writes the row at the session's first second, so a
    // session opened and abandoned carries a date like any other). Every other pairing
    // in the repo splits them exactly this way — today from the raw read, a past day
    // from the husk-free list — and taking the today reader to a closed day let one
    // abandoned draft both CONCEAL a rest-day dose the day owed and OFFER a
    // pre-workout dose it did not, the two harms this sheet exists to prevent. The
    // strip reads `getActivityDates` too, which is what makes the agreement real
    // rather than a restatement.
    isWorkoutDay: isToday
      ? getActivitiesByDate(profileId, date).length > 0
      : trainedOn.has(date),
    activeSituations: isToday
      ? getEffectiveActiveSituations(profileId, date)
      : situationsActiveOn(
          date,
          getActiveSituations(profileId),
          getSituationEvents(profileId)
        ),
    // THE SAME TODAY/PAST SPLIT, and found by auditing the rest of this seam rather
    // than by a third review round. `conditionAppliesOn` reads
    // `predictedWorkoutDay ?? isWorkoutDay`, and the prediction is a pattern inferred
    // from a TRAILING window ending today — so on a past day it lets a guess made now
    // override the training that is already on the record. #558 wants it for TODAY (a
    // pre-workout reminder has to be able to land BEFORE the session is logged); a
    // closed day has no such need, and `intakeAdherenceStrip` passes no prediction at
    // all. Undefined falls back to `isWorkoutDay`, which is exactly the strip's answer.
    predictedWorkoutDay: isToday
      ? isPredictedWorkoutDay(profileId, date)
      : undefined,
  };
  // THE LIFETIME CLAMP (#430/#1442), the same bound `intakeAdherenceStrip` treats as
  // load-bearing. Without it every item a person adds grows two phantom past-day
  // obligations: `doseOnDay` reads only the DECLARED start/end dates and never
  // `created_at`, so a supplement created this morning was "due" the two days before
  // it existed — and a tap would write a taken row and decrement real stock for a day
  // the dose was not there. No-op for today by construction (the bound is a creation
  // DAY, and today is never before it), so the composed one-tap offer is untouched.
  //
  // `doseWindowSince` widens the bound backwards by the dose's own logged history,
  // because a log row is PROOF the dose existed on its date and can legitimately
  // predate `created_at` (a reconciled med, a backfilled course). It reduces those
  // dates to a MINIMUM, so the earliest logged date alone carries the same answer as
  // the full set — which is what this one grouped read fetches instead of every row.
  // The adherence strip's callers now widen the SAME bound with the same aggregate,
  // as the second arm of `getIntakeAdherenceEvidence` (#3988); this seam keeps its own
  // read because it draws no window to union that half against.
  const tz = getTimezone(profileId);
  const firstLog = new Map(
    (
      db
        .prepare(
          `SELECT l.dose_id AS doseId, MIN(l.date) AS firstDate
             FROM intake_item_logs l
             JOIN intake_item_doses d ON d.id = l.dose_id
             JOIN intake_items s ON s.id = d.item_id
            WHERE s.profile_id = ?
            GROUP BY l.dose_id`
        )
        .all(profileId) as { doseId: number; firstDate: string }[]
    ).map((r) => [r.doseId, r.firstDate])
  );
  // TRAVEL (#3263). "If the app decides a slot was impossible, it must neither count
  // it nor chase it" — the strip drops an excused unanswered dose from the day's
  // denominator and the reminder tick stays silent, so a catch-up sheet that still
  // asked for it would be the third reading of one fact. Resolved once; the resolver
  // short-circuits to a constant `false` for the overwhelming majority of profiles,
  // which have never travelled. `dose.time_of_day` is the CURRENT row's slot, which is
  // what the strip passes too — one shared reading, not a second one.
  const isExcused = travelExcusalResolver(profileId);
  const out: PendingDayDose[] = [];
  for (const dose of getIntakeDoses(profileId)) {
    const item = byId.get(dose.item_id);
    if (!item) continue;
    if (taken.has(dose.id) || skipped.has(dose.id)) continue;
    if (!doseDueOn(item, dose, ctx)) continue;
    const since = doseWindowSince(
      item.created_at,
      dose.created_at,
      {
        taken: new Set([firstLog.get(dose.id)!].filter(Boolean)),
        skipped: new Set(),
      },
      tz
    );
    if (since != null && date < since) continue;
    // Only an UNANSWERED dose can be excused — every dose reaching here is unresolved
    // by definition, so the strip's "a log overrules the clock" carve-out is already
    // satisfied above.
    if (isExcused(dose.time_of_day ?? null, date)) continue;
    out.push({
      bucket: doseBucketOn(dose, date),
      doseId: dose.id,
      itemId: item.id,
      name: item.name,
      detail:
        item.kind === "medication"
          ? formatMedicationDoseProduct(dose.amount, item.product)
          : dose.amount,
      // The item's stack label (#3098), feeding the label compression in
      // `usualRoutinePhrase` when the whole rider shares one.
      stack: item.stack,
    });
  }
  return out;
}

// WHAT ONE TAP WOULD WRITE right now, both halves, for one window on one day — or
// `null` for no control at all. The food half gates; the dose half rides.
//
// THE FASTING STAND-DOWN (#2757). While a fast is ACTIVE this offer stands down — the
// OFFER, never the LOGGING (#2419). Every food row on every surface stays exactly as
// loggable, the dose controls elsewhere are untouched, and a log fired anyway meets
// #2756's "End your fast?" follow-up; what goes away is the app proposing a meal to
// someone who has just told it they are not eating. Checked FIRST, before the food
// gather, so a standing-down profile pays for no reads at all.
//
// The dose half of the bundle goes with it, and that is a consequence of the bundle
// rather than a second decision: the food half is this offer's GATE (no food offer, no
// control), so there was never a dose-only shape of it. Nothing about a dose's own
// dueness, its reminder, or its control anywhere else in the app changes — the
// stand-down's reach over SENDS is a closed one-kind allowlist
// (lib/fasting-standdown.ts) that cannot name a dose kind.
export function getUsualRoutineOffer(
  profileId: number,
  window: FoodSlot,
  date: string
): UsualRoutineOffer | null {
  if (standsDownUsualRoutine(getActiveFastCached(profileId), clockNow()))
    return null;
  const groups = getUsualFoodOffer(profileId, window, date);
  if (groups.length === 0) return null;
  return usualRoutineOffer(
    window,
    groups,
    getPendingRoutineDoses(profileId, window, date)
  );
}
