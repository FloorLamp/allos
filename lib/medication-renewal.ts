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
import { strengthFromName } from "./prescription-parse";
import type { DiffRow, ImportSnapshot } from "./import-diff";

// Normalize a strength token for comparison: lowercased, whitespace removed
// ("800 mg" ≡ "800mg" ≡ "800 MG"). Null/blank in ⇒ null out.
export function normalizeStrength(s: string | null | undefined): string | null {
  const n = (s ?? "").toLowerCase().replace(/\s+/g, "");
  return n || null;
}

// The CONCENTRATION denominator of a normalized strength is the part after a "/" that
// FOLLOWS A UNIT ("2.5mg/3ml" → numerator "2.5mg"). A slash after a DIGIT is not a
// denominator but a combination numerator ("5/325mg" is hydrocodone/APAP — one
// strength stated in two parts), so that shape is left whole.
const CONCENTRATION_RE = /^(.*?[a-z%])\/.+$/;

function numeratorOf(normalized: string): string {
  return normalized.match(CONCENTRATION_RE)?.[1] ?? normalized;
}

// Are two normalized strengths the same strength?
//
// Exact equality, plus one asymmetry the app has to carry. Strengths recorded BEFORE
// the parser learned to keep a concentration's denominator are numerator-only, and
// they get compared against freshly parsed strengths that now keep it. A stored
// "2.5mg" and an incoming "2.5mg/3ml" are the same albuterol; treating them as
// different made every concentration-dosed med fork a duplicate item at its next
// refill — on every install that predates the change, which is every real one.
//
// A BACKFILL CANNOT FIX THIS, which is why the tolerance lives in the comparison
// rather than in a migration: the denominator was never stored, so there is nothing
// on disk to migrate. "2.5 mg" does not contain "3 mL" anywhere; the only copy is in
// the source document, behind a reprocess the app cannot assume has happened.
//
// The tolerance is deliberately ONE-SIDED — it applies only when exactly one side is
// numerator-only, i.e. when one of them is ambiguous history. When both state a
// denominator they are compared in full, so "400mg/5ml" and "400mg/10ml" stay the
// genuinely different concentrations they are, and #1027's carve-out still fires.
export function sameStrength(a: string, b: string): boolean {
  if (a === b) return true;
  const aConc = CONCENTRATION_RE.test(a);
  const bConc = CONCENTRATION_RE.test(b);
  if (aConc === bConc) return false;
  return numeratorOf(a) === numeratorOf(b);
}

// Is `candidate` one of the strengths already known, allowing for that history?
function knownStrength(candidate: string, known: Iterable<string>): boolean {
  for (const k of known) if (sameStrength(candidate, k)) return true;
  return false;
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

// A value that is ALREADY a bare strength token, so running the extractor over it
// would only damage it: "2.5 MG/3ML" is a complete concentration whose denominator
// the bare (non-parenthesized) extraction truncates to "2.5 MG".
const BARE_STRENGTH_RE =
  /^\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml|iu|units?|meq|%)(?:\s*\/\s*\d*(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml|iu|units?|meq|%))?$/i;

// The comparable strength for the NEW side of a re-prescription (#2919 leg 2).
//
// The comparison in classifyReprescription is only sound when both sides are in the
// SAME form. The existing side always is: getMedMatchStates runs strengthFromName
// over the med's name and its dose amounts. The new side used its parsed
// `med.strength` RAW — and that field is only as good as the sig parse. #2939 has
// parsePrescription returning an entire sentence ("Take 1.5 mL (1.25 mg) by
// nebulization every 6 (six) hours if needed for wheezing.") as the strength; a
// sentence never equals an extracted token, so the pair read as "provably different"
// and every re-import spawned a duplicate item.
//
// So the new side passes through the same extraction — unless it is already a bare
// strength, which extraction would truncate. An unextractable value ("one tablet")
// yields null, i.e. UNKNOWN, which conservatively renews: the documented direction
// for weak evidence, and never the direction that invents a duplicate.
export function comparableNewStrength(raw: string | null): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (BARE_STRENGTH_RE.test(v)) return v;
  return strengthFromName(v);
}

// Pick the existing tracked med a re-prescription should RENEW onto, from every
// candidate sharing its identity — or null when each one is a genuinely separate
// concurrent product (#2919 leg 1).
//
// The caller used to take the FIRST same-key candidate and classify only against it.
// That was correct while at most one item per key could exist — but "separate" is
// precisely how a SECOND one arises, and from then on first-match perpetuates it: the
// observed profile had a manual "Acetaminophen 500 mg" with an open course sitting at
// a lower id than its extracted 325 MG twin, so every import classified against the
// manual row, returned "separate" by the book, and minted a fresh item. Three exports,
// three items, none of them wrong individually.
//
// Preferring a renewal is the conservative direction and cannot fold two genuinely
// concurrent products together: a candidate is only renewed onto when IT classifies
// as a renewal against this exact prescription.
export function pickRenewalTarget<T extends MedFoldMatch>(
  candidates: readonly T[],
  newStrength: string | null
): T | null {
  for (const ex of candidates) {
    const relationship = classifyReprescription({
      existingHasOpenCourse: ex.hasOpenCourse,
      existingStrengths: new Set(
        ex.strengths
          .map((s) => normalizeStrength(s))
          .filter((s): s is string => !!s)
      ),
      newStrength,
    });
    if (relationship === "renewal") return ex;
  }
  return null;
}

// Every tracked med a parsed prescription's identity matches — the SAME cleaned/
// grouping medNameKey the #1027 duplication family and the observations bridge use,
// on the existing row's name AND its brand.
export function medFoldCandidates<T extends MedFoldMatch>(
  existing: readonly T[],
  name: string
): T[] {
  const key = medNameKey(name);
  if (!key) return [];
  return existing.filter((ex) => {
    const exKeys = new Set([medNameKey(ex.name)]);
    if (ex.brand) exKeys.add(medNameKey(ex.brand));
    return exKeys.has(key);
  });
}

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
    !knownStrength(nu, state.existingStrengths)
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
  // Same numerator-only history tolerance as classifyReprescription: a stored "2.5 mg"
  // against a parsed "2.5 mg/3 mL" is not a dose change, and prompting "update the
  // dose" for it would nag on every refill of every concentration-dosed med.
  return !knownStrength(nu, live);
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
  for (const row of derivedMeds) {
    if (have.has(row.key)) continue;
    // The SAME candidate gather + renewal preference the commit path runs (#2919), so
    // preview and commit resolve the same existing med. Before that, both took the
    // first same-key candidate — which is how a shadowed twin previewed as an addition
    // and then landed as one.
    const target = pickRenewalTarget(
      medFoldCandidates(trackedStates, row.label),
      comparableNewStrength(newStrengthByKey.get(row.key) ?? null)
    );
    if (!target) continue; // #1027 "separate" → previews as added
    have.add(row.key);
    snap.medications.push({ ...row });
  }
}
