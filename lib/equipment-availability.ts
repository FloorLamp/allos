// Equipment-aware suggestion gating (issue #345). ONE pure summary of "what gear
// does this profile actually have", plus the lift→required-implement mapping and a
// de-rank helper — every consumer (the exercise combobox, next-set/exercise
// suggestions, and the unified workout-recommendation core) is a formatter over
// this. No DB/network, so it runs client-side (the combobox) and under test.
//
// EMPTY-REGISTRY SEMANTICS (the design decision, point 4 of #345): a gym-goer owns
// no equipment rows, so an EMPTY registry means "everything available", never
// "nothing". Only an explicitly NON-EMPTY registry with a missing kind de-ranks a
// lift that needs that kind. De-rank NEVER hides — an unavailable lift sinks to the
// bottom of the list, still selectable (a home-gym user can still log a barbell
// lift done at a gym).

import type { Equipment, EquipmentCategory } from "./types";
import { EQUIPMENT_CATEGORIES } from "./types";
import { isBarbellLift, variantOf, defaultEquipment } from "./lifts";

// The availability summary: whether the registry has ANY (non-retired) gear, and
// which equipment CATEGORIES are present. Array-based (not a Set) so it serializes
// cleanly across the RSC boundary when threaded into the workout core's input.
export interface EquipmentAvailability {
  hasAny: boolean;
  categories: EquipmentCategory[];
}

// Summarize a profile's equipment into the availability shape. Retired rows are
// excluded (sold/broken gear isn't available); pass an already-non-retired list or
// a full list — either way retired rows never count. A NULL/unknown category is
// ignored (it constrains nothing).
export function summarizeEquipmentAvailability(
  equipment: Equipment[]
): EquipmentAvailability {
  const live = equipment.filter((e) => !e.retired);
  const categories = new Set<EquipmentCategory>();
  for (const e of live) {
    if (e.category) categories.add(e.category as EquipmentCategory);
  }
  return { hasAny: live.length > 0, categories: [...categories] };
}

// WHICH IMPLEMENT A LIFT USES, as a registry category — ONE walk of the two sources
// that answer it: the equipment composed into the lift's own name ("Dumbbell Curl"),
// then the lift's normal implement. Null when that implement is no registry category
// ("Cable", "Trap Bar", "Bodyweight"), when the lift offers a CHOICE and none is made
// ("Curl"), or when the lift is unknown. EVERY category, because its two callers —
// the gate below, and the prefill in activity-form/EquipmentQuickAdd.tsx — narrow it
// to different ones, each for a reason of its own.
export function liftImplementCategory(name: string): EquipmentCategory | null {
  const implement = variantOf(name)?.equipment ?? defaultEquipment(name);
  const want = (implement ?? "").trim().toLowerCase();
  return EQUIPMENT_CATEGORIES.find((c) => c.toLowerCase() === want) ?? null;
}

// The equipment CATEGORY a lift requires, or null when it needs nothing trackable.
// Only Barbell, Dumbbell and Machine gate; everything else — cable, bodyweight,
// unknown, and KETTLEBELL, which the resolver above DOES return — is ALWAYS
// available. Null is that answer, not a missing case: widening this gate would
// de-rank lifts it has never de-ranked.
export function liftRequiredCategory(name: string): EquipmentCategory | null {
  // Plate-loaded first: a trap-bar deadlift's implement reads "Trap Bar" but loads
  // on plates, so a barbell is what it needs.
  if (isBarbellLift(name)) return "Barbell";
  const category = liftImplementCategory(name);
  return category === "Barbell" ||
    category === "Dumbbell" ||
    category === "Machine"
    ? category
    : null;
}

// Whether a set logged on this equipment CATEGORY contradicts a free-weight
// population standard (#2326). The strength-standards tables are barbell norms; a
// fixed-path, selectorised or plate-loaded machine has a mechanical advantage those
// norms do not model, so a machine set states nothing about where a lifter sits
// against them.
//
// `Machine` is the only registry category that contradicts. `EQUIPMENT_CATEGORIES`
// carries no separate Cable entry — a cable stack is a selectorised machine and is
// registered as `Machine` — so the issue's "Machine and its cable/selectorised
// equivalents" is exactly one category here, derived from the category list rather
// than restated as a second one.
//
// A NULL / unknown category is NOT a contradiction. Most sets carry no equipment row
// at all, and unknown must keep meaning "nothing contradicts", never "machine" —
// reading absence as a machine would strip the standing from almost every lifter.
// Kettlebell and Dumbbell are free weights, not a machine's fixed path; whether a
// bare base NAME should map onto the barbell table at all is `tableFor`'s separate
// question.
//
// Lives here, not in `lib/strength-standards`, so the standards module asks a
// question about equipment instead of restating a category list (#2326).
export function contradictsFreeWeightStandard(
  category: string | null | undefined
): boolean {
  return (category ?? "").trim().toLowerCase() === "machine";
}

// Whether a lift is satisfiable with the profile's available gear. Always true when
// the registry is empty (everything available) or the lift needs nothing
// trackable; otherwise true only when the required category is present.
export function isLiftAvailable(
  name: string,
  avail: EquipmentAvailability | null | undefined
): boolean {
  if (!avail || !avail.hasAny) return true;
  const required = liftRequiredCategory(name);
  if (required == null) return true;
  return avail.categories.includes(required);
}

// Stable de-rank: partition `options` into available-first, unavailable-after,
// preserving input order within each partition. A no-op when the registry is empty
// / absent (nothing to gate). Non-destructive — never drops an option (de-rank,
// not hide).
export function deRankUnavailableLifts(
  options: string[],
  avail: EquipmentAvailability | null | undefined
): string[] {
  if (!avail || !avail.hasAny) return options;
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const o of options)
    (isLiftAvailable(o, avail) ? available : unavailable).push(o);
  return unavailable.length === 0 ? options : [...available, ...unavailable];
}
