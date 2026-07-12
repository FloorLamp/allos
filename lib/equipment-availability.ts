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

// The equipment CATEGORY a lift requires, or null when it needs nothing trackable
// (bodyweight, cable — no registry category — or an unknown/custom lift). Only the
// three clear strength categories that map onto registry categories gate:
// Barbell, Dumbbell, Machine. A cable/bodyweight/unknown lift is ALWAYS available.
export function liftRequiredCategory(name: string): EquipmentCategory | null {
  if (isBarbellLift(name)) return "Barbell";
  const v = variantOf(name);
  if (v?.equipment) {
    if (v.equipment === "Barbell") return "Barbell";
    if (v.equipment === "Dumbbell") return "Dumbbell";
    if (v.equipment === "Machine") return "Machine";
    return null; // Cable variant → not a registry category → always available
  }
  const def = defaultEquipment(name);
  if (def === "Barbell") return "Barbell";
  if (def === "Dumbbell") return "Dumbbell";
  if (def === "Machine") return "Machine";
  return null; // Cable / Bodyweight / unknown → always available
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
