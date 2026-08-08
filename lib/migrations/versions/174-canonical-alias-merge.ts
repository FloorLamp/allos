import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { mergeSupersededCanonicalNames } from "../../canonical-alias-merge-db";

// Migration 174 — retire the superseded canonical biomarker spellings already on
// disk, and move their readings onto the surviving series (#2306).
//
// A curated CANONICAL_ALIASES route was inert on any database that had already
// imported the spelling it exists to fix: the import registers that spelling as an
// `ai` row in canonical_biomarkers, buildCanonicalIndex lets a real entry win a key
// collision, and the route is dropped. Since importing the spelling is HOW you
// discover the alias is needed, every alias added in response to a real document was
// dead on arrival on the database that motivated it. The same shape one step over:
// a stored spelling written BEFORE a curated entry existed (`Hyaline Casts, Urine`
// beside `Casts, Hyaline, Urine`) keeps the losing spelling forever even though
// snapCanonicalName resolves it for every fresh import.
//
// WHY A MIGRATION AND NOT ONLY A BOOT TASK. Removing the blocking vocabulary row is
// forward-only: it fixes the next import. What it does NOT do is move the readings
// already stranded on the wrong series — and re-pointing every reading of an analyte,
// per profile, together with the star / snooze / goal / gap / protocol state keyed on
// its name, is a one-shot data move (AGENTS.md: "Put one-shot data moves in a
// migration, not a settings flag"). Doing it here gives it a version, a transaction,
// and a replay test, instead of leaving it an invisible side effect of a boot that
// also runs several times an hour.
//
// WHY A BOOT TASK AS WELL. CANONICAL_ALIASES grows in releases with NO schema change,
// and any import between two boots can mint a fresh blocking row, so the same pass is
// also registered in bootTasks (after seedCanonicalBiomarkers, before the flag
// reconcile) — the reasoning seedCanonicalBiomarkers itself is a boot task for. One
// function, called from both: mergeSupersededCanonicalNames.
//
// Replay-safe and idempotent: it re-derives its whole plan from the current
// vocabulary, so a second run finds nothing superseded and writes nothing. It clears
// `settings.canonical_flags_sig` when it moved anything, so the boot flag-reconcile
// that follows re-derives the flags of readings that just landed on a curated band.
export function up(db: Database.Database): void {
  mergeSupersededCanonicalNames(db);
}

export const migration: Migration = {
  id: 174,
  name: "174-canonical-alias-merge",
  up,
};
