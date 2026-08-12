// THE GATHER for the curated limit direction at the log tap and in the digest (issue
// #2377). The DECISION is not here: lib/food-limit-note.ts is pure and owns every rule,
// every threshold and every string. This module only assembles that function's inputs
// from the profile's own state — the #448 builder discipline, and the reason both
// surfaces answer from one computation.
//
// It declares NO knowledge of its own. The curated limits come from the #577/#775
// engine's own output (`suggestFoods` through `getFoodSuggestions`), so every safety
// screen that engine applies — allergies, the food–drug inverse, condition
// contraindications, dietary preferences — has already run before anything here sees a
// suggestion, and this module cannot accidentally ship a second, unscreened copy of the
// map.
//
// Three inputs, three existing readers, no new SQL knowledge:
//   • the live limits            → getFoodSuggestions (the #577/#775 engine)
//   • the interaction findings   → foodDrugEventFindingsFor (the #2021 ledger)
//   • the cap-governed groups    → getCapDirectionFoodGroups (#2380's own exclusion)
// plus the shared suppression bus (getFindingSuppressions), so a `food-reduce:` family
// the user has already dismissed on the biomarker page or the coaching tab cannot be
// resurrected by a log tap. One dismiss, every surface (#39).

import { db, today as profileToday } from "../db";
import { cache } from "../request-cache";
import { isHiddenUnderPolicy } from "../lifecycle";
import { foodDrugEventFindingsFor } from "../food-drug-ledger-findings";
import {
  activeFoodLimits,
  foodLimitDayObservations,
  foodLimitTapNote,
  type ActiveFoodLimit,
  type DietaryLimitCandidate,
  type FoodLimitDayObservation,
  type FoodLimitTapNote,
} from "../food-limit-note";
import { getCurrentFlaggedBiomarkers } from "./medical";
import {
  getCapDirectionFoodGroups,
  getFoodSuggestions,
  getFoodServingsOnDate,
} from "./nutrition";
import { getFindingSuppressions } from "./upcoming/suppressions";

// The profile's live curated limits with the dismissed families removed, request-cached
// because the tap path and the digest path both want it and the engine behind it runs
// the whole safety gather.
//
// A SNOOZE IS JUDGED AGAINST THE PROFILE'S TODAY, never against the day being reported
// on. The digest asks about YESTERDAY's log, and asking the bus "was this snoozed
// yesterday?" would resurrect a line the user has silenced for today — the day the
// message actually arrives. Suppression is a fact about now.
const liveFoodLimits = cache(function liveFoodLimits(
  profileId: number
): ActiveFoodLimit[] {
  const today = profileToday(profileId);
  const limits = activeFoodLimits(getFoodSuggestions(profileId));
  if (limits.length === 0) return limits;
  const suppressions = getFindingSuppressions(profileId);
  // "normal" policy: an ordinary coaching-tier dietary suggestion is fully silenceable.
  // It is emphatically NOT safety-ungated — that carve-out belongs to dose reminders and
  // missed-dose escalations, and a curated dietary claim is not in their company.
  return limits.filter(
    (l) => !isHiddenUnderPolicy("normal", suppressions.get(l.dedupeKey), today)
  );
});

// The days, strictly before `date`, on which this group was logged at or after `since` —
// the arming fact behind `firstSinceActive`. Zero means this tap is the first serving of
// the group since the limit became active.
//
// Reads the day counter rather than the event ledger: the question is which DAYS carry a
// serving, which is exactly what one food_log row per (profile, date, group) states, and
// it is the same counter the tap itself moves. Profile-scoped.
function daysLoggedSince(
  profileId: number,
  groupKey: string,
  since: string,
  date: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM food_log
        WHERE profile_id = ? AND group_key = ?
          AND date >= ? AND date < ? AND servings > 0`
    )
    .get(profileId, groupKey, since, date) as { n: number };
  return row.n;
}

// The day a limit BECAME ACTIVE: the earliest collection date among the currently-flagged
// readings that triggered it. Earliest rather than latest, so a second marker joining an
// already-live family (ApoB arriving beside LDL-C) does not re-arm a note the family has
// already spent — the family is the dedupe unit (#482) and it is the arming unit too.
//
// Null when none of the triggering names resolves to a dated current reading, which is
// the target-trigger door (#2383) rather than the biomarker one. A limit with no
// activation date is never armed: the whole gate is "since WHEN", and inventing a date
// would make it fire on every first-of-day tap forever.
function activationDate(
  limit: ActiveFoodLimit,
  flaggedDates: Map<string, string>
): string | null {
  let earliest: string | null = null;
  for (const name of limit.triggeredBy) {
    const date = flaggedDates.get(name.trim().toLowerCase());
    if (date && (earliest === null || date < earliest)) earliest = date;
  }
  return earliest;
}

// THE LOG-TAP NOTE for one serving that was just written, or null for silence.
//
// Called AFTER the write, deliberately: the food–drug ledger detects a co-occurrence from
// the day's servings, so the serving has to be on the counter for it to see one. Which is
// also why `servingsBefore` is passed in by the caller from the write's own authoritative
// post-write total rather than re-read here — after the write, the count this tap
// produced is indistinguishable from one that was already there.
//
// #559 is intact end to end: this runs after the row landed and can only produce text.
// Nothing here can refuse, block, warn-before-write or undo a log.
export function getFoodLimitTapNote(
  profileId: number,
  groupKey: string,
  date: string,
  // The group's day total BEFORE this tap — `servings - 1` from the write's own answer.
  servingsBefore: number
): FoodLimitTapNote | null {
  const capGoverned = getCapDirectionFoodGroups(profileId);
  const interactions = foodDrugEventFindingsFor(profileId, date);
  // The dietary half is only assembled when it could possibly speak: the day's first
  // serving, of a group no cap governs. An interaction can still speak past both, so it
  // is gathered above unconditionally and the pure decision ranks them.
  let dietary: DietaryLimitCandidate[] = [];
  if (servingsBefore === 0 && !capGoverned.has(groupKey)) {
    const flaggedDates = new Map<string, string>();
    for (const r of getCurrentFlaggedBiomarkers(profileId))
      flaggedDates.set(r.name.trim().toLowerCase(), r.date);
    dietary = liveFoodLimits(profileId)
      .filter((l) => l.groupKeys.includes(groupKey))
      .map((limit) => {
        const since = activationDate(limit, flaggedDates);
        return {
          limit,
          firstSinceActive:
            since !== null &&
            daysLoggedSince(profileId, groupKey, since, date) === 0,
        };
      });
  }
  return foodLimitTapNote({
    groupKey,
    servingsBefore,
    capGoverned: capGoverned.has(groupKey),
    interactions,
    dietary,
  });
}

// THE DIGEST OBSERVATION for one day: the groups that day's log contains which a live
// curated limit names. Empty is silence.
//
// Carries no biomarker by construction (see FoodLimitDayObservation) — this is the
// pattern-shaped surface, and the rule is that a pattern is never named beside a result.
export function getFoodLimitDayObservations(
  profileId: number,
  date: string
): FoodLimitDayObservation[] {
  const limits = liveFoodLimits(profileId);
  if (limits.length === 0) return [];
  const servings = getFoodServingsOnDate(profileId, date);
  const loggedGroups = [...servings]
    .filter(([, n]) => n > 0)
    .map(([groupKey]) => groupKey);
  if (loggedGroups.length === 0) return [];
  return foodLimitDayObservations({
    loggedGroups,
    limits,
    capGoverned: getCapDirectionFoodGroups(profileId),
  });
}
