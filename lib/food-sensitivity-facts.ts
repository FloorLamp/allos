// The summary row of the `Add sensitivity` form (#5865, over #3218's primitive and
// #5300's grammar).
//
// THE TRIGGER IS NOT A FACT HERE, and that is rule 1 rather than an omission. "Dairy",
// "Spicy" is what the declaration IS — the identifying field above the chips, the thing
// the catalog row is named after — and a form whose identifying field also appeared as
// a chip would be summarising the heading back at the person.
//
// WHY `effect` IS ESSENTIAL. A declaration with no effect is not a smaller declaration,
// it is a different statement: "spicy food does something to me" names nothing to
// count, and the pair this row authorises cannot be built without the outcome stream
// the effect chooses. The dashed prompt is that gap said where it can be answered, and
// the write refuses without it either way — the chip is what stops the refusal being
// the first the person hears of it.
//
// AND WHY `note` IS OPTIONAL. "Only the very hot ones" is worth keeping and worth
// nothing to any reader but the person who wrote it: nothing counts it, nothing matches
// on it, and a dashed prompt for it would say the app wanted something it has no use
// for. It stays reachable behind the one trailing affordance, which names it.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock.

import { effectLabel } from "./food-sensitivities";
import { recordFactRow, type RecordFactSummary } from "./record-facts";

/** The facts, in the order the row draws them. */
export type FoodSensitivityFactKey = "effect" | "note";

/** The nouns, so the trailing affordance can name what it holds. */
export const FOOD_SENSITIVITY_FACT_NOUNS: Record<
  FoodSensitivityFactKey,
  string
> = {
  effect: "effect",
  note: "note",
};

export interface FoodSensitivityFactInput {
  /** A `lib/gi-effects.ts` slug, or "" when the person has not chosen one yet. */
  effect: string;
  note: string;
}

export function foodSensitivityFactSummary(
  f: FoodSensitivityFactInput
): RecordFactSummary<FoodSensitivityFactKey> {
  const row = recordFactRow<FoodSensitivityFactKey>();

  const effect = f.effect.trim();
  if (effect) row.stated("effect", effectLabel(effect));
  else row.missing("effect", "Add the effect");

  // The note MARKER, not the note — the record family's reading of a free-text field.
  row.state("note", f.note, "Note added");

  return row.summary();
}
