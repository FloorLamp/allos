// THE MONTHLY FOOD-HABIT OBSERVATION (issue #2397) — pure, DB-free, clock-free.
//
// One sentence: *"Fatty fish 12 of 26 logged days, a source of Omega-3."* Two facts and
// nothing else. The count comes from the ledger (lib/food-regularity.ts's day-grain
// measure); the nutrient half comes from the curated, human-reviewed
// nutrient-food map that #577's food suggestions already read in the OPPOSITE
// direction. Nothing is inferred, and no new knowledge is introduced.
//
// ── THE RULE THIS MODULE EXISTS TO KEEP ──────────────────────────────────────
//
// #2397's second shape — *"you consistently consume alcohol, and your liver biomarkers
// are flagged"* — is two true statements placed side by side so the reader draws a
// third the app has no standing to assert. Flagged liver enzymes have many causes; the
// app's whole disclaimer posture exists to avoid exactly this move, and juxtaposition
// is an assertion however carefully the sentence is worded.
//
// So the boundary is structural, not editorial:
//
//   • An observation carries a GROUP, a DAY COUNT, a DENOMINATOR and a NUTRIENT NAME.
//     There is no field for a biomarker, a reading, a flag or a direction, so no
//     renderer downstream can pair one with a pattern by choosing to.
//   • The rationale is resolved from the food group's own declared `nutrients` (the
//     catalog's curated links) through the map's nutrient LABEL. The map entry's
//     `biomarkers` array is never read here — see the test that pins it.
//   • Curated knowledge may still relate a food to a biomarker (that is #577's and
//     #2377's direction, and it is sourced). What is forbidden is the app observing
//     YOUR pattern, observing YOUR result, and implying the first explains the second.
//     Pattern detection may not diagnose.
//
// ── AND IT REPORTS EATING, NOT RECORD-KEEPING ────────────────────────────────
//
// #1955's caveat, restated by #2397: a habit line risks congratulating diligent
// LOGGING. The denominator says so out loud — "of 26 logged days", not "of 30 days" —
// so the sentence is explicitly about the days this person recorded, and someone who
// eats fish without logging it is not being ranked below someone who logs everything.

import { foodGroupBySlug, foodGroupName } from "./food-groups";
import { nutrientFoodEntryForKey } from "./datasets/nutrient-food-map";
import { periodFoodHabits, type FoodPeriodRegularity } from "./food-regularity";

// How many groups one observation line names. Three: enough for a period's diet to be
// recognisable, few enough that the line stays a sentence rather than a diary.
export const FOOD_HABIT_MAX_NAMED = 3;

// How many nutrients one group's rationale names. Two — "a source of Iron and Vitamin
// B12" is a reason; four is a label off a cereal box.
export const FOOD_HABIT_MAX_NUTRIENTS = 2;

// One group's period observation, ready to be worded by a message builder.
export interface FoodHabitObservation {
  groupKey: string;
  /** The catalog display name — "Fatty fish". */
  label: string;
  /** Days in the period this group was logged on. */
  days: number;
  /** Days in the period ANY food was logged on — the shared denominator. */
  observedDays: number;
  /** The curated nutrient clause — "a source of Omega-3". Never a biomarker. */
  rationale: string;
}

// "Omega-3 (EPA/DHA)" → "Omega-3". The parenthetical is precision a lab panel needs and
// a habit sentence does not, and #2391's grammar already warns what happens when an
// annotation carrying parentheses is nested inside another.
function nutrientNoun(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function joinNouns(nouns: readonly string[]): string {
  return nouns.length <= 1
    ? (nouns[0] ?? "")
    : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

// The curated nutrient clause for a food group, or null when the catalog links it to no
// tracked nutrient (water, sweets, fried food — and alcohol, which has no `nutrients`
// entry at all). Null means the group is not stated: an observation with no rationale
// is a bare frequency count, which is the half of #2397 that was never the point.
//
// READS THE CATALOG LINK AND THE NUTRIENT LABEL, NOTHING ELSE. `NutrientFoodEntry` also
// carries the biomarker families that nutrient is read from; this function does not
// touch them, and `food-habit-observation.test.ts` fails if this module ever mentions
// them.
export function foodHabitRationale(groupKey: string): string | null {
  const group = foodGroupBySlug(groupKey);
  if (!group) return null;
  const nouns = group.nutrients
    .map((key) => nutrientFoodEntryForKey(key)?.label)
    .filter((label): label is string => label != null)
    .map(nutrientNoun)
    .slice(0, FOOD_HABIT_MAX_NUTRIENTS);
  return nouns.length > 0 ? `a source of ${joinNouns(nouns)}` : null;
}

// The period's stateable food habits, share-descending. Empty for a period under the
// measure's gate (silence — no expectation), for a period whose groups all fall under
// the period threshold, and for every cap-direction group (`excluded`, #2380/#998:
// "you consistently consume alcohol" is the sentence in a longer window, and this app
// does not say it — the cap vocabulary owns that scope, against a cap the user set).
export function foodHabitObservations(
  period: FoodPeriodRegularity | null,
  opts: { excluded?: ReadonlySet<string> } = {}
): FoodHabitObservation[] {
  if (!period) return [];
  const out: FoodHabitObservation[] = [];
  for (const group of periodFoodHabits(period, opts)) {
    const rationale = foodHabitRationale(group.groupKey);
    if (!rationale) continue;
    out.push({
      groupKey: group.groupKey,
      label: foodGroupName(group.groupKey),
      days: group.days,
      observedDays: period.observedDays,
      rationale,
    });
    if (out.length === FOOD_HABIT_MAX_NAMED) break;
  }
  return out;
}

// One observation as a sentence. A SHARE with its denominator named, then the curated
// reason. No run, no comparison to a previous period (that delta is the streak #1955
// cut wearing a nutrient's clothes), and no second subject.
export function foodHabitSentence(observation: FoodHabitObservation): string {
  return `${observation.label} ${observation.days} of ${observation.observedDays} logged days, ${observation.rationale}`;
}
