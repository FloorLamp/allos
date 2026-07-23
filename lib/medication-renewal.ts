// Pure decision layer for issue #1204: when an imported/tracked-again prescription's
// identity MATCHES an existing tracked medication, does it attach as a new COURSE on
// that med (a renewal / second-provider order / refill) or stay a SEPARATE item (the
// #1027 concurrent same-ingredient-different-strength case)?
//
// No DB or network — a pure function of the match's strength + the existing med's
// lifecycle/strength state, unit-tested in lib/__tests__/medication-renewal.test.ts.
// The identity MATCH itself keys on the shared cleaned/grouping name from
// lib/medication-record-match.ts (`medNameKey`) — this module only decides the
// RELATIONSHIP once identity is established, so the two never fight.
//
// The #1204 ⇄ #1027 boundary, distinguished by LIFECYCLE OVERLAP, not strength:
//   - Concurrent (the existing med has an OPEN course AND the new order is a
//     PROVABLY DIFFERENT strength — the classic OTC 200 mg + Rx 800 mg you take
//     BOTH) → SEPARATE item, per #1027 (offer-don't-fold; the duplication note +
//     widened counters cover the pair). A different strength while the prior therapy
//     is still open is a real second product.
//   - Renewal / superseding (the prior course is CLOSED — a refill/re-issue — OR the
//     new order shares/omits the strength — a continuation) → a NEW COURSE on the
//     existing med. A different strength on a CLOSED-course renewal is a dose CHANGE:
//     the course records the new snapshot and a suggest-only prompt offers the
//     schedule update; it is never silently merged.
//
// Conservative fold: an unknown strength on EITHER side cannot prove a concurrent
// second product, so it renews (never spawn a duplicate item for every strengthless
// refill — the primary bug #1204 fixes). The one carve-out to separate is the
// provable open-course + different-strength case #1027 owns.

import { medNameKey } from "./medication-record-match";
import type { DiffRow, ImportSnapshot } from "./import-diff";

// Normalize a strength token for comparison: lowercased, whitespace removed
// ("800 mg" ≡ "800mg" ≡ "800 MG"). Null/blank in ⇒ null out.
export function normalizeStrength(s: string | null | undefined): string | null {
  const n = (s ?? "").toLowerCase().replace(/\s+/g, "");
  return n || null;
}

export interface ReprescriptionState {
  // Does the existing med currently have an OPEN (stopped_on IS NULL) course?
  existingHasOpenCourse: boolean;
  // The normalized strengths the existing med is already known at (parsed off its
  // name + dose amounts). Empty when none is known.
  existingStrengths: Set<string>;
  // The new prescription's parsed strength (display form, e.g. "800 mg"), or null.
  newStrength: string | null;
}

export type ReprescriptionRelationship = "renewal" | "separate";

// Classify a matched re-prescription as a renewal (new course on the existing med)
// or a separate item (the #1027 concurrent different-strength carve-out).
export function classifyReprescription(
  state: ReprescriptionState
): ReprescriptionRelationship {
  const nu = normalizeStrength(state.newStrength);
  // Only a PROVABLE difference while the prior therapy is still open is concurrent.
  if (
    state.existingHasOpenCourse &&
    nu != null &&
    state.existingStrengths.size > 0 &&
    !state.existingStrengths.has(nu)
  ) {
    return "separate";
  }
  return "renewal";
}

// Does a renewal's snapshot strength DIFFER from what the med's live schedule is
// dosed at (so the med detail should surface the suggest-only "update the dose"
// prompt, #1204)? True only when BOTH strengths are known and they disagree — an
// unknown on either side never prompts (never guess a schedule change).
export function isDoseChange(
  newStrength: string | null,
  liveStrengths: Iterable<string>
): boolean {
  const nu = normalizeStrength(newStrength);
  if (nu == null) return false;
  const live = new Set(
    [...liveStrengths]
      .map((s) => normalizeStrength(s))
      .filter((s): s is string => !!s)
  );
  if (live.size === 0) return false;
  return !live.has(nu);
}

// The tracked-med state the medication fold needs — a STRUCTURAL subset of
// getMedMatchStates' MedMatchState (kept minimal so this pure module never imports
// the DB query layer). A full MedMatchState satisfies it.
export interface MedFoldMatch {
  name: string;
  brand: string | null;
  hasOpenCourse: boolean;
  strengths: string[];
}

// Reprocess-preview medication fold (#1204 phantom-diff fix + the #1280 correction).
//
// Since the #1204 renewal consolidation, a drug a document derives that the profile
// ALREADY tracks persists as a COURSE on the existing item — no intake_items row
// carries the later document's id — so a naive diff shows those drugs as phantom
// "+ added" medications. This folds a derived med that matches a tracked med (by the
// SAME medNameKey the renewal matcher uses) into the persisted side so it compares
// unchanged.
//
// #1280: the fold must MIRROR the commit-time decision (classifyReprescription), not
// fold on a bare name match. When the existing med has an OPEN course AND the derived
// strength is PROVABLY DIFFERENT, the commit path creates a NEW, SEPARATE item (the
// #1027 concurrent-different-strength carve-out) — so the preview must show that as a
// real addition, NOT hide it under "unchanged". Only a derived med that would RENEW
// (same/unknown strength, or a closed prior course) is folded; a "separate" one is
// left to preview as added. `newStrengthByKey` maps each derived row's `key` to its
// parsed strength (null when unknown — conservatively renews, per classifyReprescription).
export function foldConsolidatedMeds(
  trackedStates: MedFoldMatch[],
  snap: ImportSnapshot,
  derivedMeds: DiffRow[],
  newStrengthByKey: Map<string, string | null>
): void {
  const have = new Set(snap.medications.map((m) => m.key));
  // Name key → the FIRST tracked med declaring it (mirrors matchExisting's first-match
  // over ctx.existing, so preview and commit resolve the same existing med).
  const trackedByKey = new Map<string, MedFoldMatch>();
  for (const med of trackedStates) {
    for (const k of [
      medNameKey(med.name),
      med.brand ? medNameKey(med.brand) : null,
    ]) {
      if (k && !trackedByKey.has(k)) trackedByKey.set(k, med);
    }
  }
  for (const row of derivedMeds) {
    if (have.has(row.key)) continue;
    const existing = trackedByKey.get(medNameKey(row.label));
    if (!existing) continue;
    const relationship = classifyReprescription({
      existingHasOpenCourse: existing.hasOpenCourse,
      existingStrengths: new Set(
        existing.strengths
          .map((s) => normalizeStrength(s))
          .filter((s): s is string => !!s)
      ),
      newStrength: newStrengthByKey.get(row.key) ?? null,
    });
    if (relationship !== "renewal") continue; // #1027 "separate" → previews as added
    have.add(row.key);
    snap.medications.push({ ...row });
  }
}
