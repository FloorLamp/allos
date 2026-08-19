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

import { getActivitiesByDate, isPredictedWorkoutDay } from "./training";
import { getIntakeItems } from "./intake";
import { getIntakeDoses } from "./intake/schedule";
import { getSkippedDoseIds, getTakenDoseIds } from "./intake/adherence";
import { getEffectiveActiveSituations } from "./derived-situations";
import { doseDueOn, timeBucket } from "../intake-schedule";
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
//   • declared in this window — `timeBucket(dose.time_of_day)`, the profile's own
//     stated intent. A `FoodSlot` is spelled exactly like the `TimeBucket` it names,
//     so the comparison is direct; a "Before sleep" or "Anytime" dose is never in a
//     food window's bundle;
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
  const items = getIntakeItems(profileId).filter((s) => s.active);
  if (items.length === 0) return [];
  const byId = new Map(items.map((s) => [s.id, s]));
  const taken = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  // The day context, resolved ONCE — the same effective situation set (declared ∪
  // derived) every other dueness surface reads, so the offer cannot disagree with the
  // page about whether a situational item applies today.
  const ctx = {
    date,
    isWorkoutDay: getActivitiesByDate(profileId, date).length > 0,
    activeSituations: getEffectiveActiveSituations(profileId, date),
    predictedWorkoutDay: isPredictedWorkoutDay(profileId, date),
  };
  const out: UsualRoutineDose[] = [];
  for (const dose of getIntakeDoses(profileId)) {
    const item = byId.get(dose.item_id);
    if (!item) continue;
    if (timeBucket(dose.time_of_day) !== window) continue;
    if (taken.has(dose.id) || skipped.has(dose.id)) continue;
    if (!doseDueOn(item, dose, ctx)) continue;
    out.push({
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
