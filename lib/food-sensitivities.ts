// THE DECLARED FOOD SENSITIVITY — its vocabulary and how a row reads (#5865).
//
// A sensitivity is a statement the person writes: "after <trigger>, I get <effect>".
// It is NOT an allergy and must never behave like one — it gates nothing, warns about
// nothing, reorders nothing, and never reaches the passport or the emergency card. The
// `allergies` table is a clinical FHIR record with criticality and verification; this
// is a preference-tier declaration, and #975's "preferences never gate" is the
// precedent it follows.
//
// AND THE APP NEVER WRITES ONE. Every row here is authored by the person, which is
// exactly what lets a declared pair sit inside the paired-observation registry without
// breaking its no-miner rule (#2397/#2572): the app is not inventing a comparison out
// of two of your series, it is counting the one you asked it to count.
//
// THE TRIGGER IS ONE OF TWO VOCABULARIES, never free text. A GROUP trigger is one of
// the 25 curated food groups already logged against (lib/food-groups.ts) — dairy, fried
// food, alcohol — and its factor is the food log the app already has, so it needs no
// new mark anywhere. A PROPERTY trigger is a property of the MEAL rather than of any
// group, from the short closed list below: a spicy curry is poultry plus legumes plus
// rice, and no group slug can carry "spicy". That is the whole reason the second
// vocabulary exists.
//
// Pure: no React, no DB, no clock.

import { foodGroupName, isValidFoodGroup } from "./food-groups";
import { giEffectBySlug } from "./gi-effects";

/** Which vocabulary a trigger slug is drawn from. */
export const TRIGGER_KINDS = ["group", "property"] as const;
export type FoodSensitivityTriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * A property of a meal, not of a food group — the closed vocabulary a `This meal` chip
 * marks a tap with. SHORT BY DESIGN: every member is a property a person can decide
 * about a meal in the second before they log it, without measuring anything.
 */
export interface MealProperty {
  /** Stored value. Lowercase snake_case, never renamed. */
  slug: string;
  /** The word — the chip, the receipt, the catalog row. */
  label: string;
}

export const MEAL_PROPERTIES = [
  { slug: "spicy", label: "Spicy" },
  { slug: "high_fat", label: "High fat" },
  { slug: "caffeine", label: "Caffeine" },
  { slug: "sweetener", label: "Sweetener" },
] as const satisfies readonly MealProperty[];

export type MealPropertySlug = (typeof MEAL_PROPERTIES)[number]["slug"];

const PROPERTY_BY_SLUG = new Map<string, MealProperty>(
  MEAL_PROPERTIES.map((p) => [p.slug, p])
);

export function mealPropertyBySlug(slug: string): MealProperty | undefined {
  return PROPERTY_BY_SLUG.get(slug);
}

export function isMealProperty(slug: string): slug is MealPropertySlug {
  return PROPERTY_BY_SLUG.has(slug);
}

/**
 * The marks a tap posted (`properties`, comma-separated slugs), in vocabulary order and
 * deduplicated, so one set of marks has one stored spelling. Null when any slug is
 * outside the vocabulary: the write refuses rather than storing a mark no reader knows.
 */
export function parseMealProperties(raw: unknown): MealPropertySlug[] | null {
  const posted = String(raw ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (!posted.every(isMealProperty)) return null;
  return MEAL_PROPERTIES.map((p) => p.slug).filter((slug) =>
    posted.includes(slug)
  );
}

/** A declared sensitivity, as stored. */
export interface FoodSensitivity {
  id: number;
  trigger_kind: FoodSensitivityTriggerKind;
  trigger_slug: string;
  effect: string;
  note: string | null;
  /** 'stopped' keeps the row and its past marks while taking the chip and the pair away. */
  status: "active" | "stopped";
}

/** Whether a (kind, slug) pair names something the vocabulary actually has. */
export function isTriggerSlug(
  kind: FoodSensitivityTriggerKind,
  slug: string
): boolean {
  return kind === "group" ? isValidFoodGroup(slug) : isMealProperty(slug);
}

/**
 * The trigger's own word — the catalog row's name and the sentence's subject.
 *
 * Falls back to the raw slug rather than to "Unknown": a vocabulary entry retired after
 * a row was written is still the person's own statement, and showing them the slug is
 * honest where showing them nothing is not.
 */
export function triggerLabel(
  kind: FoodSensitivityTriggerKind,
  slug: string
): string {
  if (kind === "property") return mealPropertyBySlug(slug)?.label ?? slug;
  return isValidFoodGroup(slug) ? foodGroupName(slug) : slug;
}

/** The effect's word, from the shared GI vocabulary. */
export function effectLabel(effect: string): string {
  return giEffectBySlug(effect)?.label ?? effect;
}

/**
 * WHERE THE FACTOR COMES FROM, said on the row. A group trigger is read off the food
 * log that already exists; a property trigger is read off the meals the person marks.
 * Neither line promises a count — the pair itself is the counted read, and it arrives
 * with the paired-observation entry rather than with the declaration.
 * The difference decides whether they will ever see a chip on the food sheet, so the
 * catalog says it rather than leaving it to be discovered.
 */
export function triggerSourceLine(kind: FoodSensitivityTriggerKind): string {
  return kind === "property" ? "Marked on the meal" : "From your food log";
}

/** `Loose stools · Marked on the meal` — the catalog row's facts line. */
export function sensitivityFactsLine(s: FoodSensitivity): string {
  return `${effectLabel(s.effect)} · ${triggerSourceLine(s.trigger_kind)}`;
}
