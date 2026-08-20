// The ONE case-fold shared by the free-text vocabularies (issue #3325). PURE — no
// DB/network, client-safe, unit-tested in lib/__tests__/vocabulary-fold.test.ts.
//
// ---- What was wrong ---------------------------------------------------------
//
// A custom symptom and a custom substance are both stored as their normalized NAME —
// there is no registration row, the ledger is the register. Normalization trimmed and
// collapsed whitespace but kept case, and case was then used for MATCHING, so "Kratom"
// on Tuesday and "kratom" on Friday were two keys, two cards and two ledgers, each
// looking correct. On a phone with autocapitalise that is not a hypothetical.
//
// ---- The rule: FOLD FOR MATCHING, PRESERVE FOR DISPLAY ----------------------
//
// Case is kept for a good reason — "MDMA" must not read as "Mdma" on a card heading —
// so the fix is not to store a folded string. It is to stop case DECIDING identity:
//
//   • `foldVocabularyName()` is compared, NEVER stored. Nothing in this module ever
//     returns a string that becomes a key, which is what structurally forbids the
//     "a fold applied to display" regression: there is no code path from a fold to a
//     stored spelling.
//   • `matchFoldedVocabulary()` answers "does this profile already have a spelling of
//     this name?" and hands back THAT SPELLING — the first one seen — so a later
//     "kratom" joins the existing "Kratom" card under its existing heading.
//
// ---- Why it lives in its own module ----------------------------------------
//
// #3323 re-instantiated lib/symptoms.ts's curated+custom vocabulary for substances
// rather than inventing a second one, naming the five functions one-for-one
// (docs/internals/identity-registry.md lists the two side by side). Folding one domain
// alone would immediately re-fork them, which is why #3279's lane left the defect
// alone rather than fixing it in passing.
//
// So the fold is not written twice and agreed by convention: BOTH vocabularies import
// THIS function, and a change to what "the same name" means can only be made in one
// place, for both, at once. `lib/vocabulary-store.ts` is its DB-side twin — the
// profile-scoped lookup both domains resolve through.
//
// AND IT MUST NOT BE RE-SPELLED IN SQL. `toLowerCase()` here is Unicode-aware; SQLite's
// `LOWER()` and `COLLATE NOCASE` fold ASCII only, so a case-insensitive match written in
// SQL would call two spellings distinct that this function calls one, and the duplicate
// would quietly return. `lib/__tests__/vocabulary-sql-fold-census.test.ts` fails the day
// anyone reaches for it, and points at the `biomarker_family` user-function pattern
// (lib/sql-functions.ts) — the way SQL is supposed to call a pure identity here.

// Case- and whitespace-fold a free-text vocabulary name to its MATCHING identity.
//
// Compared, never stored (see above). Applied to a name that has ALREADY been through
// its domain's normalizer, so this adds exactly one axis — case — to a rule that
// already trimmed, collapsed and capped. Applying it to raw input instead would
// disagree with the stored key at the length cap, where the truncation happens.
export function foldVocabularyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// Whether two vocabulary names are the same entry ignoring case (and the whitespace
// their normalizers already collapsed). The predicate every "is this a duplicate?"
// question asks, so none of them can disagree.
export function sameVocabularyName(a: string, b: string): boolean {
  return foldVocabularyName(a) === foldVocabularyName(b);
}

// The spelling this profile already stores for `input`, or null if it stores none.
//
// `known` is the profile's own spellings in FIRST-SEEN order (oldest ledger row first —
// see lib/vocabulary-store.ts), and the first fold-match wins, so the label a card has
// always carried keeps carrying it. A later re-spelling never re-titles a card behind
// someone's back; renaming is how a spelling is deliberately changed, and it stays a
// separate, explicit act.
export function matchFoldedVocabulary(
  input: string,
  known: readonly string[]
): string | null {
  const folded = foldVocabularyName(input);
  if (!folded) return null;
  for (const existing of known) {
    if (foldVocabularyName(existing) === folded) return existing;
  }
  return null;
}
