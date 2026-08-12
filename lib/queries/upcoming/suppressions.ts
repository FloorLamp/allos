// The findings-suppression store (issue #39/#227): the one snooze/dismiss ledger
// (upcoming_dismissals) behind BOTH the Upcoming filter and the generalized
// findings bus, plus the name-keyed suppression lifecycle helpers (#203/#283)
// that clear/re-key rows at delete/rename seams. Every read/write is
// profile-scoped (enforced by lib/__tests__/profile-scoping.test.ts and the
// dynamic no-bleed guard in lib/__db_tests__/upcoming.scoping.test.ts).

import { db, hoistedStatement } from "../../db";
import { type SuppressionRecord } from "../../upcoming-suppress";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
  immunizationDismissalKey,
  immunizationCodesLosingBacking,
  preventiveDismissalKey,
  prDismissalKeysLosingBacking,
  PR_CARDIO_PREFIX,
  PR_STRENGTH_PREFIX,
} from "../../dismissal-keys";
import { movementLoadKey } from "../../lifts";
import { activityHistoryKey } from "../../activities-catalog";
import { cleanupOrphanSavedBiomarkers, biomarkerFamilyKey } from "../medical";
import { NON_IDENTITY_CATEGORIES } from "../../medical-categories";

// The profile's snooze/dismiss rows, keyed by signal_key (a Finding's dedupeKey)
// for O(1) lookup during filtering. This is the shared read behind BOTH the
// Upcoming filter and the generalized findings bus (coaching/digest, issue #39):
// every engine's suppression lives in the one upcoming_dismissals store, so a
// single map answers "is this key suppressed?" for all of them. Profile-scoped
// (the WHERE filters profile_id — enforced by lib/__tests__/profile-scoping.test.ts
// and lib/__db_tests__/upcoming.scoping).
// Statement hoisted: every findings builder asks the suppression bus, so this runs
// many times per render and once per member on a cross-profile surface (622
// executions on one /household render). NOT cache()-wrapped — dismissFinding and
// restoreFinding write this table, and an inline re-read after a dismissal must
// see the new row.
const FINDING_SUPPRESSIONS_STMT = hoistedStatement(
  `SELECT signal_key, snooze_until, dismissed_at
     FROM upcoming_dismissals WHERE profile_id = ?`
);
export function getFindingSuppressions(
  profileId: number
): Map<string, SuppressionRecord> {
  const rows = FINDING_SUPPRESSIONS_STMT.all(profileId) as {
    signal_key: string;
    snooze_until: string | null;
    dismissed_at: string | null;
  }[];
  const m = new Map<string, SuppressionRecord>();
  for (const r of rows)
    m.set(r.signal_key, {
      snooze_until: r.snooze_until,
      dismissed_at: r.dismissed_at,
    });
  return m;
}

// ---- Generalized suppression writers (issue #39) ----
// The table-usage side of the findings bus: the Upcoming actions AND the coaching/
// digest dismiss affordances all funnel through these, so there's one upsert/delete
// on upcoming_dismissals rather than a copy per surface. Each is profile-scoped and
// keyed by an arbitrary Finding dedupeKey (existing Upcoming keys unchanged).

// Snooze a finding until `until` (YYYY-MM-DD), clearing any dismiss — upserts on
// the (profile_id, signal_key) unique index so re-snoozing just moves the date.
export function snoozeFinding(
  profileId: number,
  dedupeKey: string,
  until: string
): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, ?, NULL)
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET snooze_until = excluded.snooze_until, dismissed_at = NULL`
  ).run(profileId, dedupeKey, until);
}

// Dismiss a finding indefinitely (until restored), clearing any snooze so a
// dismiss always wins.
export function dismissFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, NULL, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET dismissed_at = datetime('now'), snooze_until = NULL`
  ).run(profileId, dedupeKey);
}

// Restore a finding: drop its suppression row so it reappears immediately.
export function restoreFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
  ).run(profileId, dedupeKey);
}

// ---- Name-keyed suppression lifecycle (issue #203) ----
// upcoming_dismissals is keyed by a REUSABLE string (a biomarker's canonical name,
// a vaccine code), so a dismissal left behind after its subject is deleted/renamed
// silently re-attaches to a later subject that reuses the same key (AGENTS.md #224:
// "names and codes DO recycle"). These helpers clear/re-key those rows at the
// delete/rename seams, mirroring cleanupOrphanSavedBiomarkers on the save store. Each is
// profile-scoped.

// Drop biomarker retest dismissals (`biomarker:<family>`) AND flagged-result
// dismissals (`biomarker-flag:<family>`, issues #283/#564) whose backing readings
// are all gone, so dismissing a nudge → deleting every reading → re-adding the
// marker later re-surfaces the nudge instead of it being suppressed by the stale
// row. BOTH keys are now the #482 FAMILY identity (biomarkerFamilyKey) — the flag
// key moved to the family in #564 to share the trajectory acknowledgment — so each
// is de-orphaned only when NO family member has a reading left, and a stale
// legacy per-name flag row (from before #564) is de-orphaned here too (its suffix
// isn't in the family-key set). A dismissal with no matching reading can never fire
// again, so removing it is a pure de-orphan (mirrors cleanupOrphanSavedBiomarkers).
// 11 = length('biomarker:') + 1; 16 = length('biomarker-flag:') + 1.
export function cleanupOrphanBiomarkerDismissals(profileId: number): void {
  // A row in a NON_IDENTITY category is not a backing reading (#2318): an
  // `assessment` never flags and never comes due for a retest, so a dismissal
  // backed only by one can never fire again — exactly the de-orphan condition.
  const backing = `category NOT IN (${NON_IDENTITY_CATEGORIES.map(
    () => "?"
  ).join(",")})`;
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ?
         AND signal_key LIKE 'biomarker:%'
         AND substr(signal_key, 11) NOT IN (
           SELECT DISTINCT lower(${biomarkerFamilyKey()})
             FROM medical_records WHERE profile_id = ? AND ${backing}
         )`
  ).run(profileId, profileId, ...NON_IDENTITY_CATEGORIES);
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ?
         AND signal_key LIKE 'biomarker-flag:%'
         AND substr(signal_key, 16) NOT IN (
           SELECT DISTINCT lower(${biomarkerFamilyKey()})
             FROM medical_records WHERE profile_id = ? AND ${backing}
         )`
  ).run(profileId, profileId, ...NON_IDENTITY_CATEGORIES);
}

// One call that sweeps BOTH name-keyed biomarker side-stores — the biomarker SAVES
// (saved_items where kind='biomarker', #1456) and the retest/flag dismissals
// (upcoming_dismissals) — of any row whose backing readings are all gone. Both stores
// key on a REUSABLE canonical name, so every operation that removes readings (a record
// delete, a document delete/reprocess/reassign) can orphan either one, and a name that
// later recycles silently re-attaches the stale save/snooze (AGENTS.md row-ops: "names
// and codes DO recycle" — the #203/#283 class). The per-record edit/delete paths already
// swept both, but the document-level resets swept only saves (#327); bundling the
// two here means the next document-level operation can't clean one and forget the
// other (same disease as the import-footprint two-lists rule). Profile-scoped.
export function cleanupOrphanBiomarkerKeyedState(profileId: number): void {
  cleanupOrphanSavedBiomarkers(profileId);
  cleanupOrphanBiomarkerDismissals(profileId);
}

// ---- Personal-record dismissals (issue #1931) ------------------------------

// Drop the profile's `pr:strength:` / `pr:cardio:` celebration dismissals whose
// backing history is gone — the movement/lane (or cardio activity) no longer appears
// in ANY of the profile's sets/activities.
//
// Why this is needed at all: a PR key contains a user-recyclable string (the movement
// a set was logged under, the activity a session was titled). Rename a lift, move its
// sets to a different implement, or delete and later re-log an activity, and the
// dismissal outlives its subject — then a genuinely NEW record earned under the
// recycled name arrives PRE-SILENCED, and the celebration is suppressed by a row
// minted for data that no longer exists (AGENTS.md row-ops: "names and codes DO
// recycle" — the #203/#283/#327 class, of which this is the training instance).
//
// A dismissal with no backing history can never fire again, so removing it is a pure
// de-orphan — the same contract cleanupOrphanBiomarkerDismissals has one domain over.
// The comparison runs in JS rather than SQL because the identity is
// `movementLoadKey`/`activityHistoryKey`, canonical pure functions SQLite cannot call;
// pushing the arithmetic into lib/dismissal-keys keeps the sweep byte-identical to the
// keys the builders mint (the #227 "derive the same key" alignment).
//
// Cheap by construction: the very first statement short-circuits when the profile has
// no `pr:` suppression rows at all — the overwhelmingly common case — so the seams
// that call this on every activity save don't pay for a history scan.
// Profile-scoped; safe to call repeatedly (idempotent).
export function cleanupOrphanPrDismissals(profileId: number): void {
  const stored = (
    db
      .prepare(
        `SELECT signal_key FROM upcoming_dismissals
          WHERE profile_id = ? AND (signal_key LIKE ? OR signal_key LIKE ?)`
      )
      .all(profileId, `${PR_STRENGTH_PREFIX}%`, `${PR_CARDIO_PREFIX}%`) as {
      signal_key: string;
    }[]
  ).map((r) => r.signal_key);
  if (stored.length === 0) return;

  // Every rep-bearing, non-warmup set — exactly the rows strengthSetRows feeds the PR
  // engine, so a set the records are computed from is a set that keeps its key alive.
  const setRows = db
    .prepare(
      `SELECT DISTINCT s.exercise AS exercise, s.equipment_id AS equipmentId
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ?
          AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
          AND s.warmup = 0`
    )
    .all(profileId) as { exercise: string; equipmentId: number | null }[];
  // getStrengthByExercise(profileId, true) collapses to the movement-wide grouping for
  // a profile whose sets carry NO implement link at all, so the live key set has to
  // collapse the same way or every dismissal on such a profile would look orphaned.
  const laned = setRows.some((r) => r.equipmentId != null);
  const liveStrength = setRows.map((r) =>
    movementLoadKey(r.exercise, laned ? r.equipmentId : null)
  );

  // Cardio identity is the activity NAME, which lives either in a `cardio` row's title
  // or in a component of a mixed session — both of which effortEntries reads, so both
  // must count as backing here.
  const liveCardio = cardioActivityIdentities(profileId);

  const lost = prDismissalKeysLosingBacking(stored, liveStrength, liveCardio);
  if (lost.length === 0) return;
  const placeholders = lost.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM upcoming_dismissals
      WHERE profile_id = ? AND signal_key IN (${placeholders})`
  ).run(profileId, ...lost);
}

// Every cardio activity identity the profile has logged: top-level `cardio` rows by
// title, plus the `cardio` legs of composite sessions (the two shapes effortEntries
// folds into one list, which is what getCardioByActivity — and therefore the cardio PR
// engine — actually groups). Kept local to the sweep so it reads the SAME two shapes
// without pulling the training query layer into the suppression module.
function cardioActivityIdentities(profileId: number): string[] {
  const rows = db
    .prepare(
      `SELECT type, title, components FROM activities
        WHERE profile_id = ? AND (type = 'cardio' OR components IS NOT NULL)`
    )
    .all(profileId) as {
    type: string;
    title: string;
    components: string | null;
  }[];
  const out = new Set<string>();
  for (const r of rows) {
    let comps: unknown = null;
    if (r.components) {
      try {
        comps = JSON.parse(r.components);
      } catch {
        comps = null;
      }
    }
    const legs = Array.isArray(comps)
      ? comps.filter(
          (c): c is { type: string; name: string } =>
            !!c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "cardio" &&
            typeof (c as { name?: unknown }).name === "string" &&
            !!(c as { name: string }).name.trim()
        )
      : [];
    if (legs.length) for (const c of legs) out.add(activityHistoryKey(c.name));
    else if (r.type === "cardio" && r.title.trim())
      out.add(activityHistoryKey(r.title));
  }
  return [...out];
}

// Re-key a biomarker's SAVE + retest/flag dismissals when its canonical name is
// renamed: the user's save/snooze intent follows the reading to its new name rather
// than orphaning under the old (manifestations 3 & 4). UPDATE OR IGNORE so a
// collision with an existing save/dismissal already under the new name is a no-op;
// the caller then runs the orphan sweeps to drop any leftover old row. The save
// store's `key` is COLLATE NOCASE (as the star store's canonical_name was); the
// dismissal keys are already lowercased. The `biomarker-flag:` key (the hero's
// flagged-result dismissal, issue #283) rides the same lifecycle.
//
// Scoped to kind='biomarker' (#1456): the unified store also holds `trend-metric`
// saves keyed by metric id, and a biomarker rename must never touch those.
export function migrateRenamedBiomarker(
  profileId: number,
  oldName: string,
  newName: string
): void {
  db.prepare(
    `UPDATE OR IGNORE saved_items
        SET key = ?
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
  ).run(newName, profileId, oldName);
  // If the rename COLLIDED with an existing save under the new name (UPDATE OR
  // IGNORE left the old row), drop the now-redundant old save. Before #482 the
  // family-blind orphan sweep dropped it (the old name lost its backing on rename);
  // the family-aware sweep keeps a same-family sibling backed, so the collapse has
  // to be explicit here — a rename must never leave two saves on one family.
  db.prepare(
    `DELETE FROM saved_items
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
  ).run(profileId, oldName);
  const rekey = db.prepare(
    `UPDATE OR IGNORE upcoming_dismissals
        SET signal_key = ?
      WHERE profile_id = ? AND signal_key = ?`
  );
  rekey.run(
    biomarkerDismissalKey(newName),
    profileId,
    biomarkerDismissalKey(oldName)
  );
  rekey.run(
    biomarkerFlagDismissalKey(newName),
    profileId,
    biomarkerFlagDismissalKey(oldName)
  );
}

// Retire a preventive rule's DISMISSAL when its due EPISODE ends (issue #1024). A
// preventive item's `<kind>:<ruleKey>` dismissal is the "normal" lifecycle — dismissed
// → hidden indefinitely — so without this, dismissing THIS episode's nag ("stop nagging
// me about this one") silently suppresses EVERY future cycle's due, on both the Upcoming
// page and the push (same bus, same key). The #203 row-ops disease: a string-keyed
// leftover becomes wrong suppression. So a satisfying event (recordPreventiveDone) OR the
// nudge's episode-end sweep (toClear — a rule leaving actionable for any reason) clears
// it, mirroring clearImmunizationDismissals one domain over, and the NEXT cycle's due
// surfaces fresh. SNOOZES are left untouched (dismissed_at IS NULL) — they self-expire by
// design; a lasting opt-out lives in preventive_overrides, not here. No-op for an unknown
// rule key. Profile-scoped.
export function clearPreventiveDismissal(
  profileId: number,
  ruleKey: string
): void {
  const key = preventiveDismissalKey(ruleKey);
  if (!key) return;
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ? AND signal_key = ? AND dismissed_at IS NOT NULL`
  ).run(profileId, key);
}

// Clear the retest dismissals for the given immunization component codes (their
// last backing dose was just deleted — see immunizationCodesLosingBacking), so
// re-adding that immunization later re-surfaces the due nudge. A no-op for the
// empty set (the common case: the deleted dose still has a sibling crediting it).
export function clearImmunizationDismissals(
  profileId: number,
  codes: string[]
): void {
  if (codes.length === 0) return;
  const placeholders = codes.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ? AND signal_key IN (${placeholders})`
  ).run(profileId, ...codes.map(immunizationDismissalKey));
}

// The ONE immunization dismissal sweep behind every path that un-backs a vaccine
// code — a per-dose delete, an edit that re-codes a dose, and a Data → Manage bulk
// delete (issue #376). Given the vaccine strings of the doses just removed (or
// re-coded away from), it reads the doses that REMAIN for the profile and clears
// the `immunization:<code>` dismissal of any component code whose last backing dose
// is now gone — so a later re-add re-surfaces the due nudge instead of hitting a
// stale suppression (issue #203). Scoped to the removed doses' component codes on
// purpose, so a vaccine the profile has never recorded keeps its lasting dismissal.
// Must be called AFTER the delete/update so "remaining" reflects the new state, and
// with the removed vaccines captured BEFORE it (their rows are gone afterward).
export function sweepImmunizationDismissals(
  profileId: number,
  removedVaccines: string[]
): void {
  if (removedVaccines.length === 0) return;
  const remaining = (
    db
      .prepare(
        "SELECT DISTINCT vaccine FROM immunizations WHERE profile_id = ?"
      )
      .all(profileId) as { vaccine: string }[]
  ).map((r) => r.vaccine);
  const lost = new Set<string>();
  for (const v of removedVaccines)
    for (const c of immunizationCodesLosingBacking(v, remaining)) lost.add(c);
  clearImmunizationDismissals(profileId, [...lost]);
}
