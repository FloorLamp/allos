// Pure decision layer for issue #1204: when an imported/tracked-again prescription's
// identity MATCHES an existing tracked medication, does it attach as a new COURSE on
// that med (a renewal / second-provider order / refill) or stay a SEPARATE item (the
// #1027 concurrent same-ingredient-different-strength case)?
//
// No DB or network — a pure function of the match's strength + the existing med's
// lifecycle/strength state, unit-tested in lib/__tests__/medication-renewal.test.ts.
// The identity MATCH itself (cleaned/grouping name, RxCUI-first, #482 family) is the
// ONE matcher in lib/medication-record-match.ts (`recordMatchesMed`) — this module
// only decides the RELATIONSHIP once identity is established, so the two never fight.
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
