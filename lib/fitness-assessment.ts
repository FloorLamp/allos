// Fitness-check write cores + reads (issue #834). AUTH-BLIND and profileId-first — no
// lib/auth import; the Server Action layer owns the gate. Every SQL statement touching a
// profile-owned table filters by profile_id (fitness_assessments); the child
// fitness_assessment_entries is scoped THROUGH its parent.
//
// A fitness check is a dated SESSION grouping the battery's measured tests. Values write
// through their NATURAL stores — a `set` on the assessment activity (exercise_sets, so
// exerciseHistoryKey + every training surface sees it), a `vital` medical_records row
// (the canonical names the fitness-norms engine reads → healthspan pillars pick them up
// with zero changes), or a body_metrics column. The fitness_assessment_entries row is the
// session's COVERAGE LEDGER: which test, its tier/store, a canonical `value` SNAPSHOT (for
// completion % + check-over-check deltas), and the raw field-test input JSON. The
// authoritative value lives in the natural store; the snapshot never competes with it.

import { db, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  fitnessTest,
  BIG_LIFT_OPTIONS,
  type FitnessTier,
  type FitnessTestDef,
} from "@/lib/fitness-battery";
import {
  addCanonicalNames,
  reconcileFlags,
  getBiomarkerSeries,
} from "@/lib/queries/medical";
import { exerciseHistoryNames } from "@/lib/lifts";
import { estimate1RM } from "@/lib/strength";
import type { AmbientReading } from "@/lib/fitness-check-model";

// The normalized payload the Server Action hands the core. The action has already
// derived the canonical `value` (e.g. VO2 from a field test, e1RM from weight×reps) and
// validated the chosen lift; the core routes it to the natural store + records the entry.
export interface FitnessEntryInput {
  date: string;
  testKey: string;
  value: number; // canonical value to store as the entry snapshot + (for vital/body) the stored reading
  rawInput?: unknown; // JSON-serializable field-test inputs (Cooper distance, walk time+HR, method, …)
  note?: string | null; // optional session note (set on the assessment row)
  // Set-store fields (used only when the test's store.kind === 'set').
  liftName?: string; // the chosen lift for the big-lift test (def.store.lift is "")
  reps?: number | null;
  weightKg?: number | null;
  durationSec?: number | null;
}

export type FitnessEntryOutcome =
  | { ok: true; assessmentId: number; inserted: boolean }
  | { ok: false; error: string };

// Get-or-create the session row for (profile, date). Returns its id and its activity_id.
function ensureAssessment(
  profileId: number,
  date: string,
  note: string | null | undefined
): { id: number; activityId: number | null } {
  const existing = db
    .prepare(
      "SELECT id, activity_id FROM fitness_assessments WHERE profile_id = ? AND date = ?"
    )
    .get(profileId, date) as
    { id: number; activity_id: number | null } | undefined;
  if (existing) {
    if (note != null && note.trim()) {
      db.prepare(
        "UPDATE fitness_assessments SET notes = ? WHERE id = ? AND profile_id = ?"
      ).run(note.trim(), existing.id, profileId);
    }
    return { id: existing.id, activityId: existing.activity_id };
  }
  const info = db
    .prepare(
      "INSERT INTO fitness_assessments (profile_id, date, notes) VALUES (?, ?, ?)"
    )
    .run(profileId, date, note != null && note.trim() ? note.trim() : null);
  return { id: Number(info.lastInsertRowid), activityId: null };
}

// Ensure the assessment has an `activities` row to hold its set-based tests, creating one
// on first use and linking it. Returns the activity id.
function ensureAssessmentActivity(
  profileId: number,
  assessmentId: number,
  date: string,
  currentActivityId: number | null
): number {
  if (currentActivityId != null) return currentActivityId;
  const info = db
    .prepare(
      "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', 'Fitness check', ?)"
    )
    .run(date, profileId);
  const activityId = Number(info.lastInsertRowid);
  db.prepare(
    "UPDATE fitness_assessments SET activity_id = ? WHERE id = ? AND profile_id = ?"
  ).run(activityId, assessmentId, profileId);
  return activityId;
}

// Record (or re-record) one test in a session. Idempotent per (session, test): the entry
// row UPSERTs and the set-store path replaces the exercise's set in place, so re-entering
// a test corrects rather than duplicates. Vital/body re-entries append a new natural-store
// row (newest-wins on read, exactly like the manual quick-add paths); the entry snapshot
// still updates so completion/deltas stay correct.
export function saveFitnessEntry(
  profileId: number,
  input: FitnessEntryInput
): FitnessEntryOutcome {
  if (!isRealIsoDate(input.date)) return { ok: false, error: "invalid date" };
  const def = fitnessTest(input.testKey);
  if (!def) return { ok: false, error: "unknown test" };
  if (!Number.isFinite(input.value))
    return { ok: false, error: "invalid value" };
  if (
    def.store.kind === "set" &&
    !def.store.lift &&
    !(input.liftName ?? "").trim()
  )
    return { ok: false, error: "no lift chosen" };

  return writeTx(() => {
    const session = ensureAssessment(profileId, input.date, input.note);
    const store = def.store;
    let canonicalUnit = def.unit;

    if (store.kind === "vital") {
      canonicalUnit = def.unit;
      const info = db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, source, external_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, NULL)`
        )
        .run(
          profileId,
          input.date,
          store.category,
          store.canonical,
          String(input.value),
          input.value,
          def.unit,
          store.canonical
        );
      addCanonicalNames([store.canonical]);
      reconcileFlags(profileId, [Number(info.lastInsertRowid)]);
    } else if (store.kind === "body") {
      // A body_metrics row carrying only this metric (weight_kg NULL — the column is
      // nullable; readers reconcile per-metric newest). body_metrics is UNIQUE on
      // (profile_id, date, source), so a second body test on the SAME date (body fat +
      // resting HR in one session) must UPSERT into the same manual row — COALESCE keeps
      // the other metric already written, and never clobbers a same-date weight.
      db.prepare(
        `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, source, profile_id)
         VALUES (?, NULL, ?, ?, 'manual', ?)
         ON CONFLICT(profile_id, date, source) DO UPDATE SET
           body_fat_pct = COALESCE(excluded.body_fat_pct, body_metrics.body_fat_pct),
           resting_hr = COALESCE(excluded.resting_hr, body_metrics.resting_hr)`
      ).run(
        input.date,
        store.column === "body_fat_pct" ? input.value : null,
        store.column === "resting_hr" ? input.value : null,
        profileId
      );
    } else {
      // set store — a rep/timed/loaded set on the assessment activity.
      const lift = store.lift || (input.liftName ?? "").trim();
      if (!lift) return { ok: false, error: "no lift chosen" };
      const activityId = ensureAssessmentActivity(
        profileId,
        session.id,
        input.date,
        session.activityId
      );
      // Replace this exercise's set in place (re-entry corrects, never stacks).
      db.prepare(
        "DELETE FROM exercise_sets WHERE activity_id = ? AND exercise = ?"
      ).run(activityId, lift);
      db.prepare(
        `INSERT INTO exercise_sets (activity_id, exercise, set_number, reps, weight_kg, duration_sec)
         VALUES (?, ?, 1, ?, ?, ?)`
      ).run(
        activityId,
        lift,
        input.reps ?? null,
        input.weightKg ?? null,
        input.durationSec ?? null
      );
    }

    const rawJson =
      input.rawInput != null ? JSON.stringify(input.rawInput) : null;
    const before = db
      .prepare(
        "SELECT 1 FROM fitness_assessment_entries WHERE assessment_id = ? AND test_key = ?"
      )
      .get(session.id, input.testKey);
    db.prepare(
      `INSERT INTO fitness_assessment_entries
         (assessment_id, test_key, tier, store, value, unit, raw_input)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assessment_id, test_key) DO UPDATE SET
         tier = excluded.tier, store = excluded.store, value = excluded.value,
         unit = excluded.unit, raw_input = excluded.raw_input`
    ).run(
      session.id,
      input.testKey,
      def.tier,
      store.kind,
      input.value,
      canonicalUnit,
      rawJson
    );

    return { ok: true, assessmentId: session.id, inserted: !before };
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export interface FitnessEntryRecord {
  testKey: string;
  tier: FitnessTier;
  store: "set" | "vital" | "body";
  value: number;
  unit: string;
  rawInput: unknown;
}

export interface FitnessAssessmentRecord {
  id: number;
  date: string;
  notes: string | null;
  entries: FitnessEntryRecord[];
}

// A profile's fitness-check sessions, newest first (default the two most recent — enough
// for check-over-check deltas). Each carries its coverage-ledger entries.
export function getFitnessAssessments(
  profileId: number,
  limit = 12
): FitnessAssessmentRecord[] {
  const sessions = db
    .prepare(
      `SELECT id, date, notes FROM fitness_assessments
        WHERE profile_id = ? ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(profileId, limit) as {
    id: number;
    date: string;
    notes: string | null;
  }[];
  if (sessions.length === 0) return [];
  const entryStmt = db.prepare(
    `SELECT e.test_key, e.tier, e.store, e.value, e.unit, e.raw_input
       FROM fitness_assessment_entries e
       JOIN fitness_assessments a ON a.id = e.assessment_id
      WHERE e.assessment_id = ? AND a.profile_id = ?`
  );
  return sessions.map((s) => ({
    id: s.id,
    date: s.date,
    notes: s.notes,
    entries: (
      entryStmt.all(s.id, profileId) as {
        test_key: string;
        tier: FitnessTier;
        store: "set" | "vital" | "body";
        value: number;
        unit: string;
        raw_input: string | null;
      }[]
    ).map((r) => ({
      testKey: r.test_key,
      tier: r.tier,
      store: r.store,
      value: r.value,
      unit: r.unit,
      rawInput: r.raw_input != null ? safeParse(r.raw_input) : null,
    })),
  }));
}

// The date of a profile's most recent fitness check, or null when they've never done one.
// The retest-cadence finding reads this.
export function getLatestFitnessAssessmentDate(
  profileId: number
): string | null {
  const row = db
    .prepare(
      "SELECT date FROM fitness_assessments WHERE profile_id = ? ORDER BY date DESC, id DESC LIMIT 1"
    )
    .get(profileId) as { date: string } | undefined;
  return row?.date ?? null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Ambient natural-store read-back (#1129) ─────────────────────────────────────────
//
// The check writes every value THROUGH to its natural store; this reads the LATEST reading
// back OUT of each store so a synced/logged value auto-counts as measured (the resolver in
// buildFitnessCheckModel then picks newest-wins across this + the session ledger, tagging
// provenance). Every query is profile-scoped. Returns one AmbientReading per battery test
// that has a stored reading; absent tests are simply omitted.

interface SetRow {
  date: string;
  source: string | null;
  weight_kg: number | null;
  reps: number | null;
  duration_sec: number | null;
}

// Non-warmup sets (newest first) for the merged-history preimage of a lift — the finite
// LOWER(TRIM(exercise)) IN (...) realization of exerciseHistoryKey (#394/#432), scoped by
// profile through the activities join.
function latestSetRows(profileId: number, lift: string): SetRow[] {
  const names = exerciseHistoryNames(lift);
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT a.date AS date, a.source AS source,
              s.weight_kg AS weight_kg, s.reps AS reps, s.duration_sec AS duration_sec
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.warmup = 0
          AND LOWER(TRIM(s.exercise)) IN (${placeholders})
        ORDER BY a.date DESC, a.id DESC`
    )
    .all(profileId, ...names) as SetRow[];
}

// The best value on the NEWEST session date among a lift's recent sets, per reducer. "Best
// recent" = the max on the most recent day the lift was logged.
function newestSetStat(
  rows: SetRow[],
  reduce: (r: SetRow) => number | null
): { value: number; date: string; source: string | null } | null {
  if (rows.length === 0) return null;
  const newestDate = rows[0].date;
  let best: number | null = null;
  let source: string | null = null;
  for (const r of rows) {
    if (r.date !== newestDate) break; // rows are date DESC
    const v = reduce(r);
    if (v == null || !Number.isFinite(v)) continue;
    if (best == null || v > best) {
      best = v;
      source = r.source;
    }
  }
  if (best == null) return null;
  return { value: best, date: newestDate, source };
}

// The latest non-null body_metrics reading for a column, newest-wins, with its source.
function latestBodyReading(
  profileId: number,
  column: "body_fat_pct" | "resting_hr"
): { value: number; date: string; source: string | null } | null {
  const row = db
    .prepare(
      `SELECT ${column} AS value, date, source FROM body_metrics
        WHERE profile_id = ? AND ${column} IS NOT NULL
        ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId) as
    | { value: number; date: string; source: string | null }
    | undefined;
  return row ?? null;
}

// The latest ambient reading per battery test (see the header). One resolver, three pipes —
// the exact stores the check writes through.
export function getAmbientFitnessReadings(
  profileId: number,
  battery: FitnessTestDef[]
): AmbientReading[] {
  const out: AmbientReading[] = [];
  for (const def of battery) {
    const store = def.store;
    if (store.kind === "vital") {
      // Newest reading of the marker's #482 FAMILY (getBiomarkerSeries collapses synonyms
      // + dedups), oldest-first → the last row is newest.
      const series = getBiomarkerSeries(profileId, store.canonical);
      const last = series[series.length - 1];
      if (last && last.value_num != null) {
        out.push({
          testKey: def.key,
          value: last.value_num,
          date: last.date,
          source: last.source ?? null,
        });
      }
    } else if (store.kind === "body") {
      const r = latestBodyReading(profileId, store.column);
      if (r) {
        out.push({
          testKey: def.key,
          value: r.value,
          date: r.date,
          source: r.source,
        });
      }
    } else {
      // set store.
      if (def.key === "biglift") {
        // The big lift is user-chosen; scan the standard barbell lifts for the newest heavy
        // set and reduce to e1RM (tie on date → the stronger e1RM).
        let pick:
          | { value: number; date: string; source: string | null; lift: string }
          | null = null;
        for (const lift of BIG_LIFT_OPTIONS) {
          const stat = newestSetStat(latestSetRows(profileId, lift), (r) =>
            r.weight_kg != null && r.reps != null && r.weight_kg > 0 && r.reps > 0
              ? estimate1RM(r.weight_kg, r.reps)
              : null
          );
          if (!stat) continue;
          if (
            !pick ||
            stat.date > pick.date ||
            (stat.date === pick.date && stat.value > pick.value)
          ) {
            pick = { ...stat, lift };
          }
        }
        if (pick) {
          out.push({
            testKey: def.key,
            value: Math.round(pick.value * 100) / 100,
            date: pick.date,
            source: pick.source,
            liftName: pick.lift,
          });
        }
      } else {
        const reduce =
          store.timed === true
            ? (r: SetRow) => r.duration_sec
            : (r: SetRow) => r.reps;
        const stat = newestSetStat(latestSetRows(profileId, store.lift), reduce);
        if (stat) {
          out.push({
            testKey: def.key,
            value: stat.value,
            date: stat.date,
            source: stat.source,
          });
        }
      }
    }
  }
  return out;
}
