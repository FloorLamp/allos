import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 176 — retire the flags the app derived for an unqualified `Glucose`
// against a band it no longer publishes (#2337).
//
// The canonical dataset carried a FASTING band on BOTH glucose entries: `Glucose,
// Fasting` at 70–99 (correct, the ADA normal fasting range) and unqualified
// `Glucose` at 65–99 — which is also a fasting interval, the familiar lab-printed
// CMP one, since CMP glucose is reported in a fasting frame. So a reading whose
// fasting state the document never stated was judged against a frame it never
// claimed: a post-meal 120 is entirely normal and was flagged high. #2337 makes the
// unqualified entry BAND-LESS with a stated reason rather than re-banding it to the
// random frame, because a genuine fasting 130 reading as normal is the worse of the
// two failures and there is no guideline interval to copy (the ADA publishes random
// DIAGNOSTIC thresholds, not a reference interval).
//
// WHY A MIGRATION AND NOT ONLY THE BOOT RECONCILE. Removing the band does change the
// canonical flags signature, so `reconcileFlagsIfCanonicalChanged` re-derives every
// record on the next boot — that half needs no help, and no FLAG_LOGIC_VERSION bump
// (the derivation LOGIC is unchanged; the dataset half of the signature forces the
// pass on its own). But the re-derivation DELIBERATELY declines to clear a stored
// high/low when the analyte has no reference bounds: `reconciledFlag`'s "unknown"
// branch returns `undefined` so it never overrides a lab clinical flag it cannot
// validate. That guard is right for the ~90 analytes the catalog has always declined
// to band — any high/low on those came from the document, not from us. It is wrong
// here for exactly one reason: `reconcileFlags` OWNS the flag on every numeric
// Glucose row (it overrides an over-strict or missing lab flag, and re-runs on every
// import and on every canonical change), so a stored high / low / non-optimal-* on
// such a row is OUR assertion of the fasting frame, not the lab's. Left alone it
// would outlive the band that justified it — a stale red that nothing can re-derive
// and nothing would ever clear. Clearing it is a one-shot data move, which AGENTS.md
// puts in a migration.
//
// SCOPE, deliberately narrow:
//   • canonical_name = 'Glucose' only. `Glucose, Fasting` keeps 70–99, and every
//     other glucose entry (urine, gestational screen) is untouched.
//   • value_num IS NOT NULL — the numeric reconcile's own eligibility gate. A
//     qualitative glucose row was never judged against the band, so its flag is not
//     ours to clear.
//   • only the flags the numeric reconcile writes. An `abnormal` / `immune` / any
//     qualitative verdict is left exactly as it is.
//
// What the reading KEEPS is everything that was ever real: its value, its date, its
// unit, and the source document's own printed `reference_range`. The detail page
// renders that range attributed to the lab when the catalog has none (#2346), so the
// draw's actual basis stays visible — what goes is only allos's claim about it.
//
// Replay-safe: the UPDATE is idempotent (a second run matches no rows), and it
// re-derives its whole effect from the current table rather than from a stamp.
// Determinism: reads only the DB, no clock, no network.

// The flag values reconcileFlags derives and is allowed to revisit — kept in sync by
// hand with RECONCILABLE_FLAGS in lib/queries/medical/flags.ts. Frozen here on
// purpose: a shipped migration must keep doing exactly what it did the day it ran,
// so it cannot import a constant that later releases are free to grow.
const DERIVED_FLAGS = [
  "normal",
  "non-optimal",
  "non-optimal-high",
  "non-optimal-low",
  "high",
  "low",
];

export function up(db: Database.Database): void {
  db.prepare(
    `UPDATE medical_records
        SET flag = NULL
      WHERE canonical_name = 'Glucose' COLLATE NOCASE
        AND value_num IS NOT NULL
        AND flag IN (${DERIVED_FLAGS.map(() => "?").join(",")})`
  ).run(...DERIVED_FLAGS);
}

export const migration: Migration = {
  id: 176,
  name: "176-unqualified-glucose-unflag",
  up,
};
