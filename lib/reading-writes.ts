// THE READING WRITE CORE (#2032, phase 2 of #1997).
//
// One core executes the placement decision that `lib/reading-placement.ts` states, and
// one contract edits and deletes a reading by the row it IS rather than by the surface
// that is showing it. Surfaces stop naming a table.
//
// AUTH-BLIND, `profileId` FIRST, no `lib/auth` import — the Server Actions in
// `app/(app)/trends/reading-actions.ts` (and every future caller) own the write gate,
// the validation and the unit conversion. Every statement filters on `profile_id`, so a
// row id belonging to another profile is a `not-found` no-op rather than a cross-profile
// write.
//
// IT SITS ON THE OBSERVATION SUBSTRATE, NOT BESIDE IT (#944):
//   • the #133 edit lock is read ONLY through `isEditLocked`, and it holds out a
//     SOURCE-OWNED re-push — never the user's own correction (see `recordReading`);
//   • the inserted/updated/unchanged split is classified by `classifyUpsert` and bumped
//     ONLY by `tallyUpsert`;
//   • deletes go through `captureDelete`, which writes the #507/#508 re-import
//     tombstone AND makes the delete undoable — one path, not two (#2123).
//
// NO SCHEMA CHANGE, and `medical_records` stays the clinical record: writes ROUTE to it,
// nothing here restructures it. Phase 3 (the physical merge) is a separate, later
// decision.

import { db, writeTx } from "./db";
import {
  classifyUpsert,
  isEditLocked,
  tallyUpsert,
  type UpsertCounts,
  type UpsertDisposition,
} from "./integrations/sync-log";
import { captureDelete } from "./undo-delete-db";
import { addCanonicalNames, reconcileFlags } from "./queries";
import { placeReading, type ReadingTarget } from "./reading-placement";
import { readingSourceFor, type ReadingProvenance } from "./reading-model";
import { judgeStatedAt, type StatedTimeRefusal } from "./stated-time";
import { utcInstant } from "./date";
import { now } from "./clock";
import { getTimezone } from "./settings";
import type { MedicalCategory } from "./types";
import type { BodyMetricColumn } from "./metric-readings";
import type { Kg, Km } from "./units";

// ---- body_metrics statements ----------------------------------------------
//
// body_metrics is the one store whose COLUMN varies by reading, and interpolating it
// into the SQL would make statements the profile-scoping scanner cannot read (it
// verifies `profile_id` in LITERAL prepare() text). So each column gets its own literal
// statement, switched here — the same deliberate verbosity the read layer keeps.

// The #133 lock is only meaningful on a SOURCE-OWNED row (the keyed upsert dedups on
// (date, source)); a manual row has no source to be re-pushed from, so its flag is left
// alone — the same CASE the medical record editor uses.
function bodyMetricUpdate(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics
            SET weight_kg = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND weight_kg IS NOT NULL`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics
            SET body_fat_pct = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND body_fat_pct IS NOT NULL`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics
            SET resting_hr = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND resting_hr IS NOT NULL`
      );
  }
}

// Clear ONE measure off a shared row (see deleteReadingAt).
function bodyMetricClear(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics SET weight_kg = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics SET body_fat_pct = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics SET resting_hr = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
  }
}

// Insert the day's row carrying ONE measure. The other two columns are left NULL —
// body_metrics is wide, and a reading of one quantity says nothing about the others.
// `occurred_at` is bound (never defaulted, never SQL's clock — the #2205 canonical
// convention): the stated instant when the sitting named one, NULL otherwise.
function bodyMetricInsert(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `INSERT INTO body_metrics (date, weight_kg, source, occurred_at, profile_id) VALUES (?, ?, ?, ?, ?)`
      );
    case "body_fat_pct":
      return db.prepare(
        `INSERT INTO body_metrics (date, body_fat_pct, source, occurred_at, profile_id) VALUES (?, ?, ?, ?, ?)`
      );
    case "resting_hr":
      return db.prepare(
        `INSERT INTO body_metrics (date, resting_hr, source, occurred_at, profile_id) VALUES (?, ?, ?, ?, ?)`
      );
  }
}

// ---- The stated occurred_at (#2235, decisions 4–6) -------------------------
//
// `body_metrics.occurred_at` records WHEN the day's reading was taken — a statement
// somebody actually made, never a record stamp (the table has none to launder from).
// Three-way input contract, shared by every body-metrics writer:
//
//   • `undefined` — the caller says nothing about time. An insert stores NULL
//     (honest absence, decision 2's NULL-never-midnight rule) and an update leaves
//     the column untouched, so a time-blind writer (Telegram, the palette, an old
//     queued intent) can never destroy a stated time.
//   • `null` — an explicit clear: the form's emptied Time field on a submission
//     that writes a value (decision 5).
//   • a string — the stated instant, accepted through THE acceptance gate
//     (`judgeStatedAt`, #2236): not meaningfully future, and its profile-local
//     date IS the row's `date`. A statement that fails the gate is REFUSED — the
//     reading still lands, the statement is dropped (`undefined`), and the row is
//     never re-dated and never has an honest stored time clobbered by garbage.
//     The WhenControl pair rule makes the UI unable to produce a mismatch; this
//     enforces it anyway at the auth-blind boundary (constraint 3).
//
// AND THE ANSWER CARRIES THE REFUSAL (#2311, completing #2296's ruling). This used to
// return `string | null | undefined`, which is the SAME collapse the gate itself was
// fixed for one level up: `undefined` meant both "the caller said nothing about time"
// and "the caller stated one and we threw it away", so a phone whose clock ran six
// minutes fast kept its weigh-in and silently lost the "when" — arguably worse than for
// food, because a body reading is often logged precisely BECAUSE when it was taken
// matters (before breakfast, after a run). The tolerance is unchanged at five minutes;
// what changed is that the answer can no longer hide the refusal from its caller.
//
// `value` is the three-way binding above, unchanged. `refused` is set ONLY when a
// statement existed and the gate discarded it — never on an absence, never on an
// explicit clear. A caller that ignores it is choosing silence EXPLICITLY, which is
// exactly the property the old shape denied everyone.
//
// The accepted instant is re-serialized through `utcInstant`, so the stored shape
// is the canonical `YYYY-MM-DDTHH:MM:SSZ` whatever the caller's ISO carried
// (constraint 4; the instant-writer scan holds the SQL side of the same rule).
export interface StatedOccurredAt {
  /**
   * What to bind: `undefined` = no statement (leave a stored one alone; NULL on a
   * fresh row), `null` = explicit clear, a string = the canonical stated instant.
   */
  value: string | null | undefined;
  /**
   * Why a statement that WAS made is not in `value`. Present only alongside
   * `value: undefined`, and only when the caller actually stated something.
   */
  refused?: StatedTimeRefusal;
}

export function resolveStatedOccurredAt(
  profileId: number,
  date: string,
  occurredAt: string | null | undefined
): StatedOccurredAt {
  if (occurredAt === undefined || occurredAt === null)
    return { value: occurredAt };
  const verdict = judgeStatedAt(
    new Date(occurredAt),
    getTimezone(profileId),
    date,
    now()
  );
  return verdict.kind === "accepted"
    ? { value: utcInstant(verdict.at) }
    : { value: undefined, refused: verdict.reason };
}

// Write the day row's stated instant. NO `edited` change here on purpose: in the
// find-then-write below the writer always owns the row it found (the find is keyed
// on the writer's own source), so this is a source updating its own row or the user
// updating theirs — not a cross-owner correction. A USER's stated time on a
// source-owned row has no path through this core today (a manual write never finds
// a source-owned row); when such a path lands it must stamp `edited` exactly as
// `bodyMetricUpdate` does for a value (constraint 1). The #133 lock already holds a
// source re-push — occurred_at included — out of an edited row: the refusal above
// fires before any column is written.
const bodyMetricSetOccurredAt = () =>
  db.prepare(
    `UPDATE body_metrics SET occurred_at = ? WHERE id = ? AND profile_id = ?`
  );

// Write ONE measure onto an existing day row, leaving the others alone — which is what
// makes "body fat and resting HR entered in one sitting" land on one row, and what stops
// a resting-HR write from blanking that day's weight.
//
// Deliberately NOT `ON CONFLICT(profile_id, date, source)`: the unique index treats two
// NULL sources as distinct, so a hand-entered row (source NULL) would never conflict and
// the upsert would quietly grow a second row per day. Find-then-write answers the same
// for both, which is the only version that is correct for the manual path.
function bodyMetricSet(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics SET weight_kg = ? WHERE id = ? AND profile_id = ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics SET body_fat_pct = ? WHERE id = ? AND profile_id = ?`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics SET resting_hr = ? WHERE id = ? AND profile_id = ?`
      );
  }
}

function bodyMetricFind(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `SELECT id, edited, weight_kg AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
    case "body_fat_pct":
      return db.prepare(
        `SELECT id, edited, body_fat_pct AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
    case "resting_hr":
      return db.prepare(
        `SELECT id, edited, resting_hr AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
  }
}

// ---- recordReading: the placement-deciding write --------------------------

/**
 * The type a reading's `value` must have for a given canonical `unit` (#2149).
 *
 * A reading is unit-bearing but polymorphic — one core writes kilograms, mmHg, mg/dL
 * and L/min — so the value cannot be branded outright. It is branded WHERE THE UNIT
 * SAYS SO: a reading that states `unit: "kg"` must carry a `Kg`, one that states
 * `unit: "km"` must carry a `Km`, and every other unit passes a plain number through
 * unchanged. A caller whose unit is only known as `string` at compile time (the vitals
 * vocabulary, a fitness battery definition) resolves to `number`, exactly as before —
 * as does a mixed batch, whose union of units distributes to `Kg | number`. The brand
 * bites where the unit is STATED, which is where a hand-written write lives; it does
 * not pretend to type a unit the caller only learns at runtime.
 */
export type CanonicalReadingValue<U extends string> = U extends "kg"
  ? Kg
  : U extends "km"
    ? Km
    : number;

/**
 * One dated reading offered to the write core, keyed by IDENTITY rather than store.
 *
 * Generic in its unit so the canonical-unit brands can reach the `value` — see
 * `CanonicalReadingValue`. The parameter defaults to `string`, so an existing
 * `ReadingWriteInput` annotation keeps meaning exactly what it did.
 */
export interface ReadingWriteInput<U extends string = string> {
  /** The canonical name of the quantity — what the placement policy decides on. */
  name: string;
  /**
   * In the identity's canonical unit; the boundary converted already. Branded when
   * that canonical unit is kilograms or kilometres (`CanonicalReadingValue`), so a
   * display-unit number cannot be handed to the write core as one.
   */
  value: CanonicalReadingValue<U>;
  unit: U;
  /** The profile-local day. */
  date: string;
  /**
   * The absolute instant for `metric_samples`, on that store's OWN convention
   * (profile-local bare shape, part of its natural key — see the allowlisted
   * day-midnight anchor below). NOT the stated body_metrics instant; that is
   * `occurredAt`, which is a canonical-UTC statement and never an identity.
   */
  measuredAt?: string | null;
  /**
   * The STATED event instant for the destination's `occurred_at` column —
   * `body_metrics` (#2235) and `medical_records` (#2154) — any ISO shape,
   * normalized to the canonical `utcInstant` form after the acceptance gate.
   * `undefined` = no statement (leave an existing value alone; NULL on a fresh
   * row), `null` = explicit clear. Descriptive only: never part of a dedupe key,
   * and it does not move a reading's `date`. See `resolveStatedOccurredAt`.
   */
  occurredAt?: string | null;
  /** The row's `source` stamp: an integration id, 'manual', `document:<id>`, or null. */
  source?: string | null;
  notes?: string | null;
  /** The clinical classification an observation row carries. Ignored by the streams. */
  category?: MedicalCategory;
  /** Clinical provenance. Its PRESENCE forces the observation store (clause 2). */
  provenance?: ReadingProvenance;
}

export type ReadingRecordOutcome =
  | {
      ok: true;
      store: ReadingTarget["store"];
      rowId: number;
      disposition: UpsertDisposition;
    }
  | {
      ok: false;
      error: "unplaceable" | "invalid" | "edit-locked" | "document-import";
    };

function hasProvenance(p: ReadingProvenance | undefined): boolean {
  return !!p && Object.keys(p).length > 0;
}

/**
 * Record one reading. The CORE decides which physical store it lands in; the caller
 * says what quantity it is.
 *
 * The edit lock (#133) holds out a SOURCE-OWNED re-push only. A write stamped with an
 * integration id (or a `document:<id>` import stamp) that lands on a row the user has
 * hand-corrected is refused with `edit-locked` — that is the whole point of the lock.
 * A `manual` write is the USER, and a user may always correct their own row; refusing
 * there would mean a person could not re-enter a value they had previously fixed.
 *
 * A DOCUMENT-linked reading is refused with `document-import`: those rows belong to the
 * import footprint and must be written by `persistDocumentImport`, so that clear,
 * reassign and the extracted counts can still see them. Clause 2 of the placement policy
 * is unaffected — a document still forces the observation store, the core simply is not
 * the thing that writes it.
 *
 * Dispositions are classified by `classifyUpsert` so the accounting a sync reports is
 * the accounting this core produces. An OBSERVATION is always `inserted`: a
 * `medical_records` row is a dated clinical EVENT, and a second same-day temperature is
 * a fever curve (#800/#843), not a correction of the first.
 */
export function recordReading<U extends string>(
  profileId: number,
  input: ReadingWriteInput<U>
): ReadingRecordOutcome {
  if (!Number.isFinite(input.value)) return { ok: false, error: "invalid" };
  if (!input.date.trim()) return { ok: false, error: "invalid" };
  const decision = placeReading({
    name: input.name,
    provenance: hasProvenance(input.provenance),
  });
  if (decision.refused) return { ok: false, error: "unplaceable" };
  const placement = decision.placed;
  const sourceKey = input.source ?? null;
  // Whether this write is the SOURCE re-pushing rather than the user typing — the one
  // question the #133 lock is about.
  const kind = readingSourceFor({ sourceKey });
  const sourceOwned = kind === "wearable" || kind === "import";

  return writeTx(() => {
    switch (placement.table) {
      case "body_metrics": {
        // The stated instant this write carries for the day row (#2235). Resolved
        // BEFORE the find so a refused statement costs the statement, never the
        // reading — and the find-then-write itself is untouched: occurred_at is
        // descriptive, so it plays no part in which row a write lands on.
        //
        // KNOWN GAP, stated rather than implied (#2311's audit). This core still
        // COLLAPSES `.refused` — `ReadingRecordOutcome` has nowhere to carry it, and
        // widening it reaches every reading writer (imports, the fitness battery, the
        // vitals sitting) rather than the manual body-metrics submission #2311 was
        // reproduced on. The refusal is now visible right here rather than erased by
        // the resolver's shape, which is what makes the follow-up a small change.
        const stated = resolveStatedOccurredAt(
          profileId,
          input.date,
          input.occurredAt
        ).value;
        const found = bodyMetricFind(placement.column).get(
          profileId,
          input.date,
          sourceKey
        ) as
          | { id: number; edited: number | null; value: number | null }
          | undefined;
        if (found && sourceOwned && isEditLocked(found.edited)) {
          // The #133 lock holds the WHOLE re-push out — a locked row's stated
          // time survives exactly as its value does (constraint 1).
          return { ok: false, error: "edit-locked" } as const;
        }
        const disposition = classifyUpsert(
          !!found && found.value != null,
          found?.value === input.value
        );
        if (found) {
          if (disposition !== "unchanged") {
            bodyMetricSet(placement.column).run(
              input.value,
              found.id,
              profileId
            );
          }
          // Independent of the value disposition: re-stating the same value with
          // a (new or cleared) time is still a statement about the row.
          if (stated !== undefined) {
            bodyMetricSetOccurredAt().run(stated, found.id, profileId);
          }
          return {
            ok: true,
            store: "body_metrics",
            rowId: found.id,
            disposition,
          } as const;
        }
        const info = bodyMetricInsert(placement.column).run(
          input.date,
          input.value,
          sourceKey,
          stated ?? null,
          profileId
        );
        return {
          ok: true,
          store: "body_metrics",
          rowId: Number(info.lastInsertRowid),
          disposition,
        } as const;
      }
      case "metric_samples": {
        // The natural key the tall store dedups on: (profile_id, metric, source,
        // origin, start_time). A reading with no stated instant is filed at the day's
        // midnight, so a re-entry corrects rather than duplicates.
        const ts = input.measuredAt ?? `${input.date}T00:00:00`;
        // `metric_samples.source` is NOT NULL, so an unstamped write is the user's own:
        // 'manual', the same stamp every hand-entered sample already carries.
        const sampleSource = sourceKey ?? "manual";
        const found = db
          .prepare(
            `SELECT id, edited, value FROM metric_samples
              WHERE profile_id = ? AND metric = ? AND source IS ? AND start_time = ?
              ORDER BY id LIMIT 1`
          )
          .get(profileId, placement.metric, sampleSource, ts) as
          { id: number; edited: number | null; value: number } | undefined;
        if (found && sourceOwned && isEditLocked(found.edited)) {
          return { ok: false, error: "edit-locked" } as const;
        }
        const disposition = classifyUpsert(
          !!found,
          found?.value === input.value
        );
        if (found) {
          db.prepare(
            `UPDATE metric_samples SET value = ?, date = ?
              WHERE id = ? AND profile_id = ?`
          ).run(input.value, input.date, found.id, profileId);
          return {
            ok: true,
            store: "metric_samples",
            rowId: found.id,
            disposition,
          } as const;
        }
        const info = db
          .prepare(
            `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            profileId,
            sampleSource,
            placement.metric,
            input.date,
            ts,
            ts,
            input.value
          );
        return {
          ok: true,
          store: "metric_samples",
          rowId: Number(info.lastInsertRowid),
          disposition,
        } as const;
      }
      case "medical_records": {
        const p = input.provenance;
        // A DOCUMENT-derived row is the import pipeline's, not this core's. Binding a
        // `document_id` here would create a row that clear / reassign / extracted-count
        // cannot see — the import-footprint contract (#453/#422), which
        // `persistDocumentImport` is the single entry point for. So the core REFUSES
        // rather than writing a row with the link quietly dropped: a placement policy
        // may decide which store a reading belongs in, it may not decide to lose its
        // document.
        if (p?.documentId != null) {
          return { ok: false, error: "document-import" } as const;
        }
        // The name the SOURCE printed, when it differs from the canonical — the row's
        // `name` column has always carried that, with the canonical beside it.
        const reported = p?.reportedName?.trim();
        // The stated instant (#2154), through the SAME acceptance gate the
        // body_metrics branch runs: a refused statement costs the statement,
        // never the reading. An observation is always a fresh INSERT, so
        // "no statement" and "explicit clear" both land as honest NULL.
        // `.refused` is collapsed here for the same reason as the body_metrics
        // branch above — see that comment; it is #2311's named audit survivor.
        const stated = resolveStatedOccurredAt(
          profileId,
          input.date,
          input.occurredAt
        ).value;
        const info = db
          .prepare(
            `INSERT INTO medical_records
               (profile_id, date, occurred_at, category, name, value, value_num, unit, canonical_name,
                source, external_id, notes, reference_range, encounter_id, provider_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
          )
          .run(
            profileId,
            input.date,
            // Bound, never defaulted (#2205): the stated instant or honest NULL.
            stated ?? null,
            input.category ?? "lab",
            reported || placement.canonical,
            String(input.value),
            input.value,
            input.unit,
            placement.canonical,
            sourceKey,
            input.notes ?? null,
            p?.reportedRange ?? null,
            p?.encounterId ?? null,
            p?.providerId ?? null
          );
        const rowId = Number(info.lastInsertRowid);
        addCanonicalNames([placement.canonical]);
        // A flag is a FUNCTION of the value against the canonical range (#221), so it is
        // derived through the same reconcile every other observation writer calls —
        // never a second flag engine here.
        reconcileFlags(profileId, [rowId]);
        return {
          ok: true,
          store: "medical_records",
          rowId,
          disposition: "inserted",
        } as const;
      }
    }
  });
}

/**
 * Record several readings and report the shared upsert accounting. The counts are bumped
 * ONLY through `tallyUpsert`, so a caller's inserted/updated/unchanged split is the same
 * split every sync reports.
 */
export function recordReadings<U extends string>(
  profileId: number,
  inputs: readonly ReadingWriteInput<U>[],
  counts: UpsertCounts
): ReadingRecordOutcome[] {
  const out: ReadingRecordOutcome[] = [];
  for (const input of inputs) {
    const outcome = recordReading(profileId, input);
    out.push(outcome);
    if (outcome.ok) tallyUpsert(counts, outcome.disposition);
    else if (outcome.error === "edit-locked") counts.edited++;
  }
  return out;
}

// ---- The editability contract ---------------------------------------------

export type ReadingWriteOutcome =
  { ok: true } | { ok: false; error: "not-found" | "derived" | "invalid" };

export interface ReadingDeleteOutcome {
  ok: boolean;
  /** Present when the delete went through the undo holding store. */
  undoId: number | null;
}

/**
 * Correct one reading's value, in STORED units, by the row it IS.
 *
 * The generalization phase 2 exists for: the caller hands over a `ReadingTarget` taken
 * from the row, so a clinical observation folded onto a stream metric's page is
 * corrected in place instead of being marked read-only because the page's slug names a
 * different table.
 *
 * `medical_records` scopes by #482 IDENTITY through the `biomarker_family()` SQL
 * function rather than by an exact canonical string, so an aliased spelling of the same
 * analyte is the same target — "which identity am I", not "which table am I".
 */
export function updateReadingAt(
  profileId: number,
  target: ReadingTarget,
  value: number
): ReadingWriteOutcome {
  if (!Number.isFinite(value)) return { ok: false, error: "invalid" };
  return writeTx(() => {
    switch (target.store) {
      case "body_metrics": {
        const info = bodyMetricUpdate(target.column).run(
          value,
          target.id,
          profileId
        );
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "metric_samples": {
        const info = db
          .prepare(
            `UPDATE metric_samples SET value = ?, edited = 1
              WHERE id = ? AND profile_id = ? AND metric = ?`
          )
          .run(value, target.id, profileId, target.metric);
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "medical_records": {
        const info = db
          .prepare(
            `UPDATE medical_records
                SET value = ?, value_num = ?,
                    -- Same #133 lock the record editor applies: an imported reading
                    -- corrected here must survive the next rolling window.
                    edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
              WHERE id = ? AND profile_id = ?
                AND biomarker_family(canonical_name) = biomarker_family(?) COLLATE NOCASE`
          )
          .run(String(value), value, target.id, profileId, target.identity);
        if (info.changes === 0)
          return { ok: false, error: "not-found" } as const;
        // A reading's out-of-range flag is a FUNCTION of its value, so a corrected value
        // re-derives it through the SAME reconcileFlags the record editor calls (#221) —
        // otherwise an edited-down blood pressure keeps its old "high".
        reconcileFlags(profileId, [target.id]);
        return { ok: true } as const;
      }
    }
  });
}

/**
 * Delete one reading by the row it IS. EVERY store goes through `captureDelete` (#2123),
 * which writes the re-import tombstone and makes the delete restorable from the toast:
 * one control on one row may not offer Undo for a weigh-in and permanent loss for an
 * HRV sample. `body_metrics` is the one branch that can answer with no token, and not
 * because of the store — a row there carries up to three measures, so removing one of
 * several NULLs a column rather than deleting a row, and a column clear is not a capture.
 */
export function deleteReadingAt(
  profileId: number,
  target: ReadingTarget
): ReadingDeleteOutcome {
  switch (target.store) {
    case "body_metrics": {
      // A body_metrics ROW carries up to three measures; deleting the row for a body-fat
      // correction would take that day's weight with it. Null the ONE column instead,
      // and only drop the row when nothing is left on it.
      return writeTx(() => {
        const row = db
          .prepare(
            `SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics
              WHERE id = ? AND profile_id = ?`
          )
          .get(target.id, profileId) as
          | {
              weight_kg: number | null;
              body_fat_pct: number | null;
              resting_hr: number | null;
            }
          | undefined;
        if (!row) return { ok: false, undoId: null };
        const others = (
          ["weight_kg", "body_fat_pct", "resting_hr"] as const
        ).filter((c) => c !== target.column && row[c] != null);
        if (others.length === 0) {
          // The row exists only for this measure — capture it whole so the toast's undo
          // restores it (and its tombstone is written/removed with it).
          const undoId = captureDelete("body-metric", profileId, target.id);
          return { ok: undoId != null, undoId };
        }
        const info = bodyMetricClear(target.column).run(target.id, profileId);
        return { ok: info.changes > 0, undoId: null };
      });
    }
    case "medical_records": {
      const undoId = captureDelete("biomarker-record", profileId, target.id);
      return { ok: undoId != null, undoId };
    }
    case "metric_samples": {
      // The row has to be this METRIC's before it is captured: captureDelete scopes by
      // (id, profile_id) and knows nothing about the metric a target names, so without
      // this probe a target carrying a valid id under the wrong metric would delete the
      // row anyway — the guard the bare DELETE used to get from its own WHERE clause.
      const owned = db
        .prepare(
          `SELECT 1 FROM metric_samples
            WHERE id = ? AND profile_id = ? AND metric = ?`
        )
        .get(target.id, profileId, target.metric);
      if (!owned) return { ok: false, undoId: null };
      // captureDelete owns the tombstone write (metric_samples IS a TOMBSTONE_TABLES
      // member), so the #508/#653 re-import protection this branch used to write by hand
      // is preserved rather than duplicated — and unlike the hand-written one it is
      // REMOVED again when the restore puts the row back.
      const undoId = captureDelete("metric-sample", profileId, target.id);
      return { ok: undoId != null, undoId };
    }
  }
}
