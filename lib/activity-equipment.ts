// Pure helpers for the ACTIVITY-level equipment link (issue #342). No React, no
// DB — just the policy for which equipment a given activity type may be gear-linked
// to, and the last-used recency default. Shared by the activity form's picker and
// unit-tested in lib/__tests__/activity-equipment.test.ts.

import type {
  ActivityType,
  Equipment,
  EquipmentCategory,
  EquipmentKind,
} from "./types";
import { kindOf } from "./types";

// The equipment KINDS that make sense as session gear for an activity type. A ride
// or run (both `cardio`) offers cardio gear (Bike, Shoes); a sport also allows
// generic `other` gear (rackets, etc.); strength keeps its set-level implement
// picker, so the activity-level picker is not shown for it, but the mapping is
// defined for completeness. #344 will add a recovery activity type → ["recovery"].
export function equipmentKindsForActivityType(
  type: ActivityType
): EquipmentKind[] {
  switch (type) {
    case "strength":
      return ["strength"];
    case "cardio":
      return ["cardio"];
    case "sport":
      return ["cardio", "other"];
  }
}

// Whether the activity-level gear picker applies to this type at all. Strength gear
// is modeled per set (exercise_sets.equipment_id), so the session-level picker is
// offered only for the non-strength types.
export function usesActivityEquipment(type: ActivityType): boolean {
  return type !== "strength";
}

// The subset of `equipment` offerable as session gear for `type`, filtered by the
// category→kind grouping (kindOf). Order is preserved (callers pass an already-
// sorted, retired-excluded list). An equipment row with an unknown/NULL category
// reads as `other`, so it only surfaces where `other` is allowed.
export function equipmentForActivityType(
  equipment: Equipment[],
  type: ActivityType
): Equipment[] {
  const kinds = new Set(equipmentKindsForActivityType(type));
  return equipment.filter((e) => kinds.has(kindOf(e.category)));
}

// The specific equipment CATEGORY a cardio activity implies (issue #339): a run,
// walk, hike, or rucking session uses Shoes; a ride, spin, or cycling session uses a
// Bike. Matched case-insensitively on the activity NAME (substring) so both curated
// names ("Running", "Mountain Biking") and user-coined ones ("Morning jog", "Bike
// commute") resolve. A generic cardio with no footwear/wheels affinity (rowing,
// swimming, elliptical) returns [] — no narrowing, so the picker keeps all cardio
// gear. This is the finer facet #339 layers over the coarse kind grouping: within
// the cardio kind, a run offers shoes and a ride offers bikes, not both.
export function cardioGearCategories(
  name: string | null | undefined
): EquipmentCategory[] {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return [];
  const has = (...needles: string[]) => needles.some((s) => n.includes(s));
  // Wheels first: "bike"/"cycl"/"spin" (Spin Class, Air Bike, Mountain Biking).
  if (has("bike", "biking", "cycl", "spin")) return ["Bike"];
  // Feet: run/jog/walk/hike/ruck/treadmill.
  if (has("run", "jog", "walk", "hik", "ruck", "treadmill")) return ["Shoes"];
  return [];
}

// The subset of `equipment` offerable as session gear for a specific activity —
// issue #339's cardio-aware refinement of equipmentForActivityType. A cardio
// activity narrows further by its gear affinity (cardioGearCategories): a run offers
// only Shoes, a ride only Bikes. When the cardio name has no specific affinity, or
// the type isn't cardio, it falls back to the kind-level filter unchanged. A strict
// narrow (rather than a fall-back-to-all) is deliberate: a run with no shoes on file
// should show an empty picker, not a bike. Shared by the picker component and the
// form's recency default so both agree on what "gear for this session" means.
export function equipmentForActivity(
  equipment: Equipment[],
  type: ActivityType,
  activityName?: string | null
): Equipment[] {
  const base = equipmentForActivityType(equipment, type);
  if (type !== "cardio") return base;
  const cats = cardioGearCategories(activityName);
  if (cats.length === 0) return base;
  const wanted = new Set(cats.map((c) => c.toLowerCase()));
  return base.filter((e) =>
    wanted.has((e.category ?? "").trim().toLowerCase())
  );
}

// The recency default for the picker: the most recently used gear that is still a
// valid choice for this session (present in `candidates` — i.e. live and of an
// allowed kind/category). `recent` is either a single last-used id (legacy caller)
// or a recency-ordered id list (issue #339): the FIRST id that's a valid candidate
// wins, so a run defaults to the last-used SHOES and a ride to the last-used BIKE —
// each remembers its own gear because the candidate set is already narrowed by
// activity (equipmentForActivity). A stale/retired/filtered id is skipped rather
// than forcing an invalid selection. Mirrors the strength picker's last-used default.
export function pickDefaultActivityEquipment(
  candidates: Equipment[],
  recent: number | number[] | null | undefined
): number | null {
  const ids = recent == null ? [] : Array.isArray(recent) ? recent : [recent];
  const valid = new Set(candidates.map((e) => e.id));
  for (const id of ids) if (valid.has(id)) return id;
  return null;
}
