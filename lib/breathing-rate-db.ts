import type { SqlPrepare } from "@/lib/write-revision";
import {
  BREATHING_RATE_METRIC,
  CLINICAL_RESPIRATORY_CANONICAL,
  WEARABLE_RESPIRATORY_SOURCES,
  breathingRateDayWindow,
  mainSessionForDay,
  sessionForStamp,
  type BreathingRateSession,
} from "@/lib/breathing-rate";
import { roundForMetric } from "@/lib/ingest-bounds";
import { isEditLocked } from "@/lib/integrations/sync-log";
import { parseUtcSql } from "@/lib/date";

// ADOPTION: A WEARABLE READING JOINS THE NIGHT IT SUMMARIZES (issue #5409), store half.
//
// WHAT IT IS FOR. The parsers route a wearable breathing rate to `metric_samples` when
// the payload they are reading already carries the sleep session. It does not always:
// Fitbit publishes the reading stamped at the sleep log's CURRENT end, and the first
// publication of a night routinely lands before Health Connect has the session at all.
// That reading is a spot observation when it arrives - honestly, because nothing then
// said it was a night's - and this is what moves it into the night when the session
// lands. The owner's ruling is one sentence: "when a session lands or extends,
// same-origin readings inside it are adopted into the night".
//
// ONE FUNCTION, TWO CALLERS, AND THAT IS THE DESIGN. The ingest runs it after every
// Health Connect push and every Takeout import; the #5409 migration runs it once over
// all of history. The migration IS the adoption run over history - it is not a second
// rule that has to be kept in step with this one.
//
// -- THE SOURCE DECIDES, NOT THE ANALYTE NAME --------------------------------------
//
// The candidate set is `canonical_name = 'Respiratory Rate'` AND a wearable `source`.
// A nurse's count at a visit (`manual`), a document's (`document:<id>`) and a legacy
// NULL-source row are not candidates and are never read, moved, collapsed or deleted.
// That is the whole discrimination and it is one SQL clause; the db-tier test pins a
// clinical row of the same analyte, on the same night, surviving untouched.
//
// -- IT FILLS, IT NEVER OVERWRITES -------------------------------------------------
//
// A night that already holds a `respiratory_rate_bpm` row keeps its VALUE; the stale
// observations on it are removed - all but the ones the next section holds back - and
// nothing else happens. That is not caution, it is the ranking: an observation is left
// over exactly when no session contained its stamp
// at the time, and the session's own re-published reading is stamped at the session's
// END - at or after every stamp that could still be sitting in `medical_records` for
// it. Preferring the observation would replace a final reading with the provisional one
// it superseded. Where the night holds NO row yet, the LATEST observation stamp wins,
// which is the same ranking read the other way.
//
// -- IT MOVES A ROW ONLY WHEN THE MOVE CARRIES EVERYTHING THE ROW HAS ---------------
//
// This is the rule the falsifying pass on PR #5880 bought, and the two clauses below
// are the two ways a row can have more on it than its number.
//
// A ROW WITH A CORRECTION LINEAGE IS NEVER READ AND NEVER REMOVED. `upsertVitals`
// writes a `medical_record_revisions` row (#1404) whenever a re-send supersedes a
// stored value, and Health Connect re-sends a rolling 48-hour window, so a corrected
// rate on the SAME stamp is exactly that. Those rows cascade on `medical_records(id)`:
// inside the migration, where `runner.ts` applies with `foreign_keys = OFF`, a bare
// delete ORPHANS them; at runtime, with keys on, it DESTROYS them. `metric_samples` has
// no revision child, so the lineage cannot travel with the reading - and a move that
// cannot carry it is not a move, it is a loss. The `NOT EXISTS` clause below therefore
// holds such a row out of the candidate set entirely: it is not counted, not elected,
// not adopted and not deleted, and the night keeps stating it where it always did. The
// cost is real and named: a night whose reading was corrected in place keeps its row in
// the vitals fold, which is the duplication #5409 is about. Carrying the lineage into
// the stream store instead would need a `metric_sample_revisions` child table, which is
// a schema question this round does not answer.
//
// A HAND-CORRECTED ROW LEAVES `medical_records` ONLY WHEN THE NIGHT STATES ITS OWN
// NUMBER. `upsertVitals` refuses to clobber an `edited = 1` row and this must not be
// the one path that does, so the #133 lock is read on BOTH branches, not just the
// insert: where a night carries a locked row the locked rows are the election's
// candidates (a person's correction outranks the vendor's later re-stamp, which is the
// whole content of the lock), the sample takes that value WITH `edited = 1`, and every
// other locked row on the night stays where it is. Where the night already holds a
// sample nothing is adopted at all, so no locked row is removed - the correction and
// its note survive as the observation they are.
//
// -- WHAT IS NOT DONE HERE, stated because a barrier nobody implemented is worse than
// no barrier: NO IMPORT TOMBSTONE IS WRITTEN for a removed observation. Nothing needs
// one - Health Connect holds one respiratory record per sleep log and re-stamps it in
// place, so the earlier stamp no longer exists to be re-sent, and a stamp that DOES
// arrive again arrives with its 48-hour session and becomes the night's sample rather
// than an observation. If a source ever re-published a stamp with no session behind it,
// this would re-adopt it on the next run rather than refuse it.

/** One stored wearable observation, in the columns the adoption reads. */
interface Candidate {
  id: number;
  profile_id: number;
  source: string;
  date: string;
  occurred_at: string | null;
  value_num: number;
  edited: number | null;
}

export interface BreathingRateAdoption {
  /** Nightly samples written (a night that already had one is not counted). */
  adopted: number;
  /** Observation rows removed from `medical_records`. */
  removed: number;
}

/**
 * How a caller takes the adopted observations out of `medical_records`.
 *
 * THE TWO CALLERS RUN UNDER DIFFERENT FOREIGN-KEY POSTURES, and that is the one place
 * they genuinely differ. At runtime keys are ON and SQLite performs a parent row's
 * cascades itself; inside a migration `runner.ts` applies with `foreign_keys = OFF`
 * (issue #95, for safe table rebuilds), so a bare delete fires no action at all and
 * leaves whatever pointed at the row behind as a dangling reference. The migration
 * therefore hands in `deleteRowsWithCascade` (lib/migrations/cascade-delete.ts), which
 * is what makes its delete match the runtime one - and is what
 * `migration-child-links.test.ts` asks a row-deleting migration for.
 *
 * Each row carries its `profileId` beside its `id` because the runtime delete stays
 * profile-scoped (lib/__tests__/profile-scoping.test.ts holds every owned-table
 * statement to that, and `id` alone would pass authorization by luck rather than by
 * predicate). `deleteRowsWithCascade` takes ids, so the migration drops the column
 * there - it runs over every profile by design and has no request to be scoped to.
 */
export type BreathingRateObservationRemover = (
  rows: readonly { id: number; profileId: number }[]
) => void;

/**
 * The window a wearable reading takes, and the night it names when there is one.
 *
 * `night` is null for a day-labelled reading whose wake day holds no stored session:
 * it still leaves `medical_records` (a Takeout day row is never an observation, per the
 * ruling) and takes the day-bucket window the Takeout parser itself writes, so a
 * re-import of the archive lands on this row rather than beside it.
 */
interface Placement {
  night: BreathingRateSession | null;
  startedAt: string;
  endedAt: string;
  date: string;
}

/**
 * Move every wearable `Respiratory Rate` observation that belongs to a night onto that
 * night's `respiratory_rate_bpm` row, collapsing each night to its latest stamp.
 *
 * `profileId` narrows it to one profile (the ingest path); omitted, it runs over every
 * profile (the migration). `removeObservations` takes the adopted rows out - see
 * `BreathingRateObservationRemover` for why the caller supplies it.
 */
export function adoptWearableBreathingRates(
  // `SqlPrepare`, the narrowest thing this needs, so BOTH callers pass their own handle
  // unchanged: the ingest hands it the request-tracked `db`, and the #5409 migration
  // hands it the raw better-sqlite3 connection the runner opens.
  handle: SqlPrepare,
  profileId?: number,
  removeObservations?: BreathingRateObservationRemover
): BreathingRateAdoption {
  const placeholders = WEARABLE_RESPIRATORY_SOURCES.map(() => "?").join(",");
  const candidates = handle
    .prepare(
      `SELECT id, profile_id, source, date, occurred_at, value_num, edited
         FROM medical_records
        WHERE canonical_name = ?
          AND value_num IS NOT NULL
          AND source IN (${placeholders})
          -- A ROW WITH A #1404 CORRECTION LINEAGE IS NOT A CANDIDATE. See the header:
          -- medical_record_revisions cascades on this row and cannot follow it into
          -- metric_samples, so the row is left alone rather than moved without it.
          AND NOT EXISTS (
                SELECT 1 FROM medical_record_revisions rev
                 WHERE rev.record_id = medical_records.id
              )
          ${profileId == null ? "" : "AND profile_id = ?"}
        ORDER BY profile_id, id`
    )
    .all(
      CLINICAL_RESPIRATORY_CANONICAL,
      ...WEARABLE_RESPIRATORY_SOURCES,
      ...(profileId == null ? [] : [profileId])
    ) as Candidate[];
  if (candidates.length === 0) return { adopted: 0, removed: 0 };

  const readSessions = handle.prepare(
    `SELECT source, origin, date, started_at, ended_at
       FROM metric_samples
      WHERE profile_id = ? AND metric = 'sleep_min'`
  );
  // THE NATURAL KEY, IN FULL, ORIGIN INCLUDED. `idx_metric_samples_natural` is
  // (profile_id, metric, source, COALESCE(origin, ''), start_time) and the ingest's own
  // twin lookup (`metricSampleVetoes`) reads all five. A four-column read here answers
  // "this night is taken" for a row belonging to ANOTHER writing package at the same
  // start - the adoption then wrote nothing and removed the observation anyway, which
  // is a reading deleted and not replaced.
  const readSample = handle.prepare(
    `SELECT id FROM metric_samples
      WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ?
        AND started_at = ?
      LIMIT 1`
  );
  const insertSample = handle.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, started_at, ended_at, value, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // THE RUNTIME REMOVAL, and only the runtime one. Foreign keys are ON outside the
  // migration runner, so a deleted parent's cascades fire here; a caller applying with
  // keys OFF must hand in its own remover instead (the #5409 migration does).
  const dropObservation = handle.prepare(
    "DELETE FROM medical_records WHERE id = ? AND profile_id = ?"
  );
  const remove: BreathingRateObservationRemover =
    removeObservations ??
    ((rows) => {
      for (const row of rows) dropObservation.run(row.id, row.profileId);
    });

  interface Target {
    profileId: number;
    source: string;
    origin: string | null;
    date: string;
    startedAt: string;
    endedAt: string;
    rows: Candidate[];
  }
  const targets = new Map<string, Target>();
  const sessionsBySource = new Map<string, BreathingRateSession[]>();

  const sessionsFor = (row: Candidate): BreathingRateSession[] => {
    const key = `${row.profile_id} ${row.source}`;
    const cached = sessionsBySource.get(key);
    if (cached) return cached;
    // ONE SOURCE'S SESSIONS ONLY. A Takeout reading must not be adopted into a Health
    // Connect session: it would be filed under a window the archive never stated and
    // under a key its own re-import could not find again.
    const sessions = (
      readSessions.all(row.profile_id) as {
        source: string;
        origin: string | null;
        date: string;
        started_at: string;
        ended_at: string;
      }[]
    ).flatMap((s) => {
      if (s.source !== row.source) return [];
      // parseUtcSql, not the typed seam: `metric_samples.started_at`/`ended_at` carry no
      // brand, and the shape expected is a synced session's own instant - `Z`, an
      // offset, or no suffix read as UTC (the same read `sleep-overlap-db` makes).
      const startMs = parseUtcSql(s.started_at)?.getTime() ?? NaN;
      const endMs = parseUtcSql(s.ended_at)?.getTime() ?? NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
      return [
        {
          startedAt: s.started_at,
          endedAt: s.ended_at,
          startMs,
          endMs,
          wakeDay: s.date,
          origin: s.origin,
        },
      ];
    });
    sessionsBySource.set(key, sessions);
    return sessions;
  };

  const placementOf = (row: Candidate): Placement | null => {
    const sessions = sessionsFor(row);
    // `medical_records.occurred_at` is unbranded too; a pre-#2154 row stores NULL and a
    // written one is canonical UTC, so the same tolerant read applies.
    const stampMs = parseUtcSql(row.occurred_at)?.getTime() ?? NaN;
    let night: BreathingRateSession | undefined;
    if (Number.isFinite(stampMs)) {
      // A REAL INSTANT: containment, the same test the parser applies. The stored
      // observation carries no `origin` column of its own - `medical_records` has none -
      // so every origin this source recorded is a candidate and the longest containing
      // session wins, which is the same election the parser's same-origin match makes
      // when a nap nests inside a night.
      for (const s of sessions) {
        const hit = sessionForStamp(stampMs, s.origin, [s]);
        if (!hit) continue;
        if (!night || hit.endMs - hit.startMs > night.endMs - night.startMs)
          night = hit;
      }
    }
    // A DAY LABEL (Fitbit Takeout states no instant, #2154): the wake day's MAIN
    // session. Never a clock - the label is a day, and that day's main session is the
    // only window in the store the label names.
    if (!night && row.occurred_at == null)
      night = mainSessionForDay(row.date, sessions);
    if (night)
      return {
        night,
        startedAt: night.startedAt,
        endedAt: night.endedAt,
        date: night.wakeDay,
      };
    if (row.occurred_at == null)
      return {
        night: null,
        ...breathingRateDayWindow(row.date),
        date: row.date,
      };
    // A wearable SPOT reading - a stamped instant with no session around it. It stays
    // an observation, which is exactly where the parser leaves one today.
    return null;
  };

  for (const row of candidates) {
    const placement = placementOf(row);
    if (!placement) continue;
    const key = `${row.profile_id} ${row.source} ${placement.startedAt}`;
    const existing = targets.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    targets.set(key, {
      profileId: row.profile_id,
      source: row.source,
      origin: placement.night?.origin ?? null,
      date: placement.date,
      startedAt: placement.startedAt,
      endedAt: placement.endedAt,
      rows: [row],
    });
  }

  let adopted = 0;
  let removed = 0;
  for (const target of targets.values()) {
    // THE #133 LOCK ELECTS BEFORE THE STAMP DOES. A locked row is a person's own
    // statement about this night, and `upsertVitals` refuses to let any re-send
    // overwrite it; ranking the vendor's later re-stamp above it would write a number
    // nobody edited AND carry the lock onto it, which is the worst of both.
    const locked = target.rows.filter((row) => isEditLocked(row.edited));
    const electable = locked.length > 0 ? locked : target.rows;
    // THE NIGHT'S LATEST STAMP. `occurred_at` first - it is the reading's own instant -
    // and the row id only to break a tie between two rows stating the same stamp or
    // none, where the later-written row is the later-published one.
    const latest = electable.reduce((best, row) =>
      (row.occurred_at ?? "") > (best.occurred_at ?? "") ||
      ((row.occurred_at ?? "") === (best.occurred_at ?? "") && row.id > best.id)
        ? row
        : best
    );
    const already = readSample.get(
      target.profileId,
      BREATHING_RATE_METRIC,
      target.source,
      target.origin,
      target.startedAt
    ) as { id: number } | undefined;
    if (!already) {
      insertSample.run(
        target.profileId,
        target.source,
        target.origin,
        BREATHING_RATE_METRIC,
        target.date,
        target.startedAt,
        target.endedAt,
        roundForMetric(BREATHING_RATE_METRIC, latest.value_num),
        // The #133 lock travels with the reading it is ON: a hand-corrected observation
        // must not be re-clobbered by the next push now that it lives in the other
        // store. It is read off the ELECTED row, never off the night, so the lock can
        // never land on a value no one edited.
        isEditLocked(latest.edited) ? 1 : 0
      );
      adopted++;
    }
    // WHAT MAY LEAVE `medical_records`. An unlocked row is superseded by the night's
    // sample either way. A LOCKED row leaves only when the value just written is its
    // own - so a night that already held a sample drops no locked row at all, and a
    // night with two locked rows keeps the one it did not adopt.
    const doomed = target.rows.filter(
      (row) => !isEditLocked(row.edited) || (!already && row.id === latest.id)
    );
    remove(doomed.map((row) => ({ id: row.id, profileId: row.profile_id })));
    removed += doomed.length;
  }
  return { adopted, removed };
}
