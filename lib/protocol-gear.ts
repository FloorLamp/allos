// Pure policy for the protocol "Recovery gear" selector (issue #592). No React,
// no DB — just which equipment a protocol may reference, plus the selectedMissing
// discipline. Shared by both protocol pages and unit-tested in
// lib/__tests__/protocol-gear.test.ts.

import type { Equipment } from "./types";
import { kindOf } from "./types";

// The subset of `equipment` offerable in a protocol's "Recovery gear" field. A
// protocol studies a recovery device (which sauna / plunge / red-light panel), so
// the picker shows RECOVERY-kind gear PLUS uncategorized/"Other" rows — an
// unclassified item might be someone's sauna, so the conservative cut excludes
// only the clearly-unrelated strength and cardio implements (barbells, bikes,
// shoes). It never called the canonical `kindOf` predicate before #592 and handed
// the raw inventory to the picker (the raw-list-bypasses-canonical-predicate
// disease, cf. #432).
//
// RETIRED rows are excluded from the fresh list (issue #662) — the same default
// every training surface gets through getEquipment/summarizeEquipmentAvailability,
// so a sold/broken sauna is never offered as a new pick. The filter owns this cut
// rather than trusting the caller to pre-filter (the same defensive-predicate
// discipline as #432): a caller that ever passes { includeRetired: true } — as the
// selected-fallback resolution effectively does — must not leak retired gear into
// the choices.
//
// Mirrors ActivityEquipmentPicker's selectedMissing discipline: a `selected` row
// that no longer fits the filter — an existing protocol linked to non-recovery or
// retired gear — is appended (last, like the picker's fallback) so an edit never
// silently drops the link. The caller resolves `selected` via getEquipmentById
// (which ignores the retired flag) so a linked-but-retired device is still found.
// Order otherwise preserved (callers pass an already name-sorted list).
export function recoveryGearOptions(
  equipment: Equipment[],
  selected?: Equipment | null
): Equipment[] {
  const options = equipment.filter((e) => {
    if (e.retired) return false;
    const kind = kindOf(e.category);
    return kind === "recovery" || kind === "other";
  });
  if (selected && !options.some((e) => e.id === selected.id)) {
    return [...options, selected];
  }
  return options;
}
