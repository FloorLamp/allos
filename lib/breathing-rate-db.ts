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
import { boundedOrNull } from "@/lib/ingest-bounds";
import {
  blockingInboundLinks,
  parentIdsNamedBy,
  type BlockingInboundLink,
} from "@/lib/migrations/cascade-delete";
import { BREATHING_RATE_FOLLOWUP_KIND } from "@/lib/followup-breathing-rate";
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
// -- IT MOVES A NIGHT ONLY WHEN THE MOVE CARRIES EVERYTHING THE NIGHT HAS -----------
//
// A reading can have more on it than its number, and there are exactly two kinds of
// more: a row another table still POINTS AT, and a row with a correction LINEAGE
// hanging off it. The rule for both is the same, and the unit is the NIGHT, not the
// row, because the night is an ELECTION: its rows are ranked and one of them becomes
// the number. Deciding row by row inside an election set silently changes which row
// wins - drop the final re-stamp from the candidate set and the superseded provisional
// it replaced is elected in its place, and the night is then stated WRONG on three
// surfaces while the correct reading sits in `medical_records`. That is a defect this
// file shipped with, reproduced from the clause that used to live in the candidate
// query, and moving the decision to the night is what closes it.
//
// WHAT CAN BE CARRIED IS CARRIED (the owner's 2026-09-11 ruling names "carried or
// kept", carried first). A person who tapped "Track follow-up" on a night's reading has
// a `care_plan_items` row naming it. `care_plan_items` gained a
// `source_metric_sample_id` / `resolved_by_metric_sample_id` pair
// (20260916-care-plan-metric-sample-links) - its FIFTH source kind, on the shape its
// other four already use - so the reference MOVES onto the night's sample with the
// reading, and the person's "Recheck breathing rate" still points at the reading it was
// about. `CARRIED_LINKS` below declares that policy BESIDE the code that performs it.
//
// WHAT CANNOT BE CARRIED DECLINES THE NIGHT, AND SAYS SO. Two things reach this:
//
//   • A BLOCKING INBOUND LINK WITH NO CARRYING DESTINATION. The links are not
//     surveyed by hand - `blockingInboundLinks` (lib/migrations/cascade-delete.ts)
//     reads every `NO ACTION` / `RESTRICT` / `SET DEFAULT` reference to
//     `medical_records` out of `PRAGMA foreign_key_list` at the moment of the run, and
//     `parentIdsNamedBy` probes the whole delete-set with ONE set query per link. A
//     hand survey of exactly these links is what failed twice on this branch. A link
//     this file does not know how to carry holds its night back whether or not anyone
//     remembered it existed, and a link added after this file was written is included
//     in the answer without an edit here.
//   • A #1404 CORRECTION LINEAGE. `upsertVitals` writes a `medical_record_revisions`
//     row whenever a re-send supersedes a stored value, and Health Connect re-sends a
//     rolling 48-hour window. Those rows cascade on `medical_records(id)`: inside the
//     migration (`foreign_keys = OFF`) a delete ORPHANS them, at runtime it DESTROYS
//     them, and `metric_samples` has no revision child for them to travel to. This is
//     the "kept" branch of the ruling, because "carried" is genuinely unavailable.
//
// A declined night is left EXACTLY as it was - no sample, no removal, nothing counted -
// and it is REPORTED: `declined` names the link (or the lineage) and how many nights
// and rows it held, the migration logs it, and the ingest writes it to
// `integration_sync_events`. A posture nobody can see is not a posture; under the
// refuse-by-default design this round rejected, `PRAGMA foreign_key_check` came back
// clean, the boot warning fired on nothing and the runtime logged only on error, which
// is strictly MORE silent than the dangling reference it replaced.
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
  /** 1 when a #1404 correction lineage hangs off this row. */
  has_revision: number;
}

/** Why a night was left in `medical_records`, and how much of it. */
export interface BreathingRateDecline {
  /**
   * The link that held it, as `table.column`, or `medical_record_revisions` for a
   * correction lineage - the thing to name in a log line or a sync event.
   */
  held_by: string;
  /** Nights left where they were. */
  nights: number;
  /** Observation rows in those nights. */
  rows: number;
}

export interface BreathingRateAdoption {
  /** Nightly samples written (a night that already had one is not counted). */
  adopted: number;
  /** Observation rows removed from `medical_records`. */
  removed: number;
  /** Follow-up references moved from the removed rows onto the night's sample. */
  carried: number;
  /** The nights this run declined to move, by what held each back. */
  declined: BreathingRateDecline[];
}

/**
 * The blocking inbound links to `medical_records` this adoption knows how to CARRY,
 * and where each one lands.
 *
 * Declared here, beside the UPDATE that performs it, and consulted against the links
 * the schema actually has: the enumeration is computed, only the RESOLUTION is
 * declared. A blocking link absent from this map is not assumed harmless - it declines
 * the nights it names, which is what makes "we forgot one" a visible outcome instead
 * of a dangling reference.
 *
 * `source` additionally re-stamps `source_kind`, because the discriminator names the
 * kind of thing the source IS and it stops being a medical record; the resolving link
 * carries alone, as migration 184's repair of the same pair does.
 */
const CARRIED_LINKS: Readonly<
  Record<string, { column: string; restampsKind: boolean }>
> = {
  "care_plan_items.source_medical_record_id": {
    column: "source_metric_sample_id",
    restampsKind: true,
  },
  "care_plan_items.resolved_by_medical_record_id": {
    column: "resolved_by_metric_sample_id",
    restampsKind: false,
  },
};

const linkName = (link: BlockingInboundLink): string =>
  `${link.table}.${link.columns.join("+")}`;

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
      `SELECT id, profile_id, source, date, occurred_at, value_num, edited,
              -- A #1404 CORRECTION LINEAGE IS A PROPERTY OF THE ROW, READ WITH IT, and
              -- deliberately not a filter: a candidate dropped before the election
              -- changes which row wins it. The night it belongs to is declined below,
              -- whole, after the ranking has seen every row in it.
              EXISTS (
                SELECT 1 FROM medical_record_revisions rev
                 WHERE rev.record_id = medical_records.id
              ) AS has_revision
         FROM medical_records
        WHERE canonical_name = ?
          AND value_num IS NOT NULL
          AND source IN (${placeholders})
          ${profileId == null ? "" : "AND profile_id = ?"}
        ORDER BY profile_id, id`
    )
    .all(
      CLINICAL_RESPIRATORY_CANONICAL,
      ...WEARABLE_RESPIRATORY_SOURCES,
      ...(profileId == null ? [] : [profileId])
    ) as Candidate[];
  if (candidates.length === 0)
    return { adopted: 0, removed: 0, carried: 0, declined: [] };

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

  // ---- WHAT HOLDS A NIGHT BACK, READ FROM THE SCHEMA AND PROBED IN ONE QUERY ----
  //
  // The delete-set is every candidate row, so the probe is per LINK, never per id and
  // never chunked (`parentIdsNamedBy` carries the measured numbers). The links are
  // whatever `PRAGMA foreign_key_list` says they are right now, which inside the
  // migration is the graph as of this migration's position in the sequence.
  const candidateIds = candidates.map((row) => row.id);
  const carriedLinks: BlockingInboundLink[] = [];
  const heldBy = new Map<number, string>();
  for (const link of blockingInboundLinks(handle, "medical_records")) {
    const name = linkName(link);
    if (CARRIED_LINKS[name]) {
      carriedLinks.push(link);
      continue;
    }
    const named = parentIdsNamedBy(handle, link, candidateIds);
    // A link the probe cannot express (a composite key, a reference to something other
    // than the row key) holds EVERY night rather than none: the fail-closed direction
    // is the one that leaves data where it is and says which link did it.
    for (const id of named ?? candidateIds)
      if (!heldBy.has(id)) heldBy.set(id, name);
  }

  // The carry itself, one statement per carried link, profile-scoped like every write
  // in this file. The doomed ids are the night's - a link on a row that STAYS keeps
  // pointing at the row it always did - so this one is per night rather than per set:
  // each night's reference lands on ITS OWN sample id, which is what carrying means.
  // The table and column come from the pragma walk, never from input.
  const carryStatements = carriedLinks.map((link) => {
    const carry = CARRIED_LINKS[linkName(link)];
    const column = link.columns[0];
    return (sampleId: number, profileId: number, ids: number[]): number =>
      ids.length === 0
        ? 0
        : Number(
            handle
              .prepare(
                `UPDATE ${link.table}
                    SET ${carry.column} = ?, ${column} = NULL
                        ${carry.restampsKind ? ", source_kind = ?" : ""}
                  WHERE profile_id = ?
                    AND ${column} IN (${ids.map(() => "?").join(",")})`
              )
              .run(
                sampleId,
                ...(carry.restampsKind ? [BREATHING_RATE_FOLLOWUP_KIND] : []),
                profileId,
                ...ids
              ).changes
          );
  });

  let adopted = 0;
  let removed = 0;
  let carried = 0;
  const declined = new Map<string, BreathingRateDecline>();
  const decline = (held_by: string, rows: number): void => {
    const at = declined.get(held_by) ?? { held_by, nights: 0, rows: 0 };
    at.nights += 1;
    at.rows += rows;
    declined.set(held_by, at);
  };
  /** One decline entry per REASON per night, however many rows carried that reason. */
  const declineRows = (
    rows: readonly (readonly [Candidate, string])[]
  ): void => {
    const perReason = new Map<string, number>();
    for (const [, reason] of rows)
      perReason.set(reason, (perReason.get(reason) ?? 0) + 1);
    for (const [reason, n] of perReason) decline(reason, n);
  };
  for (const target of targets.values()) {
    // WHAT THIS NIGHT CANNOT MOVE, and what that costs depends on whether the night is
    // about to be ELECTED. A row is unmovable when a blocking link names it or a #1404
    // lineage hangs off it.
    const heldReason = (row: Candidate): string | null =>
      heldBy.get(row.id) ??
      (row.has_revision === 1 ? "medical_record_revisions" : null);
    const held = target.rows
      .map((row) => [row, heldReason(row)] as const)
      .filter((pair): pair is readonly [Candidate, string] => pair[1] != null);
    const already = readSample.get(
      target.profileId,
      BREATHING_RATE_METRIC,
      target.source,
      target.origin,
      target.startedAt
    ) as { id: number } | undefined;
    // THE ELECTION IS THE UNIT. Where the night has no sample yet, its rows are RANKED
    // and one of them becomes the number - so an unmovable row cannot simply be left
    // out: dropping the final re-stamp from the set elects the superseded provisional
    // it replaced, and the night is then stated wrong on every surface while the right
    // reading sits in `medical_records`. The whole night declines instead, untouched,
    // and says which link held it. Where the night ALREADY states its own number
    // nothing is elected, so the unmovable rows stay and the rest still leave.
    if (held.length > 0 && !already) {
      decline(held[0][1], target.rows.length);
      continue;
    }
    declineRows(held);
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
    // THE NUMBER THE NIGHT WOULD STATE, BOUNDED. `medical_records` is not a bounded
    // store on every path into it: the parsers write through `boundedOrNull`, but the
    // record editor takes a hand-typed value verbatim and stamps `edited = 1` - and a
    // locked row is elected AHEAD of the vendor's own stamp, so a mistyped "0" on a
    // wearable reading is precisely the value that arrives here. `metric_samples` IS a
    // bounded store, the hero and the chart state whatever they find, and
    // `formatBreathingRate(0)` renders a truthy "0 br/min". So the move applies the
    // same 3-80 envelope the ingest applies (`respiratory_rate_bpm`, ingest-bounds) and
    // a night whose elected reading falls outside it DECLINES rather than publishing an
    // impossible one. The row keeps its number where it is: nothing is corrected on the
    // person's behalf, and the decline is reported like every other.
    const value = boundedOrNull(BREATHING_RATE_METRIC, latest.value_num);
    const insertNight = (night: number): number => {
      const written = insertSample.run(
        target.profileId,
        target.source,
        target.origin,
        BREATHING_RATE_METRIC,
        target.date,
        target.startedAt,
        target.endedAt,
        night,
        // The #133 lock travels with the reading it is ON: a hand-corrected observation
        // must not be re-clobbered by the next push now that it lives in the other
        // store. It is read off the ELECTED row, never off the night, so the lock can
        // never land on a value no one edited.
        isEditLocked(latest.edited) ? 1 : 0
      );
      adopted++;
      return Number(written.lastInsertRowid);
    };
    const sampleId = already?.id ?? (value == null ? null : insertNight(value));
    if (sampleId == null) {
      decline("out-of-bounds value", target.rows.length);
      continue;
    }
    // WHAT MAY LEAVE `medical_records`. An unlocked row is superseded by the night's
    // sample either way. A LOCKED row leaves only when the value just written is its
    // own - so a night that already held a sample drops no locked row at all, and a
    // night with two locked rows keeps the one it did not adopt.
    const doomed = target.rows.filter(
      (row) =>
        heldReason(row) == null &&
        (!isEditLocked(row.edited) || (!already && row.id === latest.id))
    );
    // THE REFERENCE MOVES FIRST, and to the row the night now states. At runtime this
    // is what keeps the delete below from raising SQLITE_CONSTRAINT_FOREIGNKEY inside
    // somebody else's push; in the migration, where keys are off, it is what keeps the
    // reference from dangling. One order, both postures.
    const doomedIds = doomed.map((row) => row.id);
    for (const carry of carryStatements)
      carried += carry(sampleId, target.profileId, doomedIds);
    remove(doomed.map((row) => ({ id: row.id, profileId: row.profile_id })));
    removed += doomed.length;
  }
  return { adopted, removed, carried, declined: [...declined.values()] };
}
