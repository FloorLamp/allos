// The DB half of the #2306 reconciliation: retire the superseded canonical
// biomarker spellings lib/canonical-alias-merge.ts identifies, and carry every row
// and every piece of name-keyed side-state onto the surviving spelling.
//
// Called from TWO places, deliberately:
//
//   • migration 174 — the ONE-SHOT data move. The drift already on disk is repaired
//     once, at a known schema version, inside the runner's IMMEDIATE transaction,
//     with a replay test. AGENTS.md: "Put one-shot data moves in a migration."
//   • bootTasks (after seedCanonicalBiomarkers) — the RECURRING guard. CANONICAL_ALIASES
//     grows in releases with NO schema change, and any import between two boots can
//     mint a fresh blocking ai row, so a migration alone could never satisfy the
//     issue's acceptance criterion ("… after ONE boot, with no manual DB edit and no
//     re-import"). Exactly the reasoning seedCanonicalBiomarkers itself is a boot task
//     for: the data can change without the schema changing.
//
// It takes an explicit handle rather than the lib/db singleton because a migration
// runs before that singleton exists. Idempotent, and cheap when there is nothing to
// do: the plan is computed with READS ONLY and the write transaction is opened only
// when the plan is non-empty, so the every-5-minutes notify-tick boot does not take
// the write lock for a no-op.
//
// PROFILE SCOPING. The vocabulary (canonical_biomarkers) is a global table, but every
// row this pass rewrites is profile-owned, so the whole rename runs per profile and
// every statement filters by profile_id. The side-state carries are per-profile for a
// second reason too: a collision (the profile already stars/snoozes/tracks the target)
// is a per-profile fact.

import type Database from "better-sqlite3";
import { buildCanonicalIndex } from "./canonical-name";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "./dismissal-keys";
import { biomarkerCoverageKey } from "./coverage-gaps";
import {
  rewriteBiomarkerOutcomeKeys,
  supersededStoredNames,
  supersededVocabularyRows,
  type CanonicalMerge,
} from "./canonical-alias-merge";
import { runBootTx } from "./migrations/schema-utils";

export interface CanonicalMergeReport {
  // The ai-coined vocabulary rows deleted, as `from → to`.
  vocabulary: CanonicalMerge[];
  // The stored-spelling renames applied, per profile.
  renames: { profileId: number; merge: CanonicalMerge; records: number }[];
}

interface Plan {
  vocabulary: CanonicalMerge[];
  stored: { profileId: number; merges: CanonicalMerge[] }[];
}

// READ-ONLY. Works out what would change, so the caller can skip the transaction
// entirely on the (overwhelmingly common) boot where nothing has drifted.
function planMerges(db: Database.Database): Plan {
  // The SAME order getCanonicalVocabulary reads in — seeded/curated names ahead of
  // ai-coined ones — because that order decides which spelling wins a shared key.
  const rows = db
    .prepare(
      "SELECT name, source FROM canonical_biomarkers ORDER BY (source = 'ai'), name COLLATE NOCASE"
    )
    .all() as { name: string; source: string | null }[];
  const vocabulary = supersededVocabularyRows(rows);
  // The index the app will use ONCE the superseded rows are gone: that is what a
  // fresh import would snap a name onto, and therefore what stored rows must say.
  const retiring = new Set(vocabulary.map((m) => m.from.toLowerCase()));
  const index = buildCanonicalIndex(
    rows.map((r) => r.name).filter((n) => !retiring.has(n.toLowerCase()))
  );
  const stored: Plan["stored"] = [];
  const distinctNames = db.prepare(
    `SELECT DISTINCT canonical_name AS name FROM medical_records
      WHERE profile_id = ? AND TRIM(COALESCE(canonical_name, '')) != ''`
  );
  for (const { id } of db
    .prepare("SELECT id FROM profiles ORDER BY id")
    .all() as { id: number }[]) {
    const names = (distinctNames.all(id) as { name: string }[]).map(
      (r) => r.name
    );
    const merges = supersededStoredNames(names, index);
    if (merges.length > 0) stored.push({ profileId: id, merges });
  }
  return { vocabulary, stored };
}

// Move one profile's readings and name-keyed side-state from `from` onto `to`.
//
// EXPORTED because a DATASET rename asks the identical question. This pass discovers
// its renames from the vocabulary (an ai row an alias supersedes); migration 177
// (#2335) knows its renames up front — 20 curated entries whose names changed so each
// states what it measures — but the carry is the same one, and duplicating this
// checklist is how a rename silently orphans a star or a protocol link. The caller
// supplies the pairs and its own transaction; this owns what a canonical name is
// keyed by.
//
// EVERYTHING KEYED ON THE CANONICAL NAME (the AGENTS.md row-ops checklist — children,
// nullable links, provenance, tombstones, saved/dismissed side-state, filesystem
// artifacts — enumerated for this domain rather than assumed):
//
//   1. medical_records.canonical_name — the readings themselves. `name` (the printed
//      lab spelling) is PROVENANCE and is deliberately left alone.
//   2. saved_items (kind='biomarker') — the ★ pin, keyed by canonical name.
//   3. upcoming_dismissals — the retest snooze `biomarker:<retest identity>` and the
//      flagged-result/trajectory acknowledgment `biomarker-flag:<family>`. Both are
//      DERIVED keys, so they only move when the derivation actually differs.
//   4. goals.biomarker_name — a biomarker-linked goal's anchor/display name.
//   5. coverage_gaps (kind='biomarker') — the tracked "not in the catalog" gap, keyed
//      by family. Left behind it would be a phantom gap forever: the covered-check
//      re-derives from the key, and the old key names an analyte nobody now has.
//   6. protocols.outcome_keys — the JSON `biomarker:<canonical>` outcome links.
//
// Deliberately NOT carried, with reasons:
//   • medical_records.name / panel / notes / source — provenance, not identity.
//   • the undo holding table's captured delete payload — restoring a row replays the
//     row exactly as deleted, and the NEXT run of this pass re-snaps it. Rewriting a
//     tombstone would make undo restore something other than what was deleted.
//   • medical_documents and the upload files on disk — a document is not keyed on any
//     analyte name; nothing on the filesystem is.
//
// Each carry follows migration 103's UPDATE OR IGNORE → DELETE shape, which is also
// what migrateRenamedBiomarker does at the record-edit seam: move the row onto the
// target, and where the target already holds one, DROP the redundant old row rather
// than duplicating. `from` and `to` always differ case-insensitively
// (CanonicalMerge's contract), so a DELETE of the old key can never hit the row the
// UPDATE just moved.
export function applyCanonicalRename(
  db: Database.Database,
  profileId: number,
  { from, to }: CanonicalMerge
): number {
  const records = db
    .prepare(
      `UPDATE medical_records SET canonical_name = ?
        WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE`
    )
    .run(to, profileId, from).changes;

  db.prepare(
    `UPDATE OR IGNORE saved_items SET key = ?
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
  ).run(to, profileId, from);
  db.prepare(
    `DELETE FROM saved_items
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
  ).run(profileId, from);

  for (const keyOf of [biomarkerDismissalKey, biomarkerFlagDismissalKey]) {
    const oldKey = keyOf(from);
    const newKey = keyOf(to);
    // A rename INSIDE one #482 family (a vitamin-D spelling onto another) leaves both
    // derived keys identical — nothing to move, and the DELETE below would eat a live
    // suppression.
    if (oldKey === newKey) continue;
    db.prepare(
      `UPDATE OR IGNORE upcoming_dismissals SET signal_key = ?
        WHERE profile_id = ? AND signal_key = ?`
    ).run(newKey, profileId, oldKey);
    db.prepare(
      `DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?`
    ).run(profileId, oldKey);
  }

  db.prepare(
    `UPDATE goals SET biomarker_name = ?
      WHERE profile_id = ? AND biomarker_name = ? COLLATE NOCASE`
  ).run(to, profileId, from);

  const oldGapKey = biomarkerCoverageKey(from);
  const newGapKey = biomarkerCoverageKey(to);
  if (oldGapKey !== newGapKey) {
    db.prepare(
      `UPDATE OR IGNORE coverage_gaps SET item_key = ?, label = ?
        WHERE profile_id = ? AND kind = 'biomarker' AND item_key = ? COLLATE NOCASE`
    ).run(newGapKey, to, profileId, oldGapKey);
    db.prepare(
      `DELETE FROM coverage_gaps
        WHERE profile_id = ? AND kind = 'biomarker' AND item_key = ? COLLATE NOCASE`
    ).run(profileId, oldGapKey);
  }

  const protocols = db
    .prepare("SELECT id, outcome_keys FROM protocols WHERE profile_id = ?")
    .all(profileId) as { id: number; outcome_keys: string }[];
  for (const p of protocols) {
    const next = rewriteBiomarkerOutcomeKeys(p.outcome_keys, from, to);
    if (next === null) continue;
    db.prepare(
      "UPDATE protocols SET outcome_keys = ? WHERE id = ? AND profile_id = ?"
    ).run(next, p.id, profileId);
  }
  return records;
}

// Run the whole reconciliation. Returns what moved (empty when nothing did).
export function mergeSupersededCanonicalNames(
  db: Database.Database
): CanonicalMergeReport {
  const probe = planMerges(db);
  const report: CanonicalMergeReport = { vocabulary: [], renames: [] };
  if (probe.vocabulary.length === 0 && probe.stored.length === 0) return report;

  // `source = 'ai'` is the whole safety property: a curated row is untouchable.
  const drop = db.prepare(
    "DELETE FROM canonical_biomarkers WHERE name = ? AND source = 'ai'"
  );
  runBootTx(
    db.transaction(() => {
      // runBootTx re-runs the whole callback on a SQLITE_BUSY retry, so the report is
      // rebuilt from scratch each attempt rather than accumulating a lost attempt's rows.
      report.vocabulary = [];
      report.renames = [];
      // Re-planned INSIDE the write lock, so a concurrent import between the probe
      // and here can neither be missed nor acted on with stale facts.
      const plan = planMerges(db);
      for (const { profileId, merges } of plan.stored)
        for (const merge of merges)
          report.renames.push({
            profileId,
            merge,
            records: applyCanonicalRename(db, profileId, merge),
          });
      for (const merge of plan.vocabulary) {
        drop.run(merge.from);
        report.vocabulary.push(merge);
      }
      if (report.vocabulary.length === 0 && report.renames.length === 0) return;
      // A reading that just moved onto a curated entry can now derive a flag it never
      // could (its old ai-coined row carried no ranges at all), and one that moved
      // between entries is judged against a different band. Clearing the stored
      // signature makes reconcileFlagsIfCanonicalChanged — which runs immediately
      // after this in bootTasks — re-derive once. Nothing about the RANGES or the
      // flag LOGIC changed, so lib/canonical-flags-version.ts is deliberately NOT
      // bumped: this is a "which rows changed" event, not a "what the ranges say" one,
      // and a version bump would also force the re-scan on every database that has no
      // drift to repair.
      db.prepare(
        "DELETE FROM settings WHERE key = 'canonical_flags_sig'"
      ).run();
    })
  );
  return report;
}
