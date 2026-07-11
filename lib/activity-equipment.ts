// Pure helpers for the ACTIVITY-level equipment link (issue #342). No React, no
// DB — just the policy for which equipment a given activity type may be gear-linked
// to, and the last-used recency default. Shared by the activity form's picker and
// unit-tested in lib/__tests__/activity-equipment.test.ts.

import type { ActivityType, Equipment, EquipmentKind } from "./types";
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

// The recency default for the picker: the last-used equipment id for this activity
// type, but ONLY when it's still a valid choice (present in `candidates` — i.e. live
// and of an allowed kind). A stale/retired/filtered id defaults to null rather than
// forcing an invalid selection. Mirrors the strength picker's last-used defaulting.
export function pickDefaultActivityEquipment(
  candidates: Equipment[],
  lastUsedId: number | null | undefined
): number | null {
  if (lastUsedId == null) return null;
  return candidates.some((e) => e.id === lastUsedId) ? lastUsedId : null;
}
