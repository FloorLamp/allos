import Database from "better-sqlite3";
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
import { workerDbPath } from "./worker-env";

// Put a fixture profile's ★ store back the way profile creation left it (#3637).
//
// WHY A SPEC CANNOT RESTORE THIS THROUGH THE UI. The star/pin family's specs share
// one profile per file, and a worker's database persists across every test that
// worker runs — so "unstar what I starred" reads like a complete restore and is
// not one. Starring is only half of what these specs do; the other half is a
// RE-SEQUENCE, and the two writes touch different columns:
//
//   • a fresh ★ inserts a row with `position` NULL, and `orderSavedRefs`
//     (lib/saved-items.ts) sorts unpositioned rows newest-first BEHIND every
//     positioned one;
//   • a reorder — the drag, or the ⋯ menu's arrow — calls `setSavedKindOrder`,
//     which stamps a dense 0..n-1 `position` onto EVERY row of the kind.
//
// So a test that stars, reorders, then unstars leaves the rows it did not unstar
// POSITIONED. The next test on that worker stars something and expects it to lead;
// it does not, because a positioned seed now sorts ahead of it. That is #3637's
// rotating victim: which test pays depends only on which tests shared its worker,
// which is the scheduler's business and not the diff's. Reproduced deterministically
// at `--workers=1` (one worker runs the whole file in order, so the reorder test
// always precedes its readers) and intermittently at CI's two.
//
// Restoring through the UI cannot fix it — there is no gesture that clears a
// position — so this writes the store directly, the #868 spec-owned-fixture rule
// the hygiene doc already prefers for setup ("seed instead" of growing a ceiling).
//
// It calls the PRODUCTION seeder rather than re-spelling its inserts, because the
// state being restored is precisely "what profile creation makes": the four standard
// metric rows, unpositioned, carrying the epoch sentinel `created_at` that keeps them
// behind every real save. A copy here would drift the day the seed set changes and
// would drift SILENTLY, since a wrong fixture does not throw — it just orders
// differently.
//
// Kind-scoped: `clinical-result` saves (the curate fixture seeds one) are a different
// kind on the same table and are none of this family's business.
export function resetSavedMetrics(profileName: string): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(profileName) as { id: number } | undefined;
    if (!row) throw new Error(`no fixture profile named ${profileName}`);
    db.prepare(
      "DELETE FROM saved_items WHERE profile_id = ? AND kind = 'trend-metric'"
    ).run(row.id);
    seedStandardMetricSaves(db, row.id);
  } finally {
    db.close();
  }
}
