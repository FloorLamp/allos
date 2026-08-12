// THE MORNING IS ONE PHYSICAL EVENT (issue #2458). Pure, DB-free, clock-free.
//
// On one profile's ledger the morning is a smoothie: two food groups logged 21/21
// days and three Morning-declared supplement doses confirmed most days IN THE SAME
// MINUTE as the food log. #2380 made the food half one tap. The stack beside it was
// still three, and the dashboard — the surface a morning actually starts on —
// offered none of it. This module composes the two halves into one offer.
//
// ── IT IS A COMPOSITION, NOT A NEW MEASURE ───────────────────────────────────
//
// Nothing here observes anything. The food half is exactly `usualFoodOffer`'s answer
// (lib/food-regularity.ts) — same 21-day regularity measure, same habitual share,
// same cap-direction and alcohol exclusions (#998/#2380) inherited for free, because
// this module never re-derives them and could not weaken them if it tried. The dose
// half is the profile's OWN DECLARATION read back: a dose whose `time_of_day` buckets
// to this window and which is due today and still unresolved.
//
// ── THE TWO HALVES ARE MEMBERS FOR DIFFERENT REASONS, DELIBERATELY ───────────
//
// Food declares nothing, so a food habit has to be MEASURED. A dose's `time_of_day`
// IS the declaration, so measuring it from co-occurrence would duplicate a stated
// intent with a guess — and a guess is exactly the thing #2419 forbids the app from
// turning into an expectation. So dose membership rides DECLARATION + DUENESS and
// never obligation and never a detected pattern:
//
//   • a `may` item falls out through DUENESS (it is never scheduled-due, #1505/#2419),
//     not through an obligation filter — it stays one tap away on its own rows,
//     collapsed and never filtered;
//   • a paused or situationally-held item falls out through `conditionAppliesOn`;
//   • nothing here reads `obligation` at all. Obligation is declared only, forever.
//
// ── THE FOOD HALF IS THE GATE; THE DOSE HALF IS A RIDER ──────────────────────
//
// With no food offer there is NO CONTROL — not a dose-only "usual". Pending doses on
// their own are already owned by the dashboard's dose confirm and by the reminders,
// and a dose-only bundle would be a worse copy of those. With a food offer and no
// pending doses the control degrades to exactly the food offer that already ships.
//
// ── AND IT IS AN OFFER ───────────────────────────────────────────────────────
//
// The user's tap is the write. The label names EVERY group and EVERY dose the tap
// will perform, and `logUsualRoutineCore` (lib/usual-routine-write.ts) re-derives
// both halves from fresh server state and writes only the intersection — so a stale
// tap refuses instead of logging a second breakfast or a fourth creatine.

import type { FoodSlot } from "./food-slot";

// One dose the offer would confirm. Ids and label material only: the button names it,
// the write core re-resolves it, and nothing downstream reads a dose row from here.
export interface UsualRoutineDose {
  doseId: number;
  itemId: number;
  name: string;
  // The amount/product line beside the name, already formatted by the gather — the
  // same string the reminder keyboards show, so the two surfaces name a dose alike.
  detail: string | null;
}

// What one tap would write, both halves. Only ever built when the food half stands.
export interface UsualRoutineOffer {
  window: FoodSlot;
  // Catalog group slugs, share-descending — `usualFoodOffer`'s answer verbatim.
  groups: string[];
  // Declared-in-window, due-today, still-unresolved doses. May be empty: the rider
  // is optional and its absence degrades the control to the plain food offer.
  doses: UsualRoutineDose[];
}

// Compose the two halves into one offer, or `null` for NO CONTROL.
//
// The one rule this function owns: the food half is the gate. `groups` arrives from
// `usualFoodOffer`, which already returns `[]` below `FOOD_USUAL_MIN_GROUPS`, so an
// empty list here means "the food offer does not stand" and the whole control goes.
export function usualRoutineOffer(
  window: FoodSlot,
  groups: readonly string[],
  doses: readonly UsualRoutineDose[]
): UsualRoutineOffer | null {
  if (groups.length === 0) return null;
  return { window, groups: [...groups], doses: [...doses] };
}

// "Berries", "Berries and Fermented foods", "Berries, Eggs and Fermented foods" — the
// names a "log my usual" control says OUT LOUD, in its label and in the toast that
// answers it (#2380). Plain English on purpose: the label has to read as a promise of
// what the tap writes, which is also why the button and its answer format the same
// list through the same function. Shared by the Food tab's food-only control and the
// dashboard's composed one (#2458), so the two can never name a write differently.
export function namesPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The whole label, both halves, in one sentence: "fermented and berries + creatine,
// collagen and B-complex". The `+` is the seam between two DIFFERENT kinds of write —
// servings and dose confirms — and keeping it visible is what stops the sentence from
// reading as one undifferentiated list of five things.
//
// Pure and shared so the dashboard control, its accessible name and the Telegram
// button (#2460) all promise the same writes in the same words.
export function usualRoutinePhrase(
  foodNames: readonly string[],
  doseNames: readonly string[]
): string {
  const food = namesPhrase(foodNames);
  if (doseNames.length === 0) return food;
  return `${food} + ${namesPhrase(doseNames)}`;
}

// WHAT THE TAP ACTUALLY DID, in one sentence — the shared answer for the dashboard
// toast and the Telegram callback ack (#2458/#2460).
//
// It may never claim more than was written. Every half is reported from what the write
// core RETURNED, never from what the button named: a group the offer had already lost
// is simply absent, and a dose that refused is named as not logged rather than folded
// into a count. "Logged fermented and berries · 3 doses taken" is the happy path;
// "Logged fermented and berries · 2 doses taken · Creatine not logged" is the partial
// truth, and both come out of the same function so no surface can round one up.
export function usualRoutineAnswerText(
  // Group NAMES (not slugs) actually written.
  foodNames: readonly string[],
  // Dose names whose confirm actually moved the ledger.
  dosesLogged: readonly string[],
  // Dose names the write core named but could not log — a paused item, a retired
  // dose, one already resolved from another surface between render and tap.
  dosesRefused: readonly string[]
): string {
  const parts: string[] = [];
  if (foodNames.length > 0) parts.push(`Logged ${namesPhrase(foodNames)}`);
  if (dosesLogged.length > 0)
    parts.push(
      `${dosesLogged.length} dose${dosesLogged.length === 1 ? "" : "s"} taken`
    );
  if (dosesRefused.length > 0)
    parts.push(`${namesPhrase(dosesRefused)} not logged`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing left to log";
}
