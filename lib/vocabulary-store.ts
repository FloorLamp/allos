// The profile-scoped half of the free-text vocabulary fold (issue #3325) — the DB twin
// of the pure lib/vocabulary-fold.ts. Auth-blind: profileId first, never imports
// lib/auth (#319).
//
// ---- The question this answers ---------------------------------------------
//
// "This person just typed a name. Do they ALREADY have a spelling of it, and what is
// it?" A custom symptom and a custom substance are both registered by being used — the
// ledger IS the register, there is no vocabulary table — so the answer is read from the
// ledger, and the ledger is per-domain. Everything else about the question is identical,
// which is why there is ONE module with a two-row registry rather than a copy per
// domain: #3323 re-instantiated the symptom vocabulary for substances, and folding one
// alone would re-fork what that PR paid to unify (#3279).
//
// ---- WHERE THE FOLD APPLIES, AND WHERE IT MUST NOT --------------------------
//
// The fold belongs where a person TYPES a name, and nowhere else:
//
//   • TYPED — `logSymptomCore` (the log bar's free-text field, the Telegram quick-log)
//     and `trackSubstanceUseAction` (#3326's "Track another substance"). These MINT a
//     key, and are exactly where a case variant used to be born. They resolve here.
//
//   • A STORED KEY HANDED BACK BY A SURFACE — editing a severity, correcting a day's
//     total, setting a cap, renaming or deleting a custom entry. The key came from a row
//     the app just rendered, so it needs no matching, and folding it would be actively
//     WRONG: where a profile already carries both "Kratom" and "kratom" (rows that
//     predate this fix — see below), a fold would silently redirect "delete kratom" onto
//     the OTHER card. These keep resolving through the bare `resolveSymptomKey()` /
//     `resolveSubstanceKey()`.
//
// Renaming is the sharpest case and it is deliberate: `renameCustomSymptomCore` resolves
// BOTH ends bare, because renaming "kratom" to "Kratom" is a person deliberately
// re-spelling — the one operation whose whole purpose is to change case. Folding its
// target would turn it into a silent no-op, and it is also the escape hatch that MERGES
// a legacy pair (it already keeps the worst severity per day and re-parents photos).
//
// ---- ROWS THAT ALREADY DIFFER ONLY BY CASE ----------------------------------
//
// They are LEFT AS THEY ARE. No migration merges them, and that is a decision, not an
// omission (#3325 asked for one or the other, stated):
//
//   • A merge is an irreversible edit to somebody's health record. Two ledgers becoming
//     one cannot be undone by the person it happened to, and nothing at migration time
//     can ask them.
//   • The merge rule already exists ON PURPOSE as a USER action — `renameCustomSymptom`
//     for symptoms; for substances the day rows are editable and undoable through the
//     history affordances. Re-implementing that rule in raw migration SQL, where the
//     write cores are unreachable, would make a SECOND copy of the collision semantics
//     (worst severity, photo re-parenting, target re-keying) — the exact fork this issue
//     exists to prevent.
//
// It is not silent, either. After this fix a typed "kratom" lands on the first-seen
// "Kratom" card and the surface SAYS SO: the substance toast names the label that
// actually took the log ("Kratom: 1 logged today"), and the symptom outcome carries back
// the key it wrote. The stale variant keeps its own history, stays readable, and stays
// editable and deletable; it simply stops being the target of new logs.
//
// ---- SQLITE'S FOLD IS NOT THIS FOLD ----------------------------------------
//
// `foldVocabularyName()` is Unicode-aware; SQLite's `LOWER()` / `COLLATE NOCASE` fold
// ASCII only. A case-insensitive MATCH written in SQL over one of these columns would
// therefore disagree with this boundary about which spellings are one entry, silently and
// in the worst direction — the duplicate would come back. Sorting is unaffected; identity
// is not. `lib/__tests__/vocabulary-sql-fold-census.test.ts` is the tripwire, and it names
// the answer: register the pure fold as a SQLite user function, the way `biomarker_family`
// calls `biomarkerFamily()` (lib/sql-functions.ts).

import { db } from "./db";
import { resolveSymptomKey } from "./symptoms";
import { resolveSubstanceKey, type SubstanceKey } from "./substance-use";

// The two free-text vocabularies. A third would add a row here, not a second fold.
export type VocabularyDomain = "symptom" | "substance";

interface VocabularySpec {
  // The ledger that REGISTERS a custom key — a key exists because rows exist.
  table: string;
  column: string;
  // The domain's own resolver, which already collapses curated slugs/labels; the fold
  // is the `known` argument it takes.
  resolve: (input: string, known: readonly string[]) => string | null;
}

// Table/column are fixed literals from this closed registry, never user input — they are
// interpolated because SQLite cannot bind an identifier.
const VOCABULARY_SPECS: Record<VocabularyDomain, VocabularySpec> = {
  symptom: {
    table: "symptom_logs",
    column: "symptom",
    resolve: resolveSymptomKey,
  },
  substance: {
    table: "substance_daily_totals",
    column: "substance",
    resolve: (input, known) =>
      resolveSubstanceKey(input, known as readonly SubstanceKey[]),
  },
};

// This profile's own stored spellings in this vocabulary, FIRST-SEEN FIRST.
//
// Ordered by the earliest row id that carries each spelling, because "first seen" is
// what decides which spelling keeps the card's heading, and row id is the only record of
// insertion order the ledger keeps (a `date` is the day being described, not the day it
// was typed — an old day back-filled today must not out-rank a spelling used for months).
//
// Curated keys come back too and cost nothing: they can only fold-match themselves, and
// the domain resolver has already collapsed a curated slug or label before the fold is
// ever consulted.
//
// THIS ANSWERS "WHICH SPELLING IS CANONICAL?" — IDENTITY RESOLUTION, which is why the
// order is first-seen. `getCustomSymptomNames()` (lib/queries/symptoms.ts) holds the same
// strings ordered newest-used, because it answers "what am I likely to type next?". Same
// data, two questions, two orderings — neither is the other one's stale copy.
export function profileVocabulary(
  domain: VocabularyDomain,
  profileId: number
): string[] {
  const spec = VOCABULARY_SPECS[domain];
  const rows = db
    .prepare(
      `SELECT ${spec.column} AS name, MIN(id) AS first_id
         FROM ${spec.table}
        WHERE profile_id = ?
        GROUP BY ${spec.column}
        ORDER BY first_id`
    )
    .all(profileId) as { name: string }[];
  return rows.map((r) => r.name);
}

// Resolve TYPED text to the key this profile stores it under: a curated key, an existing
// spelling of the same name, or — when the profile has none — the new name verbatim.
//
// This is the write boundary for both vocabularies. A write core that calls its domain's
// bare resolver instead is the #3325 bug: it will mint "kratom" beside "Kratom" and both
// cards will look correct.
export function resolveProfileVocabularyKey(
  domain: VocabularyDomain,
  profileId: number,
  input: string
): string | null {
  return VOCABULARY_SPECS[domain].resolve(
    input,
    profileVocabulary(domain, profileId)
  );
}
